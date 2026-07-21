using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CadenceHelper;

/// <summary>
/// Detects the foreground (currently focused) application.
/// Used for per-app formatting profiles.
/// </summary>
public static class ForegroundDetector
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    public record ForegroundApp(string ProcessName, string WindowTitle);

    public static ForegroundApp GetForegroundApp()
    {
        try
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
                return new ForegroundApp("unknown", "");

            // Get window title
            var titleBuilder = new StringBuilder(256);
            GetWindowText(hwnd, titleBuilder, 256);

            // Get process name
            GetWindowThreadProcessId(hwnd, out uint pid);
            var process = Process.GetProcessById((int)pid);
            string processName = process.ProcessName;

            return new ForegroundApp(processName, titleBuilder.ToString());
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[ForegroundDetector] Error: {ex.Message}");
            return new ForegroundApp("unknown", "");
        }
    }
}
