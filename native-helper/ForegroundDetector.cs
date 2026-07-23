using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CadenceHelper
{
    public class ForegroundApp
    {
        public string ProcessName { get; set; }
        public string WindowTitle { get; set; }
        public IntPtr Hwnd { get; set; }

        public ForegroundApp(string processName, string windowTitle, IntPtr hwnd)
        {
            ProcessName = processName;
            WindowTitle = windowTitle;
            Hwnd = hwnd;
        }
    }

    public static class ForegroundDetector
    {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        public static ForegroundApp GetForegroundApp()
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero)
                    return new ForegroundApp("unknown", "", IntPtr.Zero);

                var titleBuilder = new StringBuilder(256);
                GetWindowText(hwnd, titleBuilder, 256);

                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                var process = Process.GetProcessById((int)pid);
                string processName = process.ProcessName;

                return new ForegroundApp(processName, titleBuilder.ToString(), hwnd);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[ForegroundDetector] Error: " + ex.Message);
                return new ForegroundApp("unknown", "", IntPtr.Zero);
            }
        }
    }
}
