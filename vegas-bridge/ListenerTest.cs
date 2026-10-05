using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using ScriptPortal.Vegas;

/*
 * Listener test. Opens a loopback TCP port and answers "ping" with "pong". The question it
 * answers: does the listener keep running after FromVegas returns? Status goes to
 * %TEMP%\vegas-mcp-listener.json so it can be checked without a window.
 *
 * Read-only: it never touches the project.
 */
public class EntryPoint
{
    private const int Port = 47800;

    // Kept in a static so the garbage collector cannot drop the listener.
    private static TcpListener listener;

    public void FromVegas(Vegas vegas)
    {
        var statusPath = Path.Combine(Path.GetTempPath(), "vegas-mcp-listener.json");
        try
        {
            listener = new TcpListener(IPAddress.Loopback, Port);
            listener.Start();

            var thread = new Thread(() => AcceptLoop(statusPath)) { IsBackground = true, Name = "vegas-mcp-listener" };
            thread.Start();

            Write(statusPath, "started", "listening on 127.0.0.1:" + Port + "; FromVegas will return now");
        }
        catch (Exception error)
        {
            Write(statusPath, "failed", error.GetType().Name + ": " + error.Message);
        }
    }

    private static void AcceptLoop(string statusPath)
    {
        while (true)
        {
            TcpClient client;
            try
            {
                client = listener.AcceptTcpClient();
            }
            catch (Exception error)
            {
                Write(statusPath, "accept-stopped", error.Message);
                return;
            }

            try
            {
                using (client)
                using (var stream = client.GetStream())
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    var line = reader.ReadLine();
                    writer.WriteLine(line == "ping" ? "pong" : "unknown: " + line);
                    Write(statusPath, "served", "last request: " + line + " at " + DateTime.Now.ToString("HH:mm:ss"));
                }
            }
            catch (Exception error)
            {
                Write(statusPath, "client-error", error.Message);
            }
        }
    }

    private static void Write(string path, string state, string detail)
    {
        var json = "{\"state\": \"" + state + "\", \"detail\": \"" + detail.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}\n";
        File.WriteAllText(path, json, new UTF8Encoding(false));
    }
}
