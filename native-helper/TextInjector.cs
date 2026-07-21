using System.Runtime.InteropServices;

namespace CadenceHelper;

/// <summary>
/// Injects text into a target window via clipboard + simulated Ctrl+V keystrokes.
///
/// Root Cause of literal "v" typing:
/// Chromium / Electron / VS Code processes keydown messages in separate event loops.
/// When Ctrl Down and V Down were sent in the exact same SendInput batch without scan codes:
///   1. wScan was 0, so Chromium did not resolve the physical scan code for Ctrl.
///   2. Chromium processed the V keydown before the OS modifier state for Ctrl registered,
///      causing Chromium to handle it as a literal 'v' keystroke instead of Ctrl+V paste.
///
/// Fix:
///   1. MapVirtualKey(vk, 0) to include exact hardware scan codes (Ctrl = 0x1D, V = 0x2F).
///   2. Send Ctrl Down -> Thread.Sleep(35) -> Send V Down/Up -> Thread.Sleep(35) -> Send Ctrl Up.
///   3. This guarantees OS modifier state is updated BEFORE V keydown is processed.
/// </summary>
public static class TextInjector
{
    // Win32 INPUT struct — 40 bytes on x64 (type=4, pad=4, union=32)
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

    public static void InjectIntoWindow(string text, IntPtr targetHwnd, IntPtr targetFocusHwnd)
    {
        // Step 0: Release any lingering modifier keys from hotkey release
        ReleaseModifiers();
        Thread.Sleep(50);

        var thread = new Thread(() =>
        {
            try
            {
                // ----------------------------------------------------------
                // 1. Set text into Windows Clipboard (retry up to 5 times)
                // ----------------------------------------------------------
                bool clipboardSet = false;
                for (int i = 0; i < 5; i++)
                {
                    try
                    {
                        System.Windows.Forms.Clipboard.SetText(text);
                        clipboardSet = true;
                        Console.Error.WriteLine($"[TextInjector] Clipboard set ({text.Length} chars) on attempt {i + 1}");
                        break;
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine($"[TextInjector] Clipboard attempt {i + 1} failed: {ex.Message}");
                        Thread.Sleep(40);
                    }
                }

                if (!clipboardSet)
                {
                    Console.Error.WriteLine("[TextInjector] ERROR: Could not set clipboard");
                    return;
                }

                Thread.Sleep(60); // let clipboard content settle in Windows OS

                // ----------------------------------------------------------
                // 2. AttachThreadInput — share input queue with target thread
                // ----------------------------------------------------------
                uint currentTid = GetCurrentThreadId();
                uint targetTid = 0;
                bool attached = false;

                if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                {
                    targetTid = GetWindowThreadProcessId(targetHwnd, out _);
                    if (targetTid != 0 && targetTid != currentTid)
                    {
                        attached = AttachThreadInput(currentTid, targetTid, true);
                        Console.Error.WriteLine($"[TextInjector] AttachThreadInput({currentTid} -> {targetTid}) = {attached}");
                    }
                }

                try
                {
                    // ----------------------------------------------------------
                    // 3. Restore top-level & focused control window focus
                    // ----------------------------------------------------------
                    if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                    {
                        BringWindowToTop(targetHwnd);
                        bool fgSet = SetForegroundWindow(targetHwnd);
                        Thread.Sleep(80);
                        Console.Error.WriteLine($"[TextInjector] SetForegroundWindow(0x{targetHwnd:X}) = {fgSet}, actual fg = 0x{GetForegroundWindow():X}");
                    }

                    if (targetFocusHwnd != IntPtr.Zero && IsWindow(targetFocusHwnd) && targetFocusHwnd != targetHwnd)
                    {
                        SetFocus(targetFocusHwnd);
                        Thread.Sleep(50);
                    }

                    // ----------------------------------------------------------
                    // 4. Send Ctrl+V with explicit scan codes and timing delays
                    //    Step 4a: Send Ctrl DOWN
                    //    Step 4b: Wait 35ms for OS & Chromium to acknowledge Ctrl active
                    //    Step 4c: Send V DOWN & V UP
                    //    Step 4d: Wait 35ms
                    //    Step 4e: Send Ctrl UP
                    // ----------------------------------------------------------
                    int cbSize = Marshal.SizeOf<INPUT>();

                    // 4a. Ctrl DOWN
                    var ctrlDown = new[] { MakeVkInput(VK_CONTROL, false) };
                    uint s1 = SendInput(1, ctrlDown, cbSize);
                    Thread.Sleep(35);

                    // 4c. V DOWN & V UP
                    var vEvents = new[]
                    {
                        MakeVkInput(VK_V, false),
                        MakeVkInput(VK_V, true)
                    };
                    uint s2 = SendInput(2, vEvents, cbSize);
                    Thread.Sleep(35);

                    // 4e. Ctrl UP
                    var ctrlUp = new[] { MakeVkInput(VK_CONTROL, true) };
                    uint s3 = SendInput(1, ctrlUp, cbSize);

                    int err = Marshal.GetLastWin32Error();
                    Console.Error.WriteLine($"[TextInjector] SendInput Ctrl+V sequence: CtrlDown={s1}, V={s2}, CtrlUp={s3} (LastError={err})");

                    if (s1 == 1 && s2 == 2 && s3 == 1)
                    {
                        string preview = text.Length > 60 ? text.Substring(0, 60) + "..." : text;
                        Console.Error.WriteLine($"[TextInjector] SUCCESS: Pasted into 0x{targetHwnd:X} — \"{preview}\"");
                    }
                    else
                    {
                        Console.Error.WriteLine($"[TextInjector] FAILED: SendInput error code {err}");
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
                Console.Error.WriteLine($"[TextInjector] Exception: {ex}");
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
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
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
