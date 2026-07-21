using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace CadenceHelper;

/// <summary>
/// Cadence Native Helper — minimal Windows helper process.
/// Responsibilities:
///   1. Global low-level keyboard hook (WH_KEYBOARD_LL) with keydown/keyup
///   2. Text injection via SetForegroundWindow + clipboard Ctrl+V
///   3. GetForegroundWindow app detection (with HWND capture)
///   4. Named pipe IPC with Electron main process
/// </summary>
class Program
{
    private static KeyboardHook? _keyboardHook;
    private static readonly CancellationTokenSource _cts = new();
    private static NamedPipeServerStream? _pipeServer;
    private static StreamWriter? _pipeWriter;
    private static readonly object _writeLock = new();

    // Top-level window HWND captured at get_foreground time (e.g. VS Code BrowserWindow)
    private static IntPtr _targetHwnd = IntPtr.Zero;
    // Exact focused child HWND captured at get_foreground time (e.g. Chrome_RenderWidgetHostHWND inside VS Code).
    // This is the control that had the text cursor — ensures paste goes to the right editor pane.
    private static IntPtr _targetFocusHwnd = IntPtr.Zero;

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern IntPtr GetFocus();

    static async Task Main(string[] args)
    {
        Console.Error.WriteLine("[CadenceHelper] Starting...");

        // Start keyboard hook on a dedicated STA thread with message pump
        var hookThread = new Thread(() =>
        {
            _keyboardHook = new KeyboardHook();
            _keyboardHook.KeyEvent += OnKeyEvent;
            _keyboardHook.Start();
        });
        hookThread.SetApartmentState(ApartmentState.STA);
        hookThread.IsBackground = true;
        hookThread.Start();

        // Run pipe server
        await RunPipeServerAsync(_cts.Token);
    }

    private static void OnKeyEvent(object? sender, KeyEventArgs e)
    {
        // Explicit raw logging for modifier / activation key events
        if (e.KeyName.Contains("CTRL") || e.KeyName.Contains("SHIFT") || e.KeyName == "RIGHT CTRL")
        {
            Console.Error.WriteLine($"[HOOK RAW KEY] {e.KeyName} | State: {(e.IsDown ? "DOWN" : "UP")} | VkCode: 0x{e.VkCode:X2}");
        }

        var msg = new
        {
            type = "key",
            key = e.KeyName,
            vkCode = e.VkCode,
            state = e.IsDown ? "down" : "up",
            shift = e.ShiftPressed,
            ctrl = e.CtrlPressed,
            alt = e.AltPressed,
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };

        SendMessage(msg);
    }

    private static void SendMessage(object msg)
    {
        lock (_writeLock)
        {
            if (_pipeWriter != null)
            {
                try
                {
                    var json = JsonSerializer.Serialize(msg);
                    Console.Error.WriteLine($"[CadenceHelper] [HELPER IPC TX] {json}");
                    _pipeWriter.WriteLine(json);
                    _pipeWriter.Flush();
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[CadenceHelper] [HELPER IPC ERROR] Pipe write error: {ex.Message}");
                }
            }
        }
    }

    private static async Task RunPipeServerAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _pipeServer = new NamedPipeServerStream(
                    "cadence-helper",
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                Console.Error.WriteLine("[CadenceHelper] Waiting for Electron connection on pipe 'cadence-helper'...");
                await _pipeServer.WaitForConnectionAsync(ct);
                Console.Error.WriteLine("[CadenceHelper] [HELPER PIPE CONNECT] Electron connected to pipe.");

                using (var reader = new StreamReader(_pipeServer, Encoding.UTF8, leaveOpen: true))
                {
                    lock (_writeLock)
                    {
                        _pipeWriter = new StreamWriter(_pipeServer, Encoding.UTF8) { AutoFlush = true };
                    }

                    // Send ready message
                    SendMessage(new { type = "ready", version = "0.1.0" });

                    // Read commands from Electron
                    while (_pipeServer.IsConnected && !ct.IsCancellationRequested)
                    {
                        var line = await reader.ReadLineAsync(ct);
                        if (line == null) break;

                        Console.Error.WriteLine($"[CadenceHelper] [HELPER IPC RX] {line}");
                        await HandleCommandAsync(line);
                    }
                }

                Console.Error.WriteLine("[CadenceHelper] [HELPER PIPE DISCONNECT] Electron disconnected from pipe.");
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[CadenceHelper] [HELPER PIPE ERROR] Pipe error: {ex.Message}");
                await Task.Delay(500, ct);
            }
            finally
            {
                lock (_writeLock)
                {
                    _pipeWriter?.Dispose();
                    _pipeWriter = null;
                }

                if (_pipeServer != null)
                {
                    if (_pipeServer.IsConnected)
                    {
                        try { _pipeServer.Disconnect(); } catch { }
                    }
                    _pipeServer.Dispose();
                    _pipeServer = null;
                }
            }
        }
    }

    private static async Task HandleCommandAsync(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var type = root.GetProperty("type").GetString();

            switch (type)
            {
                case "ping":
                    SendMessage(new { type = "pong" });
                    break;

                case "get_foreground":
                    // Capture the foreground app AND its HWND for later focus restoration
                    var fgInfo = ForegroundDetector.GetForegroundApp();
                    _targetHwnd = fgInfo.Hwnd;

                    // ALSO capture the focused child control HWND within the foreground app.
                    // This is e.g. Chrome_RenderWidgetHostHWND inside VS Code, or the Edit
                    // control inside Notepad — the exact place where the user's cursor is.
                    // Without this, SetForegroundWindow only focuses the top-level window,
                    // and Ctrl+V may land in the wrong pane (terminal vs editor, etc.).
                    _targetFocusHwnd = IntPtr.Zero;
                    if (fgInfo.Hwnd != IntPtr.Zero)
                    {
                        uint fgTid = GetWindowThreadProcessId(fgInfo.Hwnd, out _);
                        uint myTid = GetCurrentThreadId();
                        bool attached = false;
                        if (fgTid != 0 && fgTid != myTid)
                        {
                            attached = AttachThreadInput(myTid, fgTid, true);
                        }
                        if (attached)
                        {
                            _targetFocusHwnd = GetFocus();
                            AttachThreadInput(myTid, fgTid, false);
                        }
                    }

                    Console.Error.WriteLine($"[CadenceHelper] [FOREGROUND CAPTURED] Process={fgInfo.ProcessName}, TopHWND=0x{fgInfo.Hwnd:X}, FocusHWND=0x{_targetFocusHwnd:X}, Title=\"{fgInfo.WindowTitle}\"");

                    SendMessage(new
                    {
                        type = "foreground",
                        processName = fgInfo.ProcessName,
                        windowTitle = fgInfo.WindowTitle
                    });
                    break;

                case "inject":
                    var text = root.GetProperty("text").GetString() ?? "";

                    Console.Error.WriteLine($"[CadenceHelper] [INJECT] Injecting {text.Length} chars | TopHWND=0x{_targetHwnd:X} | FocusHWND=0x{_targetFocusHwnd:X}");

                    // Pass both the top-level window AND the exact focused child control.
                    // TextInjector will restore focus to the exact control before Ctrl+V.
                    TextInjector.InjectIntoWindow(text, _targetHwnd, _targetFocusHwnd);

                    SendMessage(new { type = "inject_done", length = text.Length });
                    break;

                default:
                    SendMessage(new { type = "error", message = $"Unknown command: {type}" });
                    break;
            }
        }
        catch (Exception ex)
        {
            SendMessage(new { type = "error", message = ex.Message });
        }
    }
}
