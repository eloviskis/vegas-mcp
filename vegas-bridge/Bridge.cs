using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using ScriptPortal.Vegas;

/*
 * vegas-mcp bridge. Runs inside VEGAS (Tools > Scripting) and listens on 127.0.0.1 for
 * one-line commands from the MCP server:
 *
 *     <token> status
 *     <token> timeline
 *     <token> split <trackIndex> <eventIndex> <offsetMs>
 *     <token> remove <startMs> <endMs>
 *     <token> stop
 *
 * The token is random per run and written to %APPDATA%\vegas-mcp\bridge-token.txt. Every
 * reply is one JSON line.
 *
 * Threading: VEGAS objects are COM and belong to the thread that runs the script. The
 * listener therefore never touches VEGAS. It queues each request, and a WinForms timer on
 * the script's own thread drains the queue. FromVegas returns straight away, so VEGAS stays
 * usable while the bridge runs.
 *
 * Every command that changes the project runs inside an UndoBlock, so Ctrl+Z reverts it.
 * `undo` calls Project.Undo for test runs; the MCP server does not expose it.
 */
public class EntryPoint
{
    private const int Port = 47802;
    private const int ReplyTimeoutMs = 20000;
    private const int RenderTimeoutMs = 30 * 60 * 1000;

    // Static so the garbage collector cannot drop the listener, the timer or the VEGAS reference.
    private static TcpListener listener;
    private static System.Windows.Forms.Timer pumpTimer;
    private static Vegas vegasRef;
    private static string token;
    private static string statusPath;
    private static volatile bool running;

    private static readonly object queueLock = new object();
    private static readonly Queue<PendingRequest> pending = new Queue<PendingRequest>();

    private class PendingRequest
    {
        public string Line;
        public string Reply;
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
    }

