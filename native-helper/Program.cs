using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace CadenceHelper;

/// <summary>
/// Cadence Native Helper — minimal Windows helper process.
/// Responsibilities:
///   1. Global low-level keyboard hook (WH_KEYBOARD_LL) with keydown/keyup
///   2. SendInput text injection
///   3. GetForegroundWindow app detection
///   4. Named pipe IPC with Electron main process
/// </summary>
class Program
{
    private static KeyboardHook? _keyboardHook;
    private static readonly CancellationTokenSource _cts = new();
    private static NamedPipeServerStream? _pipeServer;
    private static StreamWriter? _pipeWriter;
    private static readonly object _writeLock = new();

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
                    _pipeWriter.WriteLine(json);
                    _pipeWriter.Flush();
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[CadenceHelper] Pipe write error: {ex.Message}");
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
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                Console.Error.WriteLine("[CadenceHelper] Waiting for Electron connection on pipe 'cadence-helper'...");
                await _pipeServer.WaitForConnectionAsync(ct);
                Console.Error.WriteLine("[CadenceHelper] Electron connected.");

                var reader = new StreamReader(_pipeServer, Encoding.UTF8);
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

                    await HandleCommandAsync(line);
                }

                Console.Error.WriteLine("[CadenceHelper] Electron disconnected.");
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[CadenceHelper] Pipe error: {ex.Message}");
                await Task.Delay(1000, ct);
            }
            finally
            {
                lock (_writeLock) { _pipeWriter = null; }
                _pipeServer?.Dispose();
                _pipeServer = null;
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

                case "inject":
                    var text = root.GetProperty("text").GetString() ?? "";
                    var useClipboard = root.TryGetProperty("useClipboard", out var cb) && cb.GetBoolean();
                    if (useClipboard || text.Length > 100)
                    {
                        TextInjector.InjectViaClipboard(text);
                    }
                    else
                    {
                        TextInjector.InjectViaKeyboard(text);
                    }
                    SendMessage(new { type = "inject_done", length = text.Length });
                    break;

                case "get_foreground":
                    var fgInfo = ForegroundDetector.GetForegroundApp();
                    SendMessage(new
                    {
                        type = "foreground",
                        processName = fgInfo.ProcessName,
                        windowTitle = fgInfo.WindowTitle
                    });
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
