using System;
using System.Collections;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using ScriptPortal.Vegas;

namespace VegasMcp.Startup
{
    /**
     * Starts the vegas-mcp bridge when VEGAS starts. VEGAS calls InitializeModule for this DLL when it
     * is in the VEGAS install folder, which needs administrator rights once. The bridge itself is
     * VegasMcpBridge.dll in %APPDATA%\vegas-mcp\module, so updating the bridge does not need
     * administrator rights. Every step is written to %APPDATA%\vegas-mcp\startup-test.log. Nothing here
     * may throw, because a failure must not stop VEGAS from starting.
     *
     * The file and class names match the test that VEGAS did run at startup. A module with a different
     * name did not run, so keep these names unless that is tested again.
     */
    public class StartupTestModule : ICustomCommandModule
    {
        public StartupTestModule()
        {
            Log("module constructed");
        }

        public void InitializeModule(Vegas vegas)
        {
            try
            {
                string project = vegas != null && vegas.Project != null ? vegas.Project.FilePath : "(none)";
                Log("InitializeModule called on thread " + Thread.CurrentThread.ManagedThreadId + "; project path: " + project);

                string path = Path.Combine(ModuleDirectory(), "VegasMcpBridge.dll");
                if (!File.Exists(path))
                {
                    Log("bridge not started: " + path + " is missing");
                    return;
                }
                Assembly bridge = Assembly.LoadFrom(path);
                Type entry = bridge.GetType("EntryPoint");
                if (entry == null)
                {
                    Log("bridge not started: EntryPoint not found in " + path);
                    return;
                }
                object instance = Activator.CreateInstance(entry);
                MethodInfo start = entry.GetMethod("FromVegas", BindingFlags.Public | BindingFlags.Instance);
                start.Invoke(instance, new object[] { vegas });
                Log("bridge started from " + path);
            }
            catch (Exception error)
            {
                Log("bridge not started: " + error.GetType().Name + ": " + error.Message);
            }
        }

        public ICollection GetCustomCommands()
        {
            return new ArrayList();
        }

        private static string ModuleDirectory()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "vegas-mcp", "module");
        }

        private static void Log(string text)
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "vegas-mcp");
                Directory.CreateDirectory(dir);
                File.AppendAllText(
                    Path.Combine(dir, "startup-test.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + text + Environment.NewLine,
                    new UTF8Encoding(false));
            }
            catch (Exception)
            {
                // Logging must never stop VEGAS from starting.
            }
        }
    }
}
