using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace CadenceHelper
{
    public static class TextInjector
    {
        [StructLayout(LayoutKind.Explicit, Size = 40)]
        private struct INPUT
        {
            [FieldOffset(0)] public uint type;
            [FieldOffset(8)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_SCANCODE = 0x0008;
        private const ushort VK_CONTROL = 0x11;
        private const ushort VK_C = 0x43;
        private const ushort VK_V = 0x56;
        private const uint MAPVK_VK_TO_VSC = 0;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        private static extern IntPtr SetFocus(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        public static string GetSelectedText(IntPtr targetHwnd, IntPtr targetFocusHwnd)
        {
            string selectedText = "";
            var thread = new Thread(() =>
            {
                try
                {
                    ReleaseModifiers();
                    Thread.Sleep(30);

                    try { System.Windows.Forms.Clipboard.Clear(); } catch {}
                    Thread.Sleep(30);

                    uint currentTid = GetCurrentThreadId();
                    uint targetTid = 0;
                    uint dummyProcId;
                    bool attached = false;

                    if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                    {
                        targetTid = GetWindowThreadProcessId(targetHwnd, out dummyProcId);
                        if (targetTid != 0 && targetTid != currentTid)
                        {
                            attached = AttachThreadInput(currentTid, targetTid, true);
                        }
                    }

                    try
                    {
                        if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                        {
                            BringWindowToTop(targetHwnd);
                            SetForegroundWindow(targetHwnd);
                            Thread.Sleep(40);
                        }

                        if (targetFocusHwnd != IntPtr.Zero && IsWindow(targetFocusHwnd) && targetFocusHwnd != targetHwnd)
                        {
                            SetFocus(targetFocusHwnd);
                            Thread.Sleep(30);
                        }

                        int cbSize = Marshal.SizeOf(typeof(INPUT));

                        var ctrlDown = new[] { MakeVkInput(VK_CONTROL, false) };
                        SendInput(1, ctrlDown, cbSize);
                        Thread.Sleep(35);

                        var cEvents = new[]
                        {
                            MakeVkInput(VK_C, false),
                            MakeVkInput(VK_C, true)
                        };
                        SendInput(2, cEvents, cbSize);
                        Thread.Sleep(35);

                        var ctrlUp = new[] { MakeVkInput(VK_CONTROL, true) };
                        SendInput(1, ctrlUp, cbSize);
                        Thread.Sleep(60);

                        if (System.Windows.Forms.Clipboard.ContainsText())
                        {
                            selectedText = System.Windows.Forms.Clipboard.GetText();
                            Console.Error.WriteLine("[TextInjector] GetSelectedText captured " + selectedText.Length + " chars");
                        }
                    }
                    finally
                    {
                        if (attached)
                        {
                            AttachThreadInput(currentTid, targetTid, false);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("[TextInjector] GetSelectedText Exception: " + ex.Message);
                }
            });

            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join(1500);

            return selectedText;
        }

        public static void InjectIntoWindow(string text, IntPtr targetHwnd, IntPtr targetFocusHwnd)
        {
            ReleaseModifiers();
            Thread.Sleep(50);

            var thread = new Thread(() =>
            {
                try
                {
                    bool clipboardSet = false;
                    for (int i = 0; i < 5; i++)
                    {
                        try
                        {
                            System.Windows.Forms.Clipboard.SetText(text);
                            clipboardSet = true;
                            Console.Error.WriteLine("[TextInjector] Clipboard set (" + text.Length + " chars) on attempt " + (i + 1));
                            break;
                        }
                        catch (Exception ex)
                        {
                            Console.Error.WriteLine("[TextInjector] Clipboard attempt " + (i + 1) + " failed: " + ex.Message);
                            Thread.Sleep(40);
                        }
                    }

                    if (!clipboardSet)
                    {
                        Console.Error.WriteLine("[TextInjector] ERROR: Could not set clipboard");
                        return;
                    }

                    Thread.Sleep(60);

                    uint currentTid = GetCurrentThreadId();
                    uint targetTid = 0;
                    uint dummyProcId;
                    bool attached = false;

                    if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                    {
                        targetTid = GetWindowThreadProcessId(targetHwnd, out dummyProcId);
                        if (targetTid != 0 && targetTid != currentTid)
                        {
                            attached = AttachThreadInput(currentTid, targetTid, true);
                            Console.Error.WriteLine("[TextInjector] AttachThreadInput(" + currentTid + " -> " + targetTid + ") = " + attached);
                        }
                    }

                    try
                    {
                        if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                        {
                            BringWindowToTop(targetHwnd);
                            bool fgSet = SetForegroundWindow(targetHwnd);
                            Thread.Sleep(80);
                            Console.Error.WriteLine("[TextInjector] SetForegroundWindow(0x" + targetHwnd.ToString("X") + ") = " + fgSet + ", actual fg = 0x" + GetForegroundWindow().ToString("X"));
                        }

                        if (targetFocusHwnd != IntPtr.Zero && IsWindow(targetFocusHwnd) && targetFocusHwnd != targetHwnd)
                        {
                            SetFocus(targetFocusHwnd);
                            Thread.Sleep(50);
                        }

                        int cbSize = Marshal.SizeOf(typeof(INPUT));

                        var ctrlDown = new[] { MakeVkInput(VK_CONTROL, false) };
                        uint s1 = SendInput(1, ctrlDown, cbSize);
                        Thread.Sleep(35);

                        var vEvents = new[]
                        {
                            MakeVkInput(VK_V, false),
                            MakeVkInput(VK_V, true)
                        };
                        uint s2 = SendInput(2, vEvents, cbSize);
                        Thread.Sleep(35);

                        var ctrlUp = new[] { MakeVkInput(VK_CONTROL, true) };
                        uint s3 = SendInput(1, ctrlUp, cbSize);

                        int err = Marshal.GetLastWin32Error();
                        Console.Error.WriteLine("[TextInjector] SendInput Ctrl+V sequence: CtrlDown=" + s1 + ", V=" + s2 + ", CtrlUp=" + s3 + " (LastError=" + err + ")");

                        if (s1 == 1 && s2 == 2 && s3 == 1)
                        {
                            string preview = text.Length > 60 ? text.Substring(0, 60) + "..." : text;
                            Console.Error.WriteLine("[TextInjector] SUCCESS: Pasted into 0x" + targetHwnd.ToString("X") + " — \"" + preview + "\"");
                        }
                        else
                        {
                            Console.Error.WriteLine("[TextInjector] FAILED: SendInput error code " + err);
                        }
                    }
                    finally
                    {
                        if (attached)
                        {
                            AttachThreadInput(currentTid, targetTid, false);
                            Console.Error.WriteLine("[TextInjector] AttachThreadInput detached");
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("[TextInjector] Exception: " + ex);
                }
            });

            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join(5000);
        }

        public static void ReleaseModifiers()
        {
            var mods = new ushort[] { 0x11, 0xA2, 0xA3, 0x10, 0xA0, 0xA1, 0x12, 0xA4, 0xA5 };
            var inputs = new INPUT[mods.Length];
            for (int i = 0; i < mods.Length; i++)
                inputs[i] = MakeVkInput(mods[i], keyUp: true);
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        private static INPUT MakeVkInput(ushort vk, bool keyUp)
        {
            ushort scanCode = (ushort)MapVirtualKey(vk, MAPVK_VK_TO_VSC);
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                ki = new KEYBDINPUT
                {
                    wVk = vk,
                    wScan = scanCode,
                    dwFlags = keyUp ? KEYEVENTF_KEYUP : 0,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            };
        }
    }
}
