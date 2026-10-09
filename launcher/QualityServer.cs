using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

// Double-click launcher for the plant server: starts server.bat in its own window (closing that
// window stops the server), waits until the API answers, then opens the admin panel. When the
// server is already running it only opens the admin panel. Built by launcher\build.bat.
static class QualityServer
{
    const string HealthUrl = "http://127.0.0.1:4000/api/health";
    const string AdminUrl = "http://localhost:5000";
    const string Title = "Quality Monitoring";

    [STAThread]
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string bat = Path.Combine(root, "server.bat");
        if (!File.Exists(bat))
        {
            MessageBox.Show("server.bat was not found next to this program:\n" + root, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        if (!IsUp())
        {
            // Skip the (slow) web builds when both apps are already built; server.bat builds them otherwise.
            bool built = File.Exists(Path.Combine(root, @"admin-web\dist\index.html"))
                && File.Exists(Path.Combine(root, @"worker-mobile\dist\index.html"));
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + bat + "\"" + (built ? " --no-build" : "") + "\"");
            psi.WorkingDirectory = root;
            psi.UseShellExecute = true;
            Process.Start(psi);

            // First run installs dependencies and builds both apps, which takes much longer.
            DateTime deadline = DateTime.Now.AddMinutes(built ? 3 : 15);
            while (!IsUp())
            {
                if (DateTime.Now > deadline)
                {
                    MessageBox.Show("The server did not start. Look at the \"Quality Monitoring - Server\" window for the error.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 1;
                }
                Thread.Sleep(2000);
            }
        }

        Process.Start(AdminUrl);
        return 0;
    }

    static bool IsUp()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Timeout = 2000;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                return response.StatusCode == HttpStatusCode.OK;
        }
        catch
        {
            return false;
        }
    }
}
