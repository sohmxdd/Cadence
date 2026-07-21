using System.Runtime.InteropServices;

namespace CadenceHelper;

/// <summary>
/// Injects text into a target window using AttachThreadInput + Ctrl+V clipboard paste.
///
/// Root cause of previous failure (LastError=87 / ERROR_INVALID_PARAMETER):
/// The Win32 INPUT struct is 40 bytes on x64 (the union must hold MOUSEINPUT = 32 bytes),
/// but our previous C# struct only included KEYBDINPUT in the union (24 bytes), making
/// the struct 32 bytes total. SendInput checks cbSize strictly and rejects the call when
/// it doesn't exactly match 40. Fix: LayoutKind.Explicit, Size=40 with ki at FieldOffset(8).
/// </summary>
public static class TextInjector
{
    // -----------------------------------------------------------------------
    // Win32 INPUT structures — MUST match x64 ABI exactly (40 bytes total)
    // -----------------------------------------------------------------------
    // On x64: sizeof(INPUT) = 4 (type) + 4 (alignment pad) + 32 (union = sizeof MOUSEINPUT) = 40
    // KEYBDINPUT starts at offset 8 within INPUT.
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
        public IntPtr dwExtraInfo;   // IntPtr = 8 bytes on x64
    }

    private const uint INPUT_KEYBOARD     = 1;
    private const uint KEYEVENTF_UNICODE  = 0x0004;
    private const uint KEYEVENTF_KEYUP    = 0x0002;
    private const ushort VK_CONTROL       = 0x11;
    private const ushort VK_V             = 0x56;

    // -----------------------------------------------------------------------
    // P/Invoke declarations
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

    /// <summary>
    /// Borrow the target window's input queue so SetForegroundWindow + SendInput
    /// always work from a background process — the same technique used by AutoHotkey.
    /// </summary>
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    // -----------------------------------------------------------------------
    // Main injection entry point
    // -----------------------------------------------------------------------

    /// <summary>
    /// Set clipboard, attach to target thread, restore focus, send Ctrl+V.
    /// Must be called from any thread; internally spawns STA thread for clipboard API.
    /// </summary>
    public static void InjectIntoWindow(string text, IntPtr targetHwnd)
    {
        // Release any modifier keys that are still logically held (Right Ctrl from hotkey).
        ReleaseModifiers();
        Thread.Sleep(50);

        // Everything below needs STA for Clipboard API
        var thread = new Thread(() =>
        {
            try
            {
                // ----------------------------------------------------------
                // 1. Write text to clipboard (retry up to 5 times)
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

                Thread.Sleep(60); // let clipboard data settle

                // ----------------------------------------------------------
                // 2. AttachThreadInput — borrow the target window's input queue.
                //    While attached, SetForegroundWindow and SendInput are guaranteed
                //    to work from any background process.
                // ----------------------------------------------------------
                uint targetTid = 0;
                uint currentTid = GetCurrentThreadId();
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
                    // 3. Restore focus to original target window
                    // ----------------------------------------------------------
                    if (targetHwnd != IntPtr.Zero && IsWindow(targetHwnd))
                    {
                        BringWindowToTop(targetHwnd);
                        bool fgSet = SetForegroundWindow(targetHwnd);
                        Thread.Sleep(80);
                        IntPtr actualFg = GetForegroundWindow();
                        Console.Error.WriteLine($"[TextInjector] SetForegroundWindow(0x{targetHwnd:X}) = {fgSet}, actual fg = 0x{actualFg:X}, match = {actualFg == targetHwnd}");
                    }

                    // ----------------------------------------------------------
                    // 4. Send Ctrl+V via SendInput
                    //    INPUT struct is explicitly 40 bytes (Size=40) to match Win32 x64 ABI.
                    //    Previous failure was ERROR_INVALID_PARAMETER (87) because we had 32 bytes.
                    // ----------------------------------------------------------
                    int cbSize = Marshal.SizeOf<INPUT>(); // must be 40 on x64
                    Console.Error.WriteLine($"[TextInjector] sizeof(INPUT) = {cbSize} bytes (expected 40 on x64)");

                    var inputs = new INPUT[4];
                    inputs[0] = MakeVkInput(VK_CONTROL, false); // Ctrl down
                    inputs[1] = MakeVkInput(VK_V,       false); // V down
                    inputs[2] = MakeVkInput(VK_V,       true);  // V up
                    inputs[3] = MakeVkInput(VK_CONTROL, true);  // Ctrl up

                    uint sent = SendInput(4, inputs, cbSize);
                    int err   = Marshal.GetLastWin32Error();

                    Console.Error.WriteLine($"[TextInjector] SendInput Ctrl+V: {sent}/4 events sent, LastError={err}");

                    if (sent == 4)
                        Console.Error.WriteLine($"[TextInjector] SUCCESS — Ctrl+V dispatched, '{text.Substring(0, Math.Min(text.Length, 40))}...'");
                    else
                        Console.Error.WriteLine($"[TextInjector] FAILED — SendInput error code {err}");
                }
                finally
                {
                    // ----------------------------------------------------------
                    // 5. Always detach thread input
                    // ----------------------------------------------------------
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

    /// <summary>
    /// Release all logically-held modifier keys so they don't corrupt the Ctrl+V.
    /// </summary>
    public static void ReleaseModifiers()
    {
        var mods = new ushort[] { 0x11, 0xA2, 0xA3, 0x10, 0xA0, 0xA1, 0x12, 0xA4, 0xA5 };
        var inputs = new INPUT[mods.Length];
        for (int i = 0; i < mods.Length; i++)
            inputs[i] = MakeVkInput(mods[i], keyUp: true);
        int cbSize = Marshal.SizeOf<INPUT>();
        SendInput((uint)inputs.Length, inputs, cbSize);
    }

    private static INPUT MakeVkInput(ushort vk, bool keyUp)
    {
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            ki = new KEYBDINPUT
            {
                wVk          = vk,
                wScan        = 0,
                dwFlags      = keyUp ? KEYEVENTF_KEYUP : 0,
                time         = 0,
                dwExtraInfo  = IntPtr.Zero
            }
        };
    }
}
