using System.Diagnostics;
using System.Runtime.InteropServices;

namespace CadenceHelper;

/// <summary>
/// Key event arguments sent over IPC.
/// </summary>
public class KeyEventArgs : EventArgs
{
    public string KeyName { get; init; } = "";
    public int VkCode { get; init; }
    public bool IsDown { get; init; }
    public bool ShiftPressed { get; init; }
    public bool CtrlPressed { get; init; }
    public bool AltPressed { get; init; }
}

/// <summary>
/// Low-level Windows keyboard hook (WH_KEYBOARD_LL).
/// Detects keydown/keyup for all keys system-wide, including Right Ctrl.
/// Runs on an STA thread with Application.Run() message pump.
/// </summary>
public class KeyboardHook
{
    // Win32 constants
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    // Virtual key codes of interest
    private const int VK_SHIFT = 0x10;
    private const int VK_CONTROL = 0x11;
    private const int VK_MENU = 0x12;     // Alt
    private const int VK_LSHIFT = 0xA0;
    private const int VK_RSHIFT = 0xA1;
    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;

    // KBDLLHOOKSTRUCT flags
    private const int LLKHF_EXTENDED = 0x01;

    private IntPtr _hookId = IntPtr.Zero;
    private LowLevelKeyboardProc? _proc;

    public event EventHandler<KeyEventArgs>? KeyEvent;

    // P/Invoke declarations
    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

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

    /// <summary>
    /// Install the hook and start the message pump. Call from an STA thread.
    /// </summary>
    public void Start()
    {
        _proc = HookCallback;
        using var curProcess = Process.GetCurrentProcess();
        using var curModule = curProcess.MainModule!;
        _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(curModule.ModuleName), 0);

        if (_hookId == IntPtr.Zero)
        {
            Console.Error.WriteLine($"[KeyboardHook] Failed to set hook. Error: {Marshal.GetLastWin32Error()}");
            return;
        }

        Console.Error.WriteLine("[KeyboardHook] Hook installed successfully.");

        // Message pump — required for WH_KEYBOARD_LL to work in a console app
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
            var hookStruct = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            int msg = wParam.ToInt32();
            bool isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            bool isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if (isDown || isUp)
            {
                int vk = hookStruct.vkCode;
                bool isExtended = (hookStruct.flags & LLKHF_EXTENDED) != 0;

                // Resolve Left/Right for modifier keys
                string keyName = ResolveKeyName(vk, isExtended);

                // Check modifier state
                bool shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
                bool ctrlDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
                bool altDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;

                KeyEvent?.Invoke(this, new KeyEventArgs
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

        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    private static string ResolveKeyName(int vkCode, bool isExtended)
    {
        // Differentiate Left/Right for Ctrl, Shift, Alt
        return vkCode switch
        {
            VK_CONTROL => isExtended ? "RIGHT CTRL" : "LEFT CTRL",
            VK_LCONTROL => "LEFT CTRL",
            VK_RCONTROL => "RIGHT CTRL",
            VK_SHIFT => isExtended ? "RIGHT SHIFT" : "LEFT SHIFT",
            VK_LSHIFT => "LEFT SHIFT",
            VK_RSHIFT => "RIGHT SHIFT",
            VK_MENU => isExtended ? "RIGHT ALT" : "LEFT ALT",
            _ => $"VK_{vkCode:X2}"
        };
    }
}
