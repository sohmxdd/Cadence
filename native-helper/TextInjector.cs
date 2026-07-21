using System.Runtime.InteropServices;

namespace CadenceHelper;

/// <summary>
/// Injects text into a target window by restoring the exact focus state that existed
/// when the user pressed the hotkey, then simulating Ctrl+V.
///
/// Key fixes applied:
///
/// 1. LLKHF_INJECTED filter in KeyboardHook.cs:
///    Our WH_KEYBOARD_LL hook was intercepting our OWN SendInput Ctrl+V events and
///    re-broadcasting them over IPC. The hook's message pump would then process them,
///    causing input to land in the hook thread rather than the target window. Fixed by
///    skipping events with the LLKHF_INJECTED flag (0x10).
///
/// 2. Focused child HWND capture at get_foreground time:
///    GetForegroundWindow() returns the top-level HWND (e.g. VS Code's BrowserWindow).
///    But the actual text cursor is in a child control (Chrome_RenderWidgetHostHWND for
///    Electron apps, EDIT control for Notepad). We now capture GetFocus() at the moment
///    the user releases the hotkey, giving us the exact control to restore. Without this,
///    SetForegroundWindow alone can't tell Windows WHICH pane within VS Code to focus,
///    causing Ctrl+V to land in the terminal instead of the editor.
///
/// 3. Win32 INPUT struct size = 40 bytes (x64 ABI):
///    LayoutKind.Explicit, Size=40, ki at FieldOffset(8).
///    Previous value of 32 caused LastError=87 (ERROR_INVALID_PARAMETER).
///
/// 4. WM_PASTE removed:
///    Sending WM_PASTE to arbitrary HWNDs caused paste to appear in the wrong textbox.
///    Ctrl+V via SendInput after precise focus restoration is simpler and more correct.
/// </summary>
public static class TextInjector
{
    // -----------------------------------------------------------------------
    // Win32 INPUT struct — 40 bytes on x64 (type=4, pad=4, union=32)
    // -----------------------------------------------------------------------
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    private struct INPUT
    {
        [FieldOffset(0)]  public uint type;
        [FieldOffset(8)]  public KEYBDINPUT ki;
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
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_V = 0x56;

    // -----------------------------------------------------------------------
    // P/Invoke
    // -----------------------------------------------------------------------
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

    /// <summary>
    /// SetFocus sets the keyboard focus to a specific window WITHIN the calling thread
    /// (or, after AttachThreadInput, within the target thread). This restores the exact
    /// cursor position within VS Code's editor pane, Notepad's edit control, etc.
    /// </summary>
    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    // -----------------------------------------------------------------------
    // Main injection entry point
    // -----------------------------------------------------------------------

    /// <summary>
    /// Set clipboard, restore exact window+control focus, send Ctrl+V.
    ///
    /// targetHwnd    = top-level foreground window at hotkey-up time
    /// targetFocusHwnd = exact focused child control at hotkey-up time (from GetFocus())
    /// </summary>
    public static void InjectIntoWindow(string text, IntPtr targetHwnd, IntPtr targetFocusHwnd)
    {
        // Release modifier keys held from the hotkey gesture before doing anything
        ReleaseModifiers();
        Thread.Sleep(50);

        var thread = new Thread(() =>
        {
            try
            {
                // ----------------------------------------------------------
                // 1. Set clipboard (retry up to 5 times)
                // ----------------------------------------------------------
                bool clipboardSet = false;
                for (int i = 0; i < 5; i++)
                {
                    try
                    {
                        System.Windows.Forms.Clipboard.SetText(text);
                        clipboardSet = true;
                        Console.Error.WriteLine($"[TextInjector] Clipboard set: {text.Length} chars (attempt {i + 1})");
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

                Thread.Sleep(60); // let clipboard data settle

                // ----------------------------------------------------------
                // 2. AttachThreadInput — share input queue with target thread.
                //    This makes SetForegroundWindow and SetFocus guaranteed to work,
                //    and ensures our SendInput goes to the attached thread's focused window.
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
                    // 3. Restore top-level window focus (bring VS Code / Notepad to front)
                    // ----------------------------------------------------------
                    if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                    {
                        BringWindowToTop(targetHwnd);
                        bool fgSet = SetForegroundWindow(targetHwnd);
                        Thread.Sleep(80);
                        Console.Error.WriteLine($"[TextInjector] SetForegroundWindow(0x{targetHwnd:X}) = {fgSet}, actual fg = 0x{GetForegroundWindow():X}");
                    }

                    // ----------------------------------------------------------
                    // 4. Restore exact child control focus (the editor pane / text field).
                    //    Captured at get_foreground time via GetFocus() after AttachThreadInput.
                    //    This ensures Ctrl+V lands in the editor, NOT the terminal or sidebar.
                    // ----------------------------------------------------------
                    if (targetFocusHwnd != IntPtr.Zero && IsWindow(targetFocusHwnd))
                    {
                        IntPtr prevFocus = SetFocus(targetFocusHwnd);
                        Console.Error.WriteLine($"[TextInjector] SetFocus(0x{targetFocusHwnd:X}) -> prevFocus was 0x{prevFocus:X}");
                        Thread.Sleep(60); // let focus settle
                    }
                    else
                    {
                        Console.Error.WriteLine($"[TextInjector] No valid focusHwnd (0x{targetFocusHwnd:X}), skipping SetFocus");
                        Thread.Sleep(80);
                    }

                    // ----------------------------------------------------------
                    // 5. SendInput Ctrl+V
                    //    sizeof(INPUT) = 40 bytes on x64 (LayoutKind.Explicit, Size=40).
                    //    With AttachThreadInput, input goes to the target thread's focused window.
                    //    The LLKHF_INJECTED filter in KeyboardHook.cs ensures our own Ctrl+V is
                    //    NOT intercepted by the hook and re-broadcast (which was the previous failure).
                    // ----------------------------------------------------------
                    int cbSize = Marshal.SizeOf<INPUT>();
                    var inputs = new INPUT[4];
                    inputs[0] = MakeVkInput(VK_CONTROL, false); // Ctrl down
                    inputs[1] = MakeVkInput(VK_V,       false); // V down
                    inputs[2] = MakeVkInput(VK_V,       true);  // V up
                    inputs[3] = MakeVkInput(VK_CONTROL, true);  // Ctrl up

                    uint sent = SendInput(4, inputs, cbSize);
                    int err   = Marshal.GetLastWin32Error();

                    Console.Error.WriteLine($"[TextInjector] SendInput Ctrl+V: {sent}/4 events sent, cbSize={cbSize}, LastError={err}");

                    if (sent == 4)
                    {
                        string preview = text.Length > 60 ? text.Substring(0, 60) + "..." : text;
                        Console.Error.WriteLine($"[TextInjector] SUCCESS: injected into 0x{targetFocusHwnd:X} — \"{preview}\"");
                    }
                    else
                    {
                        Console.Error.WriteLine($"[TextInjector] FAILED: SendInput returned {sent}/4, LastError={err}");
                    }
                }
                finally
                {
                    // Always detach thread input
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

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

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
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            ki = new KEYBDINPUT
            {
                wVk         = vk,
                wScan       = 0,
                dwFlags     = keyUp ? KEYEVENTF_KEYUP : 0,
                time        = 0,
                dwExtraInfo = IntPtr.Zero
            }
        };
    }
}
