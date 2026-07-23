using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CadenceHelper
{
    public class KeyEventArgs : EventArgs
    {
        public string KeyName { get; set; }
        public int VkCode { get; set; }
        public bool IsDown { get; set; }
        public bool ShiftPressed { get; set; }
        public bool CtrlPressed { get; set; }
        public bool AltPressed { get; set; }

        public KeyEventArgs()
        {
            KeyName = "";
        }
    }

    public class KeyboardHook
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;

        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12;
        private const int VK_LSHIFT = 0xA0;
        private const int VK_RSHIFT = 0xA1;
        private const int VK_LCONTROL = 0xA2;
        private const int VK_RCONTROL = 0xA3;

        private const int LLKHF_EXTENDED = 0x01;

        private IntPtr _hookId = IntPtr.Zero;
        private LowLevelKeyboardProc _proc;

        public event EventHandler<KeyEventArgs> KeyEvent;

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public int vkCode;
            public int scanCode;
            public int flags;
            public int time;
            public IntPtr dwExtraInfo;
        }

        public void Start()
        {
            _proc = HookCallback;
            using (var curProcess = Process.GetCurrentProcess())
            using (var curModule = curProcess.MainModule)
            {
                _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(curModule.ModuleName), 0);
            }

            if (_hookId == IntPtr.Zero)
            {
                Console.Error.WriteLine("[KeyboardHook] Failed to set hook. Error: " + Marshal.GetLastWin32Error());
                return;
            }

            Console.Error.WriteLine("[KeyboardHook] Hook installed successfully.");
            System.Windows.Forms.Application.Run();
        }

        public void Stop()
        {
            if (_hookId != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_hookId);
                _hookId = IntPtr.Zero;
            }
            System.Windows.Forms.Application.ExitThread();
        }

        private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var hookStruct = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));

                bool isInjected = (hookStruct.flags & 0x10) != 0;
                if (isInjected)
                {
                    return CallNextHookEx(_hookId, nCode, wParam, lParam);
                }

                int msg = wParam.ToInt32();
                bool isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                bool isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;

                if (isDown || isUp)
                {
                    int vk = hookStruct.vkCode;
                    bool isExtended = (hookStruct.flags & LLKHF_EXTENDED) != 0;

                    string keyName = ResolveKeyName(vk, isExtended);

                    bool shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
                    bool ctrlDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
                    bool altDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;

                    if (KeyEvent != null)
                    {
                        KeyEvent(this, new KeyEventArgs
                        {
                            KeyName = keyName,
                            VkCode = vk,
                            IsDown = isDown,
                            ShiftPressed = shiftDown,
                            CtrlPressed = ctrlDown,
                            AltPressed = altDown
                        });
                    }
                }
            }

            return CallNextHookEx(_hookId, nCode, wParam, lParam);
        }

        private static string ResolveKeyName(int vkCode, bool isExtended)
        {
            if (vkCode == VK_CONTROL) return isExtended ? "RIGHT CTRL" : "LEFT CTRL";
            if (vkCode == VK_LCONTROL) return "LEFT CTRL";
            if (vkCode == VK_RCONTROL) return "RIGHT CTRL";
            if (vkCode == VK_SHIFT) return isExtended ? "RIGHT SHIFT" : "LEFT SHIFT";
            if (vkCode == VK_LSHIFT) return "LEFT SHIFT";
            if (vkCode == VK_RSHIFT) return "RIGHT SHIFT";
            if (vkCode == VK_MENU) return isExtended ? "RIGHT ALT" : "LEFT ALT";
            return "VK_" + vkCode.ToString("X2");
        }
    }
}
