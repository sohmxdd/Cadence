using System.Runtime.InteropServices;

namespace CadenceHelper;

/// <summary>
/// Injects text into the currently focused window via SendInput (keyboard simulation)
/// or via clipboard + Ctrl+V paste for longer text blocks.
/// </summary>
public static class TextInjector
{
    // SendInput structures
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION union;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
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
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_V = 0x56;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    /// <summary>
    /// Inject text character-by-character using SendInput with KEYEVENTF_UNICODE.
    /// Best for short text (&lt;= 100 chars). Adds a small delay between chars.
    /// </summary>
    public static void InjectViaKeyboard(string text)
    {
        var inputSize = Marshal.SizeOf<INPUT>();

        foreach (char c in text)
        {
            var inputs = new INPUT[2];

            // Key down
            inputs[0] = new INPUT
            {
                type = INPUT_KEYBOARD,
                union = new INPUTUNION
                {
                    ki = new KEYBDINPUT
                    {
                        wVk = 0,
                        wScan = c,
                        dwFlags = KEYEVENTF_UNICODE,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };

            // Key up
            inputs[1] = new INPUT
            {
                type = INPUT_KEYBOARD,
                union = new INPUTUNION
                {
                    ki = new KEYBDINPUT
                    {
                        wVk = 0,
                        wScan = c,
                        dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };

            SendInput(2, inputs, inputSize);
            Thread.Sleep(3); // Small delay to avoid dropped chars
        }
    }

    /// <summary>
    /// Inject text via clipboard + Ctrl+V. Used for longer text blocks.
    /// Must run on an STA thread for clipboard access.
    /// </summary>
    public static void InjectViaClipboard(string text)
    {
        // Clipboard operations need STA thread
        var thread = new Thread(() =>
        {
            try
            {
                // Save current clipboard
                System.Windows.Forms.Clipboard.SetText(text);
                Thread.Sleep(50); // Let clipboard settle

                // Simulate Ctrl+V
                var inputSize = Marshal.SizeOf<INPUT>();
                var inputs = new INPUT[4];

                // Ctrl down
                inputs[0] = MakeKeyInput(VK_CONTROL, false);
                // V down
                inputs[1] = MakeKeyInput(VK_V, false);
                // V up
                inputs[2] = MakeKeyInput(VK_V, true);
                // Ctrl up
                inputs[3] = MakeKeyInput(VK_CONTROL, true);

                SendInput(4, inputs, inputSize);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[TextInjector] Clipboard inject error: {ex.Message}");
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join(2000); // Wait up to 2s
    }

    private static INPUT MakeKeyInput(ushort vk, bool keyUp)
    {
        return new INPUT
        {
            type = INPUT_KEYBOARD,
            union = new INPUTUNION
            {
                ki = new KEYBDINPUT
                {
                    wVk = vk,
                    wScan = 0,
                    dwFlags = keyUp ? KEYEVENTF_KEYUP : 0,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
    }
}
