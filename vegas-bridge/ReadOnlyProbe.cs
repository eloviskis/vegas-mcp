using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using ScriptPortal.Vegas;

/*
 * Read-only probe. Lists tracks and events of the open project and writes them as JSON to
 * %TEMP%\vegas-mcp-probe.json. It changes nothing in the project.
 *
 * Copy into the VEGAS script folder, then run it from Tools > Scripting.
 */
public class EntryPoint
{
    public void FromVegas(Vegas vegas)
    {
        var path = Path.Combine(Path.GetTempPath(), "vegas-mcp-probe.json");
        var sb = new StringBuilder();
        sb.Append("{\n");
        sb.Append("  \"tracks\": [\n");

        int trackIndex = 0;
        foreach (Track track in vegas.Project.Tracks)
        {
            if (trackIndex > 0) sb.Append(",\n");
            sb.Append("    {\"index\": " + trackIndex + ", \"name\": " + Quote(track.Name)
                + ", \"type\": " + Quote(track is VideoTrack ? "video" : track is AudioTrack ? "audio" : "other")
                + ", \"events\": [\n");

            int eventIndex = 0;
            foreach (TrackEvent ev in track.Events)
            {
                if (eventIndex > 0) sb.Append(",\n");
                sb.Append("      {\"index\": " + eventIndex
                    + ", \"name\": " + Quote(ev.Name)
                    + ", \"startMs\": " + ev.Start.ToMilliseconds().ToString("F1", System.Globalization.CultureInfo.InvariantCulture)
                    + ", \"lengthMs\": " + ev.Length.ToMilliseconds().ToString("F1", System.Globalization.CultureInfo.InvariantCulture)
                    + ", \"grouped\": " + (ev.IsGrouped ? "true" : "false")
                    + ", \"selected\": " + (ev.Selected ? "true" : "false")
                    + "}");
                eventIndex++;
            }
            sb.Append("\n    ]}");
            trackIndex++;
        }

        sb.Append("\n  ],\n");
        sb.Append("  \"projectLengthMs\": " + vegas.Project.Length.ToMilliseconds().ToString("F1", System.Globalization.CultureInfo.InvariantCulture) + "\n");
        sb.Append("}\n");

        File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
    }

    private static string Quote(string value)
    {
        if (value == null) return "null";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\"";
    }
}
