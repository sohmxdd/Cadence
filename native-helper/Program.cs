using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CadenceHelper
{
    class Program
    {
        private static KeyboardHook _keyboardHook;
        private static readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private static NamedPipeServerStream _pipeServer;
        private static StreamWriter _pipeWriter;
        private static readonly object _writeLock = new object();

        private static IntPtr _targetHwnd = IntPtr.Zero;
        private static IntPtr _targetFocusHwnd = IntPtr.Zero;

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        private static extern IntPtr GetFocus();

        static void Main(string[] args)
        {
            Console.Error.WriteLine("[CadenceHelper] Starting...");

            var hookThread = new Thread(() =>
            {
                _keyboardHook = new KeyboardHook();
                _keyboardHook.KeyEvent += OnKeyEvent;
                _keyboardHook.Start();
            });
            hookThread.SetApartmentState(ApartmentState.STA);
            hookThread.IsBackground = true;
            hookThread.Start();

            RunPipeServerAsync(_cts.Token).Wait();
        }

        private static void OnKeyEvent(object sender, KeyEventArgs e)
        {
            if (e.KeyName.Contains("CTRL") || e.KeyName.Contains("SHIFT") || e.KeyName == "RIGHT CTRL")
            {
                Console.Error.WriteLine("[HOOK RAW KEY] " + e.KeyName + " | State: " + (e.IsDown ? "DOWN" : "UP") + " | VkCode: 0x" + e.VkCode.ToString("X2"));
            }

            string json = string.Format(
                "{{\"type\":\"key\",\"key\":\"{0}\",\"vkCode\":{1},\"state\":\"{2}\",\"shift\":{3},\"ctrl\":{4},\"alt\":{5},\"timestamp\":{6}}}",
                e.KeyName,
                e.VkCode,
                e.IsDown ? "down" : "up",
                e.ShiftPressed ? "true" : "false",
                e.CtrlPressed ? "true" : "false",
                e.AltPressed ? "true" : "false",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );

            SendMessageJson(json);
        }

        private static void SendMessageJson(string json)
        {
            lock (_writeLock)
            {
                if (_pipeWriter != null)
                {
                    try
                    {
                        Console.Error.WriteLine("[CadenceHelper] [HELPER IPC TX] " + json);
                        _pipeWriter.WriteLine(json);
                        _pipeWriter.Flush();
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine("[CadenceHelper] [HELPER IPC ERROR] Pipe write error: " + ex.Message);
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

                    using (var reader = new StreamReader(_pipeServer, Encoding.UTF8, true))
                    {
                        lock (_writeLock)
                        {
                            _pipeWriter = new StreamWriter(_pipeServer, Encoding.UTF8) { AutoFlush = true };
                        }

                        SendMessageJson("{\"type\":\"ready\",\"version\":\"0.1.0\"}");

                        while (_pipeServer.IsConnected && !ct.IsCancellationRequested)
                        {
                            var line = await reader.ReadLineAsync();
                            if (line == null) break;

                            Console.Error.WriteLine("[CadenceHelper] [HELPER IPC RX] " + line);
                            HandleCommand(line);
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
                    Console.Error.WriteLine("[CadenceHelper] [HELPER PIPE ERROR] Pipe error: " + ex.Message);
                    Thread.Sleep(500);
                }
                finally
                {
                    lock (_writeLock)
                    {
                        if (_pipeWriter != null)
                        {
                            try { _pipeWriter.Dispose(); } catch {}
                            _pipeWriter = null;
                        }
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

        private static void HandleCommand(string json)
        {
            try
            {
                if (json.Contains("\"type\":\"ping\""))
                {
                    SendMessageJson("{\"type\":\"pong\"}");
                    return;
                }

                if (json.Contains("\"type\":\"get_foreground\""))
                {
                    var fgInfo = ForegroundDetector.GetForegroundApp();
                    _targetHwnd = fgInfo.Hwnd;
                    _targetFocusHwnd = IntPtr.Zero;

                    if (fgInfo.Hwnd != IntPtr.Zero)
                    {
                        uint dummyProcId;
                        uint fgTid = GetWindowThreadProcessId(fgInfo.Hwnd, out dummyProcId);
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

                    Console.Error.WriteLine("[CadenceHelper] [FOREGROUND CAPTURED] Process=" + fgInfo.ProcessName + ", TopHWND=0x" + fgInfo.Hwnd.ToString("X") + ", FocusHWND=0x" + _targetFocusHwnd.ToString("X") + ", Title=\"" + fgInfo.WindowTitle + "\"");

                    string resp = string.Format(
                        "{{\"type\":\"foreground\",\"processName\":\"{0}\",\"windowTitle\":\"{1}\"}}",
                        EscapeJson(fgInfo.ProcessName),
                        EscapeJson(fgInfo.WindowTitle)
                    );
                    SendMessageJson(resp);
                    return;
                }

                if (json.Contains("\"type\":\"get_selection\""))
                {
                    var selText = TextInjector.GetSelectedText(_targetHwnd, _targetFocusHwnd);
                    string resp = string.Format(
                        "{{\"type\":\"selection\",\"text\":\"{0}\"}}",
                        EscapeJson(selText)
                    );
                    SendMessageJson(resp);
                    return;
                }

                if (json.Contains("\"type\":\"inject\""))
                {
                    string text = ExtractJsonStringField(json, "text");
                    Console.Error.WriteLine("[CadenceHelper] [INJECT] Injecting " + text.Length + " chars | TopHWND=0x" + _targetHwnd.ToString("X") + " | FocusHWND=0x" + _targetFocusHwnd.ToString("X"));

                    TextInjector.InjectIntoWindow(text, _targetHwnd, _targetFocusHwnd);

                    string resp = string.Format("{{\"type\":\"inject_done\",\"length\":{0}}}", text.Length);
                    SendMessageJson(resp);
                    return;
                }

                SendMessageJson("{\"type\":\"error\",\"message\":\"Unknown command\"}");
            }
            catch (Exception ex)
            {
                SendMessageJson("{\"type\":\"error\",\"message\":\"" + EscapeJson(ex.Message) + "\"}");
            }
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        private static string ExtractJsonStringField(string json, string field)
        {
            string key = "\"" + field + "\":\"";
            int idx = json.IndexOf(key);
            if (idx == -1) return "";
            int start = idx + key.Length;
            int end = start;
            while (end < json.Length)
            {
                if (json[end] == '"' && json[end - 1] != '\\') break;
                end++;
            }
            if (end >= json.Length) return "";
            string raw = json.Substring(start, end - start);
            return raw.Replace("\\n", "\n").Replace("\\r", "\r").Replace("\\\"", "\"").Replace("\\\\", "\\");
        }
    }
}