    public void FromVegas(Vegas vegas)
    {
        vegasRef = vegas;
        statusPath = Path.Combine(Path.GetTempPath(), "vegas-mcp-bridge-status.json");
        try
        {
            // Open the port first. If another instance already holds it, this fails before the
            // token file is touched, so the instance that is running keeps working.
            listener = new TcpListener(IPAddress.Loopback, Port);
            listener.Start();

            token = NewToken();
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "vegas-mcp");
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "bridge-token.txt"), token, new UTF8Encoding(false));
            running = true;

            pumpTimer = new System.Windows.Forms.Timer();
            pumpTimer.Interval = 25;
            pumpTimer.Tick += delegate { Pump(); };
            pumpTimer.Start();

            new Thread(new ThreadStart(AcceptLoop)) { IsBackground = true, Name = "vegas-mcp-bridge" }.Start();

            WriteStatus("running", "listening on 127.0.0.1:" + Port + "; send 'stop' to end");
        }
        catch (Exception error)
        {
            WriteStatus("failed", error.GetType().Name + ": " + error.Message);
        }
    }

    /** Runs on a background thread. Reads one request per client and waits for VEGAS to answer. */
    private static void AcceptLoop()
    {
        while (running)
        {
            TcpClient client;
            try
            {
                client = listener.AcceptTcpClient();
            }
            catch (Exception)
            {
                return; // listener stopped
            }

            try
            {
                using (client)
                using (var stream = client.GetStream())
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    var line = reader.ReadLine() ?? "";
                    writer.WriteLine(Dispatch(line));
                }
            }
            catch (Exception error)
            {
                WriteStatus("client-error", error.Message);
            }
        }
    }

    /** Queues one request for the VEGAS thread and waits for its reply. */
    private static string Dispatch(string line)
    {
        var request = new PendingRequest { Line = line };
        lock (queueLock)
        {
            pending.Enqueue(request);
        }
        // Rendering runs on VEGAS's thread and can take minutes; other commands answer quickly.
        var timeoutMs = line.IndexOf(" render ", StringComparison.Ordinal) >= 0 ? RenderTimeoutMs : ReplyTimeoutMs;
        if (!request.Done.WaitOne(timeoutMs))
        {
            return Error("VEGAS did not answer within " + (timeoutMs / 1000) + " s");
        }
        return request.Reply;
    }

    /** Runs on the script's own thread, on the timer tick. Only here is it safe to touch VEGAS. */
    private static void Pump()
    {
        try
        {
            var batch = new List<PendingRequest>();
            lock (queueLock)
            {
                while (pending.Count > 0) batch.Add(pending.Dequeue());
            }

            foreach (var request in batch)
            {
                request.Reply = Handle(request.Line);
                request.Done.Set();
            }

            if (!running)
            {
                pumpTimer.Stop();
                listener.Stop();
                WriteStatus("stopped", "stop received");
            }
        }
        catch (Exception error)
        {
            WriteStatus("pump-error", error.GetType().Name + ": " + error.Message);
        }
    }

    /** Parses one request line and returns one JSON reply line. */
    private static string Handle(string line)
    {
        var parts = line.Trim().Split(' ');
        if (parts.Length < 2 || parts[0] != token)
        {
            return Error("unauthorized");
        }

        try
        {
            switch (parts[1])
            {
                case "status":
                    return Status();
                case "timeline":
                    return Timeline();
                case "split":
                    if (parts.Length != 5) return Error("usage: split <trackIndex> <eventIndex> <offsetMs>");
                    return Split(int.Parse(parts[2], CultureInfo.InvariantCulture),
                                 int.Parse(parts[3], CultureInfo.InvariantCulture),
                                 double.Parse(parts[4], CultureInfo.InvariantCulture));
                case "remove":
                    if (parts.Length != 4) return Error("usage: remove <startMs> <endMs>");
                    return RemoveRange(double.Parse(parts[2], CultureInfo.InvariantCulture),
                                       double.Parse(parts[3], CultureInfo.InvariantCulture));
                case "backup":
                    return Backup();
                case "overlay":
                    return Overlay(ArgsAfter(line, 2));
                case "alpha":
                    if (parts.Length != 3) return Error("usage: alpha <trackIndex>");
                    return Alpha(parts[2]);
                case "audio_info":
                    if (parts.Length != 4) return Error("usage: audio_info <trackIndex> <eventIndex>");
                    return AudioInfo(int.Parse(parts[2], CultureInfo.InvariantCulture),
                                     int.Parse(parts[3], CultureInfo.InvariantCulture));
                case "fade":
                    return SetFades(ArgsAfter(line, 2));
                case "normalize":
                    return SetNormalize(ArgsAfter(line, 2));
                case "speed":
                    return SetSpeed(ArgsAfter(line, 2));
                case "motion_info":
                    return MotionInfo(ArgsAfter(line, 2));
                case "motion_fill":
                    return SetScaleToFill(ArgsAfter(line, 2));
                case "render_templates":
                    return RenderTemplates();
                case "render":
                    return Render(ArgsAfter(line, 2));
                case "motion":
                    return SetMotion(ArgsAfter(line, 2));
                case "marker_add":
                    return AddMarker(ArgsAfter(line, 2));
                case "marker_list":
                    return ListMarkers();
                case "marker_remove":
                    return RemoveMarker(ArgsAfter(line, 2));
                case "undo":
                    return Undo();
                case "stop":
                    running = false;
                    return "{\"ok\": true, \"stopping\": true}";
                default:
                    return Error("unknown command: " + parts[1]);
            }
        }
        catch (Exception error)
        {
            return Error(error.GetType().Name + ": " + error.Message);
        }
    }

    private static string Status()
    {
        var tracks = 0;
        foreach (Track t in vegasRef.Project.Tracks) tracks++;
        return "{\"ok\": true, \"tracks\": " + tracks
            + ", \"projectLengthMs\": " + Num(vegasRef.Project.Length.ToMilliseconds())
            + ", \"projectPath\": " + Quote(vegasRef.Project.FilePath)
            + ", \"projectModified\": " + (vegasRef.Project.IsModified ? "true" : "false")
            + ", \"projectWidth\": " + Num(vegasRef.Project.Video.Width)
            + ", \"projectHeight\": " + Num(vegasRef.Project.Video.Height)
            + ", \"bridgeVersion\": 5}";
    }

    /** Returns the text of a request line after its first `words` space-separated words. Keeps spaces in paths. */
    private static string ArgsAfter(string line, int words)
    {
        var rest = line.Trim();
        for (int i = 0; i < words; i++)
        {
            int space = rest.IndexOf(' ');
            rest = space < 0 ? "" : rest.Substring(space + 1);
        }
        return rest.Trim();
    }

    /**
     * Adds a new video track at the top and places a clip on it. Arguments: <path>|<startMs>|<lengthMs>.
     * The clip uses its first video stream. Overlays with alpha, such as render_overlay output, show
     * over the footage below.
     */
    private static string Overlay(string args)
    {
        var parts = args.Split('|');
        if (parts.Length != 3)
        {
            return Error("usage: overlay <path>|<startMs>|<lengthMs>");
        }
        var path = parts[0];
        var startMs = double.Parse(parts[1], CultureInfo.InvariantCulture);
        var lengthMs = double.Parse(parts[2], CultureInfo.InvariantCulture);
        if (!File.Exists(path))
        {
            return Error("media not found: " + path);
        }
        if (!(lengthMs > 0))
        {
            return Error("lengthMs must be positive");
        }

        using (new UndoBlock(vegasRef.Project, "vegas-mcp overlay"))
        {
            var media = new Media(path);
            if (!media.HasVideo())
            {
                return Error("the file has no video stream to place as an overlay");
            }
            // Without straight alpha and source-alpha compositing, VEGAS shows the transparent
            // pixels as opaque black and hides the footage underneath.
            var stream = media.GetVideoStreamByIndex(0);
            stream.AlphaChannel = VideoAlphaType.Straight;
            var track = vegasRef.Project.AddVideoTrack();
            track.CompositeMode = CompositeMode.SrcAlpha;
            var ev = track.AddVideoEvent(new Timecode(startMs), new Timecode(lengthMs));
            ev.AddTake(stream);
        }
        return "{\"ok\": true, \"placedMs\": " + Num(startMs) + ", \"lengthMs\": " + Num(lengthMs) + "}";
    }

    /**
     * Fixes an existing overlay track: composites its clips by source alpha and marks each clip's
     * media as straight alpha. Use it on tracks made before overlay set these itself.
     */
    private static string Alpha(string indexText)
    {
        int trackIndex = int.Parse(indexText, CultureInfo.InvariantCulture);
        var track = vegasRef.Project.Tracks[trackIndex] as VideoTrack;
        if (track == null)
        {
            return Error("track " + trackIndex + " is not a video track");
        }

        int marked = 0;
        using (new UndoBlock(vegasRef.Project, "vegas-mcp alpha"))
        {
            track.CompositeMode = CompositeMode.SrcAlpha;
            foreach (TrackEvent ev in new List<TrackEvent>(track.Events))
            {
                var take = ev.ActiveTake;
                if (take == null || take.Media == null) continue;
                take.Media.GetVideoStreamByIndex(0).AlphaChannel = VideoAlphaType.Straight;
                marked++;
            }
        }
        return "{\"ok\": true, \"track\": " + trackIndex + ", \"clipsMarked\": " + marked + "}";
    }

    private static TrackEvent FindEvent(int trackIndex, int eventIndex)
    {
        return vegasRef.Project.Tracks[trackIndex].Events[eventIndex];
    }

    /** Reads the fades, playback rate, mute and, for audio, the normalisation of one event. Changes nothing. */
    private static string AudioInfo(int trackIndex, int eventIndex)
    {
        var ev = FindEvent(trackIndex, eventIndex);
        var audio = ev as AudioEvent;
        var sb = new StringBuilder();
        sb.Append("{\"ok\": true, \"track\": " + trackIndex + ", \"event\": " + eventIndex);
        sb.Append(", \"kind\": " + Quote(audio != null ? "audio" : "video"));
        sb.Append(", \"lengthMs\": " + Num(ev.Length.ToMilliseconds()));
        sb.Append(", \"fadeInMs\": " + Num(ev.FadeIn.Length.ToMilliseconds()));
        sb.Append(", \"fadeInCurve\": " + Quote(ev.FadeIn.Curve.ToString()));
        sb.Append(", \"fadeOutMs\": " + Num(ev.FadeOut.Length.ToMilliseconds()));
        sb.Append(", \"fadeOutCurve\": " + Quote(ev.FadeOut.Curve.ToString()));
        sb.Append(", \"playbackRate\": " + ev.PlaybackRate.ToString("F4", CultureInfo.InvariantCulture));
        sb.Append(", \"mute\": " + (ev.Mute ? "true" : "false"));
        if (audio != null)
        {
            sb.Append(", \"normalize\": " + (audio.Normalize ? "true" : "false"));
            sb.Append(", \"normalizeGain\": " + audio.NormalizeGain.ToString("F3", CultureInfo.InvariantCulture));
        }
        sb.Append("}");
        return sb.ToString();
    }

    /**
     * Sets the fade-in and fade-out lengths of one event. Arguments: <track>|<event>|<fadeInMs>|<fadeOutMs>.
     * The two fades may not overlap.
     */
    private static string SetFades(string args)
    {
        var p = args.Split('|');
        if (p.Length != 4)
        {
            return Error("usage: fade <trackIndex>|<eventIndex>|<fadeInMs>|<fadeOutMs>");
        }
        var ev = FindEvent(int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture));
        var fadeIn = double.Parse(p[2], CultureInfo.InvariantCulture);
        var fadeOut = double.Parse(p[3], CultureInfo.InvariantCulture);
        if (fadeIn < 0 || fadeOut < 0)
        {
            return Error("fade lengths cannot be negative");
        }
        if (fadeIn + fadeOut > ev.Length.ToMilliseconds())
        {
            return Error("the two fades together are longer than the event");
        }

        using (new UndoBlock(vegasRef.Project, "vegas-mcp fades"))
        {
            ev.FadeIn.Length = new Timecode(fadeIn);
            ev.FadeOut.Length = new Timecode(fadeOut);
        }
        return AudioInfo(int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture));
    }

    /** Turns audio normalisation on or off for one audio event. Arguments: <track>|<event>|<on|off>. */
    private static string SetNormalize(string args)
    {
        var p = args.Split('|');
        if (p.Length != 3)
        {
            return Error("usage: normalize <trackIndex>|<eventIndex>|<on|off>");
        }
        int trackIndex = int.Parse(p[0], CultureInfo.InvariantCulture);
        int eventIndex = int.Parse(p[1], CultureInfo.InvariantCulture);
        var audio = FindEvent(trackIndex, eventIndex) as AudioEvent;
        if (audio == null)
        {
            return Error("that event is not an audio event");
        }
        var on = p[2] == "on" || p[2] == "1";

        using (new UndoBlock(vegasRef.Project, "vegas-mcp normalize"))
        {
            audio.Normalize = on;
            if (on)
            {
                audio.RecalculateNorm();
            }
        }
        return AudioInfo(trackIndex, eventIndex);
    }

    /**
     * The events that play the same stretch of the same clip. A group holds every piece of the
     * original clip, so only members that start where this event starts belong to it: its video
     * or audio counterpart.
     */
    private static List<TrackEvent> SameStartMembers(TrackEvent ev)
    {
        var members = new List<TrackEvent>();
        double start = ev.Start.ToMilliseconds();
        if (!ev.IsGrouped)
        {
            members.Add(ev);
            return members;
        }
        int groupSize = ev.Group.Count;
        for (int i = 0; i < groupSize; i++)
        {
            var member = ev.Group[i];
            if (Math.Abs(member.Start.ToMilliseconds() - start) < 1.0)
            {
                members.Add(member);
            }
        }
        if (members.Count == 0)
        {
            members.Add(ev);
        }
        return members;
    }

    /** True when an event plays the given media file. Used so a speed change only touches its own clip. */
    private static bool SameSource(TrackEvent ev, string source)
    {
        var take = ev.ActiveTake;
        return take != null && source != null && string.Equals(take.MediaPath, source, StringComparison.OrdinalIgnoreCase);
    }

    /**
     * Speeds up a clip and its audio counterpart, and shortens it on the timeline.
     * Arguments: <track>|<event>|<rate>, with rate 1 to 10. Rate 2 plays twice as fast and halves
     * the clip. The clip is cut at its new end, the cut-off tail of the same media is removed, and
     * the events after the clip move back to close the gap. Then the head is sped up through
     * AdjustPlaybackRate, which keeps the head's length and stretches the media it plays. The whole
     * change is one undo step, so Ctrl+Z reverts all of it.
     *
     * Measured on VEGAS 2026.0.3 (189): setting PlaybackRate on its own rendered black and silent,
     * and AdjustPlaybackRate keeps the event's length, so it has to be applied to a clip that is
     * already cut to its new length. Hence the cut comes first.
     */
    private static string SetSpeed(string args)
    {
        var p = args.Split('|');
        if (p.Length != 3)
        {
            return Error("usage: speed <trackIndex>|<eventIndex>|<rate>");
        }
        var ev = FindEvent(int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture));
        var rate = double.Parse(p[2], CultureInfo.InvariantCulture);
        if (!(rate >= 1 && rate <= 10))
        {
            return Error("speed-up rates are 1 to 10; undo a speed change with Ctrl+Z in VEGAS");
        }
        if (Math.Abs(ev.PlaybackRate - 1.0) > 0.001)
        {
            return Error("this clip already has a speed change; undo it with Ctrl+Z in VEGAS first");
        }

        double start = ev.Start.ToMilliseconds();
        double oldEnd = start + ev.Length.ToMilliseconds();
        double cutAt = start + (oldEnd - start) / rate;
        double delta = oldEnd - cutAt;
        string source = ev.ActiveTake != null ? ev.ActiveTake.MediaPath : null;
        int splits = 0;
        int removed = 0;
        int changed = 0;
        int moved = 0;
        double newLength = 0;
        double takeOffset = 0;

        using (new UndoBlock(vegasRef.Project, "vegas-mcp speed"))
        {
            // Only this clip's own pieces are cut, so other tracks keep their cuts.
            foreach (TrackEvent member in SameStartMembers(ev))
            {
                if (Contains(member, cutAt))
                {
                    member.Split(new Timecode(cutAt - member.Start.ToMilliseconds()));
                    splits++;
                }
            }

            foreach (Track track in vegasRef.Project.Tracks)
            {
                foreach (TrackEvent other in new List<TrackEvent>(track.Events))
                {
                    double s = other.Start.ToMilliseconds();
                    if (other.IsGrouped && s >= cutAt - 0.5 && s < oldEnd - 0.5 && SameSource(other, source))
                    {
                        track.Events.Remove(other);
                        removed++;
                    }
                }
            }

            foreach (TrackEvent member in SameStartMembers(ev))
            {
                member.AdjustPlaybackRate(rate, false);
                changed++;
            }

            foreach (Track track in vegasRef.Project.Tracks)
            {
                foreach (TrackEvent other in new List<TrackEvent>(track.Events))
                {
                    if (other.Start.ToMilliseconds() >= oldEnd - 0.5)
                    {
                        other.Start = new Timecode(other.Start.ToMilliseconds() - delta);
                        moved++;
                    }
                }
            }

            newLength = ev.Length.ToMilliseconds();
            takeOffset = ev.ActiveTake != null ? ev.ActiveTake.Offset.ToMilliseconds() : 0;
        }
        return "{\"ok\": true, \"rate\": " + rate.ToString("F3", CultureInfo.InvariantCulture)
            + ", \"splits\": " + splits
            + ", \"tailPiecesRemoved\": " + removed
            + ", \"eventsChanged\": " + changed
            + ", \"eventsMoved\": " + moved
            + ", \"lengthMs\": " + Num(newLength)
            + ", \"rippleMs\": " + Num(delta)
            + ", \"takeOffsetMs\": " + Num(takeOffset) + "}";
    }

    /**
     * Undoes the last change VEGAS recorded (Project.Undo). A test helper for the bridge's own
     * changes. The MCP server does not expose it, because it would also undo a change made by hand.
     */
    private static string Undo()
    {
        vegasRef.Project.Undo();
        return "{\"ok\": true, \"undone\": true}";
    }

    /** Reads the motion settings of a video event, and the first keyframe's frame and rotation. Changes nothing. */
    private static string MotionInfo(string args)
    {
        var p = args.Split('|');
        if (p.Length != 2)
        {
            return Error("usage: motion_info <trackIndex>|<eventIndex>");
        }
        var ev = FindEvent(int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture)) as VideoEvent;
        if (ev == null)
        {
            return Error("that event is not a video event");
        }
        var motion = ev.VideoMotion;
        var sb = new StringBuilder();
        sb.Append("{\"ok\": true, \"scaleToFill\": " + (motion.ScaleToFill ? "true" : "false"));
        int count = motion.Keyframes.Count;
        sb.Append(", \"keyframes\": " + count);
        if (count > 0)
        {
            var kf = motion.Keyframes[0];
            sb.Append(", \"firstKeyframe\": {\"topLeft\": " + Vertex(kf.TopLeft.X, kf.TopLeft.Y)
                + ", \"topRight\": " + Vertex(kf.TopRight.X, kf.TopRight.Y)
                + ", \"bottomRight\": " + Vertex(kf.BottomRight.X, kf.BottomRight.Y)
                + ", \"bottomLeft\": " + Vertex(kf.BottomLeft.X, kf.BottomLeft.Y)
                + ", \"rotationRad\": " + kf.Rotation.ToString("F4", CultureInfo.InvariantCulture) + "}");
        }
        sb.Append("}");
        return sb.ToString();
    }

    /** Turns "scale to fill" on or off for a video event. Arguments: <track>|<event>|<on|off>. */
    private static string SetScaleToFill(string args)
    {
        var p = args.Split('|');
        if (p.Length != 3)
        {
            return Error("usage: motion_fill <trackIndex>|<eventIndex>|<on|off>");
        }
        var ev = FindEvent(int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture)) as VideoEvent;
        if (ev == null)
        {
            return Error("that event is not a video event");
        }
        using (new UndoBlock(vegasRef.Project, "vegas-mcp scale to fill"))
        {
            ev.VideoMotion.ScaleToFill = p[2] == "on" || p[2] == "1";
        }
        return MotionInfo(p[0] + "|" + p[1]);
    }

    /**
     * Places a video clip in the frame. Its box becomes scale times the project frame, centred at the
     * frame centre moved by moveX and moveY, in project pixels (positive moves right and down). The
     * result does not depend on earlier moves, so calling it again sets the placement again.
     * Arguments: <track>|<event>|<scale>|<moveX>|<moveY>. Scale to fill is turned off first, because
     * it would replace the keyframes. One undo step. Rotated keyframes are refused.
     */
    private static string SetMotion(string args)
    {
        var p = args.Split('|');
        if (p.Length != 5)
        {
            return Error("usage: motion <trackIndex>|<eventIndex>|<scale>|<moveX>|<moveY>");
        }
        var ev = FindEvent(int.Parse(p[0], CultureInfo.InvariantCulture), int.Parse(p[1], CultureInfo.InvariantCulture)) as VideoEvent;
        if (ev == null)
        {
            return Error("that event is not a video event");
        }
        var scale = double.Parse(p[2], CultureInfo.InvariantCulture);
        var moveX = double.Parse(p[3], CultureInfo.InvariantCulture);
        var moveY = double.Parse(p[4], CultureInfo.InvariantCulture);
        if (!(scale >= 0.1 && scale <= 10))
        {
            return Error("scale must be between 0.1 and 10");
        }

        // Check every keyframe before changing any, so a refusal leaves the clip as it was.
        var motion = ev.VideoMotion;
        for (int i = 0; i < motion.Keyframes.Count; i++)
        {
            var check = motion.Keyframes[i];
            if (Math.Abs(check.Rotation) > 0.000001)
            {
                return Error("this clip is rotated; set its rotation back to 0 first");
            }
            if (!(check.BottomRight.X - check.TopLeft.X > 0) || !(check.BottomRight.Y - check.TopLeft.Y > 0))
            {
                return Error("a keyframe of this clip has no size");
            }
        }

        double frameW = vegasRef.Project.Video.Width;
        double frameH = vegasRef.Project.Video.Height;
        int changed = 0;
        using (new UndoBlock(vegasRef.Project, "vegas-mcp motion"))
        {
            motion.ScaleToFill = false;
            for (int i = 0; i < motion.Keyframes.Count; i++)
            {
                var kf = motion.Keyframes[i];
                double w0 = kf.BottomRight.X - kf.TopLeft.X;
                double h0 = kf.BottomRight.Y - kf.TopLeft.Y;
                double cx0 = (kf.TopLeft.X + kf.BottomRight.X) / 2.0;
                double cy0 = (kf.TopLeft.Y + kf.BottomRight.Y) / 2.0;
                // Move the box centre to the origin, scale it to the target size, then move it to the target centre.
                kf.MoveBy(new VideoMotionVertex((float)(-cx0), (float)(-cy0)));
                kf.ScaleBy(new VideoMotionVertex((float)(frameW * scale / w0), (float)(frameH * scale / h0)));
                kf.MoveBy(new VideoMotionVertex((float)(frameW / 2.0 + moveX), (float)(frameH / 2.0 + moveY)));
                changed++;
            }
        }
        return "{\"ok\": true, \"keyframesChanged\": " + changed
            + ", \"projectWidth\": " + Num(frameW) + ", \"projectHeight\": " + Num(frameH)
            + ", \"after\": " + MotionInfo(p[0] + "|" + p[1]) + "}";
    }

    /** Adds a time line marker. Arguments: <timeMs>|<label>. Markers do not change the picture or the sound. */
    private static string AddMarker(string args)
    {
        var p = args.Split(new[] { '|' }, 2);
        if (p.Length != 2)
        {
            return Error("usage: marker_add <timeMs>|<label>");
        }
        var timeMs = double.Parse(p[0], CultureInfo.InvariantCulture);
        if (timeMs < 0)
        {
            return Error("a marker needs a time of 0 or more");
        }
        using (new UndoBlock(vegasRef.Project, "vegas-mcp marker"))
        {
            vegasRef.Project.Markers.Add(new Marker(new Timecode(timeMs), p[1]));
        }
        return "{\"ok\": true, \"count\": " + vegasRef.Project.Markers.Count + "}";
    }

    /** Lists the time line markers with their index, their position in ms and their label. Changes nothing. */
    private static string ListMarkers()
    {
        var sb = new StringBuilder();
        sb.Append("{\"ok\": true, \"markers\": [");
        var markers = vegasRef.Project.Markers;
        for (int i = 0; i < markers.Count; i++)
        {
            if (i > 0) sb.Append(", ");
            sb.Append("{\"index\": " + i
                + ", \"positionMs\": " + Num(markers[i].Position.ToMilliseconds())
                + ", \"label\": " + Quote(markers[i].Label) + "}");
        }
        sb.Append("]}");
        return sb.ToString();
    }

    /** Removes one time line marker, by the index that marker_list reports. Arguments: <index>. */
    private static string RemoveMarker(string args)
    {
        var index = int.Parse(args.Trim(), CultureInfo.InvariantCulture);
        var markers = vegasRef.Project.Markers;
        if (index < 0 || index >= markers.Count)
        {
            return Error("no marker at index " + index);
        }
        using (new UndoBlock(vegasRef.Project, "vegas-mcp marker"))
        {
            markers.RemoveAt(index);
        }
        return "{\"ok\": true, \"count\": " + markers.Count + "}";
    }

    private static string Vertex(double x, double y)
    {
        return "[" + x.ToString("F2", CultureInfo.InvariantCulture) + ", " + y.ToString("F2", CultureInfo.InvariantCulture) + "]";
    }

    /** Lists every render template as "Renderer :: Template", the form render expects. */
    private static string RenderTemplates()
    {
        var sb = new StringBuilder();
        sb.Append("{\"ok\": true, \"templates\": [");
        bool first = true;
        foreach (Renderer renderer in vegasRef.Renderers)
        {
            foreach (RenderTemplate template in renderer.Templates)
            {
                if (!first) sb.Append(", ");
                first = false;
                sb.Append(Quote(renderer.Name + " :: " + template.Name));
            }
        }
        sb.Append("]}");
        return sb.ToString();
    }

    /**
     * Renders the whole project. Arguments: <Renderer :: Template>|<outputPath>. Never overwrites
     * an existing file. The render runs on VEGAS's thread, so the bridge does not answer until
     * it finishes.
     */
    private static string Render(string args)
    {
        var parts = args.Split('|');
        if (parts.Length != 2)
        {
            return Error("usage: render <Renderer :: Template>|<outputPath>");
        }
        var names = parts[0].Split(new[] { " :: " }, StringSplitOptions.None);
        if (names.Length != 2)
        {
            return Error("use the 'Renderer :: Template' name from render_templates");
        }
        var outputPath = parts[1];
        if (File.Exists(outputPath))
        {
            return Error("output already exists; choose another path: " + outputPath);
        }

        RenderTemplate chosen = null;
        foreach (Renderer renderer in vegasRef.Renderers)
        {
            if (renderer.Name != names[0]) continue;
            foreach (RenderTemplate template in renderer.Templates)
            {
                if (template.Name == names[1]) { chosen = template; break; }
            }
            if (chosen != null) break;
        }
        if (chosen == null)
        {
            return Error("render template not found: " + parts[0]);
        }

        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        vegasRef.Project.Render(outputPath, chosen);
        return "{\"ok\": true, \"outputPath\": " + Quote(outputPath) + ", \"written\": " + (File.Exists(outputPath) ? "true" : "false") + "}";
    }

    /**
     * Copies the project file as it is on disk into %APPDATA%\vegas-mcp\backups. Changes that
     * are not saved yet are not in that copy; the reply says so when the project is modified.
     */
    private static string Backup()
    {
        var source = vegasRef.Project.FilePath;
        if (string.IsNullOrEmpty(source) || !File.Exists(source))
        {
            return Error("the project has not been saved to a file yet; save it once in VEGAS, then try again");
        }

        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "vegas-mcp", "backups");
        Directory.CreateDirectory(dir);
        var name = Path.GetFileNameWithoutExtension(source) + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + Path.GetExtension(source);
        var destination = Path.Combine(dir, name);
        File.Copy(source, destination, false);

        return "{\"ok\": true, \"backupPath\": " + Quote(destination)
            + ", \"projectModified\": " + (vegasRef.Project.IsModified ? "true" : "false") + "}";
    }

    private static string Timeline()
    {
        var sb = new StringBuilder();
        sb.Append("{\"ok\": true, \"tracks\": [");
        int trackIndex = 0;
        foreach (Track track in vegasRef.Project.Tracks)
        {
            if (trackIndex > 0) sb.Append(", ");
            sb.Append("{\"index\": " + trackIndex + ", \"type\": " + Quote(track is VideoTrack ? "video" : track is AudioTrack ? "audio" : "other") + ", \"events\": [");
            int eventIndex = 0;
            foreach (TrackEvent ev in track.Events)
            {
                if (eventIndex > 0) sb.Append(", ");
                // The take's offset is the media time that plays at the event's start. Speech
                // timestamps are media time, so this is what maps them onto the timeline.
                var take = ev.ActiveTake;
                sb.Append("{\"index\": " + eventIndex
                    + ", \"startMs\": " + Num(ev.Start.ToMilliseconds())
                    + ", \"lengthMs\": " + Num(ev.Length.ToMilliseconds())
                    + ", \"grouped\": " + (ev.IsGrouped ? "true" : "false")
                    + ", \"takeOffsetMs\": " + (take == null ? "0.0" : Num(take.Offset.ToMilliseconds()))
                    + ", \"mediaPath\": " + Quote(take == null ? null : take.MediaPath) + "}");
                eventIndex++;
            }
            sb.Append("]}");
            trackIndex++;
        }
        sb.Append("]}");
        return sb.ToString();
    }

    /**
     * Splits the event at trackIndex/eventIndex, offsetMs into it. A grouped event (video
     * plus audio) is split member by member, so both sides stay cut together.
     */
    private static string Split(int trackIndex, int eventIndex, double offsetMs)
    {
        var track = vegasRef.Project.Tracks[trackIndex];
        var ev = track.Events[eventIndex];
        var offset = new Timecode(offsetMs);

        if (offset.ToMilliseconds() <= 0 || offset.ToMilliseconds() >= ev.Length.ToMilliseconds())
        {
            return Error("offset must fall inside the event");
        }

        int splits;
        using (new UndoBlock(vegasRef.Project, "vegas-mcp split"))
        {
            splits = SplitEventAt(ev, ev.Start.ToMilliseconds() + offset.ToMilliseconds());
        }
        return "{\"ok\": true, \"splits\": " + splits + "}";
    }

    /**
     * Removes [startMs, endMs) from every track and closes the gap. Both edges are split first,
     * on every track, so the removed pieces line up exactly. Events after the gap move left by
     * its length, on every track, so video and audio stay in step.
     */
    private static string RemoveRange(double startMs, double endMs)
    {
        if (!(startMs >= 0) || !(endMs > startMs))
        {
            return Error("range must satisfy 0 <= startMs < endMs");
        }
        double gap = endMs - startMs;
        int removed = 0;
        int shifted = 0;

        using (new UndoBlock(vegasRef.Project, "vegas-mcp remove range"))
        {
            SplitAt(startMs);
            SplitAt(endMs);

            foreach (Track track in vegasRef.Project.Tracks)
            {
                foreach (TrackEvent ev in new List<TrackEvent>(track.Events))
                {
                    double evStart = ev.Start.ToMilliseconds();
                    if (evStart >= startMs - 0.5 && evStart + ev.Length.ToMilliseconds() <= endMs + 0.5)
                    {
                        track.Events.Remove(ev);
                        removed++;
                    }
                }
            }

            foreach (Track track in vegasRef.Project.Tracks)
            {
                foreach (TrackEvent ev in new List<TrackEvent>(track.Events))
                {
                    double evStart = ev.Start.ToMilliseconds();
                    if (evStart >= endMs - 0.5)
                    {
                        ev.Start = new Timecode(evStart - gap);
                        shifted++;
                    }
                }
            }
        }
        return "{\"ok\": true, \"removedMs\": " + Num(gap) + ", \"removedEvents\": " + removed + ", \"shiftedEvents\": " + shifted + "}";
    }

    /**
     * Splits every event that strictly contains timelineMs, on every track. Grouped events split
     * together. Each split is checked against the current position of the event, so a piece that
     * already starts or ends at timelineMs is left alone.
     */
    private static void SplitAt(double timelineMs)
    {
        foreach (Track track in vegasRef.Project.Tracks)
        {
            foreach (TrackEvent ev in new List<TrackEvent>(track.Events))
            {
                if (Contains(ev, timelineMs))
                {
                    SplitEventAt(ev, timelineMs);
                }
            }
        }
    }

    /**
     * Splits one event at a timeline position. A group holds every piece of the original clip,
     * not only the one being cut, so each member is split only if it contains the position itself.
     */
    private static int SplitEventAt(TrackEvent ev, double timelineMs)
    {
        int splits = 0;
        if (ev.IsGrouped)
        {
            var members = new List<TrackEvent>();
            int groupSize = ev.Group.Count;
            for (int i = 0; i < groupSize; i++)
            {
                members.Add(ev.Group[i]);
            }
            foreach (TrackEvent member in members)
            {
                if (Contains(member, timelineMs))
                {
                    member.Split(new Timecode(timelineMs - member.Start.ToMilliseconds()));
                    splits++;
                }
            }
        }
        else
        {
            ev.Split(new Timecode(timelineMs - ev.Start.ToMilliseconds()));
            splits = 1;
        }
        return splits;
    }

    /** True when the event strictly contains the position, with half a millisecond of slack at the edges. */
    private static bool Contains(TrackEvent ev, double timelineMs)
    {
        double start = ev.Start.ToMilliseconds();
        return timelineMs > start + 0.5 && timelineMs < start + ev.Length.ToMilliseconds() - 0.5;
    }

    private static string NewToken()
    {
        var bytes = new byte[24];
        using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(bytes);
        return Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    private static string Error(string message)
    {
        return "{\"ok\": false, \"error\": " + Quote(message) + "}";
    }

    private static string Num(double value)
    {
        return value.ToString("F1", CultureInfo.InvariantCulture);
    }

    private static string Quote(string value)
    {
        if (value == null) return "null";
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\"";
    }

    private static void WriteStatus(string state, string detail)
    {
        var json = "{\"state\": " + Quote(state) + ", \"detail\": " + Quote(detail) + "}\n";
        File.WriteAllText(statusPath, json, new UTF8Encoding(false));
    }
}
