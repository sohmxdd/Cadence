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
    /// Explicitly release any logically held modifier keys (Ctrl, Shift, Alt)
    /// in Windows input queue so SendInput characters or Ctrl+V simulate cleanly.
    /// </summary>
    public static void ReleaseModifiers()
    {
        var inputSize = Marshal.SizeOf<INPUT>();
        ushort[] modifiers = new ushort[] { 0x11, 0xA2, 0xA3, 0x10, 0xA0, 0xA1, 0x12, 0xA4, 0xA5 };
        var inputs = new INPUT[modifiers.Length];
        for (int i = 0; i < modifiers.Length; i++)
        {
            inputs[i] = MakeKeyInput(modifiers[i], true);
        }
        SendInput((uint)inputs.Length, inputs, inputSize);
        Thread.Sleep(20);
    }

    /// <summary>
    /// Inject text character-by-character using SendInput with KEYEVENTF_UNICODE.
    /// </summary>
    public static void InjectViaKeyboard(string text)
    {
        ReleaseModifiers();
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
            Thread.Sleep(3);
        }
    }

    /// <summary>
    /// Inject text via clipboard + Ctrl+V.
    /// Must run on an STA thread for clipboard access.
    /// </summary>
    public static void InjectViaClipboard(string text)
    {
        ReleaseModifiers();

        var thread = new Thread(() =>
        {
            try
            {
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    try
                    {
                        System.Windows.Forms.Clipboard.SetText(text);
                        break;
                    }
                    catch
                    {
                        Thread.Sleep(30);
                    }
                }

                Thread.Sleep(40);

                // Simulate Ctrl+V
                var inputSize = Marshal.SizeOf<INPUT>();
                var inputs = new INPUT[4];

                inputs[0] = MakeKeyInput(VK_CONTROL, false);
                inputs[1] = MakeKeyInput(VK_V, false);
                inputs[2] = MakeKeyInput(VK_V, true);
                inputs[3] = MakeKeyInput(VK_CONTROL, true);

                uint sent = SendInput(4, inputs, inputSize);
                Console.Error.WriteLine($"[TextInjector] SendInput Ctrl+V result: {sent}");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[TextInjector] Clipboard inject error: {ex.Message}");
                // Fallback to keyboard injection
                InjectViaKeyboard(text);
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join(2000);
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
