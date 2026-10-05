#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderOverlay } from "./remotion/bridge.js";
import { prepareSubtitles } from "./workflows/srt.js";
import { findSpeechCuts, listAudioTracks, readWords, readWordsSource, transcribeSpeech } from "./workflows/speech.js";
import { cuesForClip, wordsToCues } from "./captions/cues.js";
import { CAPTION_STYLE_HELP, CAPTION_STYLES } from "./captions/styles.js";
import { renderCaptions } from "./remotion/captions.js";
import { sendBridgeCommand } from "./vegas/bridge.js";
import { avDifferenceMs, defaultRenderPath, inspectContent, probeDurations, probeVideoSize } from "./vegas/render.js";
import { buildSheet, defaultSheetPath } from "./vegas/preview.js";
import { logAction } from "./log/actions.js";
import { fadeNormalizeConflict, type AudioState } from "./vegas/audio.js";
import {
  PlanStore,
  expectedLengthAfter,
  mergeTimelineCuts,
  removalOrder,
  selectClips,
  snapCutsToFrames,
  timelineFingerprint,
  toTimelineCuts,
} from "./vegas/plan.js";

/**
 * vegas-mcp — independent, unofficial. Not affiliated with MAGIX.
 *
 * Phase 1 writes nothing into a VEGAS project. It renders overlays and prepares subtitle
 * files; the editor places them. Timeline control waits on a verified scripting bridge.
 */

const server = new McpServer({ name: "vegas-mcp", version: "0.1.0" });

/**
 * Turns failures into a tool result the model can act on, not a stack trace.
 * Only a non-Error throw is genuinely unexpected.
 */
const asToolResult = (fn: () => unknown) => {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(fn(), null, 2) }] };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Unexpected failure: ${String(error)}`;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
};

/** Same as asToolResult, for tools that wait on VEGAS. */
const asyncToolResult = async (fn: () => Promise<unknown>) => {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Unexpected failure: ${String(error)}`;
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
};

/** asyncToolResult, plus one line in out/actions.log for the call. */
const asyncLogged = async (tool: string, fn: () => Promise<unknown>) => {
  const result = await asyncToolResult(fn);
  logAction({ tool, ok: !result.isError, summary: result.content[0]?.text.slice(0, 240) });
  return result;
};

const plans = new PlanStore();

/** Reads an event's current fades and normalisation from VEGAS, for the conflict check. */
const readAudioState = async (trackIndex: number, eventIndex: number): Promise<AudioState> => {
  const info = await sendBridgeCommand(`audio_info ${trackIndex} ${eventIndex}`);
  return {
    fadeInMs: Number(info.fadeInMs ?? 0),
    fadeOutMs: Number(info.fadeOutMs ?? 0),
    normalize: info.normalize === true,
  };
};

type TimelineEvent = {
  index: number;
  startMs: number;
  lengthMs: number;
  grouped: boolean;
  takeOffsetMs: number;
  mediaPath?: string;
};
type Timeline = { tracks: Array<{ index: number; type: string; events: TimelineEvent[] }> };

/** Reads the live timeline from VEGAS and returns it with its fingerprint. */
const readTimeline = async (): Promise<{ timeline: Timeline; fingerprint: string }> => {
  const timeline = (await sendBridgeCommand("timeline")) as unknown as Timeline;
  return { timeline, fingerprint: timelineFingerprint(timeline) };
};

const overlayShape = {
  text: z.string().describe("Headline"),
  subtitle: z.string().optional(),
  kind: z
    .enum(["lower-third", "title-card", "callout"])
    .optional()
    .describe("lower-third: name bar, bottom left. title-card: centred statement. callout: pill badge."),
  accentColor: z.string().optional().describe("#RRGGBB, defaults to #C6FF34"),
  textColor: z.string().optional().describe("#RRGGBB, defaults to #FFFFFF"),
  width: z.number().optional().describe("Defaults to 1080"),
  height: z.number().optional().describe("Defaults to 1920"),
  fps: z.number().optional().describe("Defaults to 30"),
  durationSeconds: z.number().optional().describe("Defaults to 3"),
  exitAtSeconds: z.number().optional().describe("When the element animates out"),
};

server.registerTool(
  "render_overlay",
  {
    title: "Render a transparent motion-graphics overlay",
    description:
      "Renders an animated overlay with a real alpha channel (ProRes 4444, yuva444p12le) using Remotion. Returns the .mov path to import into VEGAS Pro and place on a track above the footage. Requires ffmpeg. Rendering takes tens of seconds.",
    inputSchema: {
      ...overlayShape,
      outputPath: z.string().optional().describe("Absolute .mov path; defaults to <package>/out/"),
    },
  },
  async (args) => asToolResult(() => renderOverlay(args)),
);

server.registerTool(
  "prepare_subtitles",
  {
    title: "Normalise an SRT for import into VEGAS Pro",
    description:
      "Reads an SRT file or raw SRT text, validates every cue, optionally shifts all timings, and writes a clean UTF-8 .srt for VEGAS Pro to import. Styling is not carried by SRT; apply it inside VEGAS.",
    inputSchema: {
      path: z.string().optional().describe("Path to an .srt file"),
      content: z.string().optional().describe("Raw SRT text, instead of a file"),
      timeOffsetSeconds: z.number().optional().describe("Shifts every cue; negative moves earlier"),
      outputPath: z.string().describe("Absolute path for the normalised .srt"),
    },
  },
  async (args) => asToolResult(() => prepareSubtitles(args)),
);

server.registerTool(
  "transcribe_speech",
  {
    title: "Transcribe speech locally with word timestamps",
    description:
      "Extracts audio with ffmpeg and transcribes it on this machine with faster-whisper, keeping stutters and repeats so find_speech_cuts can see them. Writes <name>.words.json to out/ and never changes the source file. Slow on long media: CPU transcription takes a fraction of the clip's length or more.",
    inputSchema: {
      path: z.string().describe("Absolute path to a video or audio file"),
      outputDir: z.string().optional().describe("Where to write the WAV and JSON; defaults to <package>/out/"),
      audioTrack: z.number().int().min(0).optional().describe("Audio track to transcribe, 0-based. Run list_audio_tracks first when a file has several. Defaults to 0"),
      model: z.string().optional().describe("Whisper size: tiny, base, small, medium or large-v3. Defaults to small"),
      language: z.string().optional().describe("ISO code such as pt. Omit to detect"),
      verbatim: z.boolean().optional().describe("Keep stutters and fillers. Defaults to true"),
    },
  },
  async (args) => asToolResult(() => transcribeSpeech(args)),
);

server.registerTool(
  "list_audio_tracks",
  {
    title: "List the audio tracks of a media file",
    description:
      "Lists each audio track with its codec, channel count, sample rate, and language or title when present. Use the 0-based index with transcribe_speech's audioTrack. Read-only.",
    inputSchema: {
      path: z.string().describe("Absolute path to a video or audio file"),
    },
  },
  async (args) => asToolResult(() => ({ tracks: listAudioTracks(args.path) })),
);

server.registerTool(
  "find_speech_cuts",
  {
    title: "Find pauses and repeated takes in a transcript",
    description:
      "Reads a .words.json from transcribe_speech and lists the ranges to cut: silences longer than minPauseMs, stutters (a word or phrase said twice in a row, keeping the last take), and restarts (a sentence of restartSpanWords words said again later, cutting the failed first take). Each cut includes the words it removes, for review. Nothing is edited.",
    inputSchema: {
      wordsPath: z.string().describe("Absolute path to a .words.json file"),
      audioPath: z.string().optional().describe("The .speech.wav from transcribe_speech; when given, silences measured in the audio are cut too"),
      minPauseMs: z.number().optional().describe("Silences at least this long are cut. Defaults to 700"),
      pausePaddingMs: z.number().optional().describe("Breathing room kept at each edge of a cut pause. Defaults to 250"),
      maxRepeatWords: z.number().optional().describe("Longest repeated phrase in a stutter, in words. Defaults to 6"),
      maxRepeatGapMs: z.number().optional().describe("Stutter copies further apart than this are not repeats. Defaults to 4000"),
      restartSpanWords: z.number().optional().describe("Words that must come back to count as a restart. Defaults to 6; 0 turns restarts off"),
      restartWindowWords: z.number().optional().describe("How many words after a take the second copy may start. Defaults to 30"),
    },
  },
  async (args) => asToolResult(() => findSpeechCuts(args)),
);

server.registerTool(
  "vegas_status",
  {
    title: "Check that VEGAS and the bridge are reachable",
    description:
      "Asks the running VEGAS bridge for the open project's track count and length. Requires VEGAS Pro 2026 open with Tools > Scripting > Bridge running. Read-only.",
    inputSchema: {},
  },
  async () => asyncToolResult(() => sendBridgeCommand("status")),
);

server.registerTool(
  "vegas_list_timeline",
  {
    title: "Read the VEGAS timeline",
    description:
      "Lists every track and event of the open VEGAS project with start, length and whether it is grouped (video with its audio). Track and event indexes here are the ones vegas_plan_cuts works on. Read-only.",
    inputSchema: {},
  },
  async () => asyncToolResult(() => sendBridgeCommand("timeline")),
);

server.registerTool(
  "vegas_plan_cuts",
  {
    title: "Plan speech cuts for a VEGAS clip (nothing is changed)",
    description:
      "Turns the cuts from find_speech_cuts into timeline positions for one clip, and stores them as a plan. Tell it where the clip starts on the timeline, how long it is, and the media time that plays at its start. Returns a planId. Nothing in VEGAS changes until vegas_apply_cuts is called with that planId, and only after the user approves the cut list.",
    inputSchema: {
      wordsPath: z.string().describe("Absolute path to a .words.json file"),
      audioPath: z.string().optional().describe("The .speech.wav from transcribe_speech; when given, silences measured in the audio are cut too"),
      trackIndex: z.number().int().min(0).optional().describe("Optional: track of one specific clip. Leave out to use every video clip that plays the transcribed media"),
      eventIndex: z.number().int().min(0).optional().describe("Optional: event on that track, used with trackIndex"),
      fps: z.number().positive().optional().describe("Project frame rate; cuts snap inward to its frames. Defaults to 30"),
      minPauseMs: z.number().optional(),
      pausePaddingMs: z.number().optional(),
      maxRepeatWords: z.number().optional(),
      maxRepeatGapMs: z.number().optional(),
      restartSpanWords: z.number().optional(),
      restartWindowWords: z.number().optional(),
    },
  },
  async ({ wordsPath, trackIndex, eventIndex, fps, ...detect }) =>
    asyncLogged("vegas_plan_cuts", async () => {
      // Clips are found by the media they play, so the plan survives tracks being added above.
      const { timeline, fingerprint } = await readTimeline();
      const selected = selectClips(timeline, readWordsSource(wordsPath), trackIndex, eventIndex);

      // One transcript can cover several events of the same media. Each event maps its own part.
      const found = findSpeechCuts({ wordsPath, ...detect });
      const mappedPerClip = selected.map(({ clip }) =>
        toTimelineCuts(found.cuts, {
          eventStartMs: clip.startMs,
          eventLengthMs: clip.lengthMs,
          sourceOffsetMs: clip.takeOffsetMs,
        }),
      );
      const merged = mergeTimelineCuts(mappedPerClip.flatMap((m) => m.cuts));
      const skipped = mappedPerClip.reduce((sum, m) => sum + m.skipped, 0);

      // Snap to the project's frames so every cut lands on a frame boundary of the timeline.
      const snapped = snapCutsToFrames(merged, fps ?? 30);
      const plan = plans.create(snapped.cuts, fingerprint);
      return {
        planId: plan.id,
        expiresAt: new Date(plan.expiresAt).toISOString(),
        clips: selected.map(({ trackIndex: t, clip }) => ({ trackIndex: t, eventIndex: clip.index, startMs: clip.startMs })),
        cuts: snapped.cuts,
        count: snapped.cuts.length,
        skippedOutsideClip: skipped,
        droppedAfterFrameSnap: snapped.dropped,
        totalCutMs: snapped.cuts.reduce((sum, c) => sum + (c.endMs - c.startMs), 0),
        note: "Nothing in VEGAS has changed. Show these cuts to the user; apply only with their approval, using vegas_apply_cuts and this planId.",
      };
    }),
);

server.registerTool(
  "vegas_apply_cuts",
  {
    title: "Apply an approved cut plan to the VEGAS timeline",
    description:
      "Removes the cuts of a plan from the open VEGAS project, latest first, closing each gap on every track so video and audio stay together. Only works with a planId from vegas_plan_cuts, once, and within 30 minutes. Each cut is its own undo step in VEGAS. Call only after the user has approved the cut list.",
    inputSchema: {
      planId: z.string().describe("The planId returned by vegas_plan_cuts"),
    },
  },
  async ({ planId }) =>
    asyncLogged("vegas_apply_cuts", async () => {
      // Refuse before consuming the plan. The backup copies the saved file, so unsaved work
      // would be missing from it. The plan stays valid for a later attempt.
      const before = await sendBridgeCommand("status");
      if (before.projectModified === true) {
        throw new Error(
          "Save the project in VEGAS (File > Save) before applying cuts. The backup copies the saved file, so unsaved changes would be missing from it. The plan is still valid.",
        );
      }

      const plan = plans.take(planId);

      // The cut positions are only valid for the timeline they were planned on.
      const { fingerprint } = await readTimeline();
      if (fingerprint !== plan.fingerprint) {
        throw new Error("The VEGAS timeline changed since this plan was made. Nothing was cut. Create a new plan with vegas_plan_cuts.");
      }

      const expectedLengthMs = expectedLengthAfter(Number(before.projectLengthMs), plan.cuts);

      // Back up the saved project before the first cut. If the backup fails, nothing changes.
      const backup = await sendBridgeCommand("backup");
      const backupPath = String(backup.backupPath);

      const applied: Array<{ startMs: number; endMs: number }> = [];
      for (const cut of removalOrder(plan.cuts)) {
        try {
          await sendBridgeCommand(`remove ${cut.startMs} ${cut.endMs}`, { timeoutMs: 60_000 });
          applied.push({ startMs: cut.startMs, endMs: cut.endMs });
        } catch (error) {
          return {
            ok: false,
            backupPath,
            applied,
            failedCut: { startMs: cut.startMs, endMs: cut.endMs },
            error: error instanceof Error ? error.message : String(error),
            note: "Stopped at the failed cut. Earlier cuts stay applied; undo them in VEGAS with Ctrl+Z, or restore the backup.",
            _operation: {
              status: "partial",
              verification: null,
              changes: applied,
              warnings: ["Stopped at the failed cut; the timeline was not verified."],
            },
          };
        }
      }
      // Read the length back from VEGAS. A mismatch is reported, never assumed to be fine.
      const after = await sendBridgeCommand("status");
      const actualLengthMs = Number(after.projectLengthMs);
      const lengthOk = Math.abs(actualLengthMs - expectedLengthMs) <= 2;
      return {
        ok: true,
        backupPath,
        applied,
        _operation: {
          status: lengthOk ? "success" : "unverified",
          verification: { expectedLengthMs, actualLengthMs, lengthOk },
          changes: applied,
          warnings: lengthOk
            ? []
            : ["The timeline length does not match what the cuts should produce. Check the timeline in VEGAS before going on."],
        },
        note: "Each cut is one undo step in VEGAS. The source media was not changed. The backup holds the project as saved before these cuts.",
      };
    }),
);

server.registerTool(
  "vegas_insert_overlay",
  {
    title: "Place a clip as an overlay on a new VEGAS track",
    description:
      "Adds a new video track at the top of the open VEGAS project and places a clip on it, starting at startMs for lengthMs. Use it with render_overlay output (alpha channel) to put a lower third or title over the footage. Changes the project; undo with Ctrl+Z in VEGAS.",
    inputSchema: {
      path: z.string().describe("Absolute path to the clip, such as a render_overlay .mov"),
      startMs: z.number().min(0).describe("Where on the timeline the overlay starts, in ms"),
      lengthMs: z.number().positive().describe("How long the overlay stays, in ms"),
    },
  },
  async ({ path, startMs, lengthMs }) =>
    asyncLogged("vegas_insert_overlay", () => sendBridgeCommand(`overlay ${path}|${startMs}|${lengthMs}`)),
);

server.registerTool(
  "vegas_list_render_templates",
  {
    title: "List the render templates VEGAS can export with",
    description:
      "Lists every render template in the installed VEGAS as 'Renderer :: Template'. Pick one and pass it to vegas_render. Read-only.",
    inputSchema: {},
  },
  async () => asyncToolResult(() => sendBridgeCommand("render_templates")),
);

server.registerTool(
  "vegas_render",
  {
    title: "Render the open VEGAS project to a file",
    description:
      "Exports the whole open VEGAS project with a template from vegas_list_render_templates, then reads the file back: whether the video and audio lengths match, and whether it has picture and sound. A render can have the right length and still be black and silent, so the content is checked too and a warning is returned. Never overwrites an existing file. VEGAS does not answer until the render finishes, which can take minutes.",
    inputSchema: {
      template: z.string().describe("'Renderer :: Template' name from vegas_list_render_templates"),
      outputPath: z.string().optional().describe("Absolute path for the file. Defaults to <package>/out/renders/"),
    },
  },
  async ({ template, outputPath }) =>
    asyncLogged("vegas_render", async () => {
      const target = outputPath ?? defaultRenderPath();
      const reply = await sendBridgeCommand(`render ${template}|${target}`, { timeoutMs: 35 * 60_000 });
      const durations = probeDurations(target);
      const content = inspectContent(target, durations.containerMs ?? 0);
      const problems = [content.looksBlank ? "black" : "", content.looksSilent ? "silent" : ""].filter(Boolean);
      return {
        ...reply,
        durations,
        avDifferenceMs: avDifferenceMs(durations),
        content,
        ...(problems.length > 0
          ? { warning: `The render looks ${problems.join(" and ")}. Its length is right, so the length check cannot catch this. Check the file before using it, and render again if it is wrong.` }
          : {}),
        note: "avDifferenceMs close to 0 means video and audio end together. The source media was not changed.",
      };
    }),
);

server.registerTool(
  "preview_sheet",
  {
    title: "Build a contact sheet of frames from a video file",
    description:
      "Tiles frames spread evenly over a video file into one PNG, so a render can be checked at a glance. Frames read left to right, top to bottom, and the reply gives the time of each. Works on any video file and never changes it. Uses ffmpeg.",
    inputSchema: {
      path: z.string().describe("Absolute path to the video file"),
      frames: z.number().int().min(1).max(60).optional().describe("How many frames. Defaults to 12"),
      columns: z.number().int().min(1).max(12).optional().describe("Frames per row. Defaults to 4"),
      width: z.number().int().min(80).max(960).optional().describe("Width of each frame in pixels. Defaults to 320"),
      outputPath: z.string().optional().describe("Absolute .png path. Defaults to <package>/out/sheets/"),
    },
  },
  async ({ path, frames, columns, width, outputPath }) =>
    asyncLogged("preview_sheet", async () => {
      // A file ffprobe reads no length for becomes 0, and buildSheet refuses it with a clear message.
      const { containerMs } = probeDurations(path);
      return buildSheet(path, outputPath ?? defaultSheetPath(path), containerMs ?? 0, { frames, columns, width });
    }),
);

const captionStyleList = Object.entries(CAPTION_STYLE_HELP)
  .map(([name, help]) => name + ": " + help)
  .join("; ");

server.registerTool(
  "vegas_add_captions",
  {
    title: "Burn captions from a transcript onto a VEGAS clip",
    description:
      "Groups the transcript's words into caption lines, renders them as one transparent layer over the clip, and places that layer on a new VEGAS track at the top. The clip must be the transcribed media. Captions are an overlay, not VEGAS subtitle events, because the VEGAS scripting API has no subtitle import. A clip that was sped up with vegas_set_speed gets its captions retimed to match. Rendering takes several minutes for long clips.",
    inputSchema: {
      wordsPath: z.string().describe("Absolute path to the .words.json of the clip's media"),
      trackIndex: z.number().int().min(0).optional().describe("Optional: track of one specific clip. Leave out to use every video clip that plays the transcribed media"),
      eventIndex: z.number().int().min(0).optional().describe("Optional: event on that track, used with trackIndex"),
      style: z
        .enum(CAPTION_STYLES)
        .optional()
        .describe("Look of the captions. Defaults to youtube. " + captionStyleList),
      textColor: z.string().optional().describe("#RRGGBB text colour. Left out, the style's own colour is used"),
      highlightColor: z.string().optional().describe("#RRGGBB colour of the spoken word or its box in the karaoke styles. Defaults to #FFD400"),
      maxWords: z.number().int().positive().optional().describe("Most words on one caption line. Defaults to 7"),
      maxChars: z.number().int().positive().optional().describe("Most characters on one caption line. Defaults to 42"),
      breakGapMs: z.number().positive().optional().describe("A pause this long starts a new caption line. Defaults to 600"),
    },
  },
  async ({ wordsPath, trackIndex, eventIndex, style, textColor, highlightColor, maxWords, maxChars, breakGapMs }) =>
    asyncLogged("vegas_add_captions", async () => {
      const { timeline } = await readTimeline();
      const selected = selectClips(timeline, readWordsSource(wordsPath), trackIndex, eventIndex);
      const words = readWords(wordsPath);
      const cues = wordsToCues(words, { maxWords, maxChars, breakGapMs });

      // One caption layer per clip that plays the media, each the length of its clip.
      const layers = [];
      for (const { trackIndex: clipTrack, clip } of selected) {
        // Captions match the clip's own shape: landscape footage gets a landscape layer, portrait gets portrait.
        const size = probeVideoSize(clip.mediaPath!) ?? { width: 1920, height: 1080 };
        const landscape = size.width >= size.height;
        // A sped-up clip plays its media faster, so its captions are retimed to match.
        const playbackRate = Number((await sendBridgeCommand(`audio_info ${clipTrack} ${clip.index}`)).playbackRate ?? 1);
        const local = cuesForClip(cues, { takeOffsetMs: clip.takeOffsetMs, lengthMs: clip.lengthMs, playbackRate });
        const rendered = renderCaptions({
          cues: local,
          durationMs: clip.lengthMs,
          width: landscape ? 1920 : 1080,
          height: landscape ? 1080 : 1920,
          style,
          textColor,
          highlightColor,
        });
        const overlay = await sendBridgeCommand(
          `overlay ${rendered.path}|${clip.startMs}|${clip.lengthMs}`,
          { timeoutMs: 120_000 },
        );
        layers.push({
          placedAtMs: clip.startMs,
          lengthMs: clip.lengthMs,
          playbackRate,
          style: style ?? "youtube",
          captionLines: local.length,
          layerPath: rendered.path,
          renderSeconds: rendered.renderSeconds,
          overlay,
        });
      }

      return {
        layers,
        note: "Each caption layer is a new track above the clips. Undo with Ctrl+Z in VEGAS.",
      };
    }),
);

server.registerTool(
  "vegas_audio_info",
  {
    title: "Read the fades, playback rate, mute and normalisation of a VEGAS event",
    description:
      "Reads one event's fade-in and fade-out lengths and curves, playback rate, mute, and, for audio events, normalisation and its gain. Track and event indexes come from vegas_list_timeline. Read-only.",
    inputSchema: {
      trackIndex: z.number().int().min(0).describe("Track of the event, 0-based"),
      eventIndex: z.number().int().min(0).describe("Event on that track, 0-based"),
    },
  },
  async ({ trackIndex, eventIndex }) =>
    asyncLogged("vegas_audio_info", () => sendBridgeCommand(`audio_info ${trackIndex} ${eventIndex}`)),
);

server.registerTool(
  "vegas_set_fades",
  {
    title: "Set the fade-in and fade-out of a VEGAS event",
    description:
      "Sets how long an event fades in and out, in ms. The two fades may not overlap, and cannot be longer than the event. Works on video and audio events. Changes the project; undo with Ctrl+Z in VEGAS. Call only after the user asked for it.",
    inputSchema: {
      trackIndex: z.number().int().min(0).describe("Track of the event, 0-based"),
      eventIndex: z.number().int().min(0).describe("Event on that track, 0-based"),
      fadeInMs: z.number().min(0).describe("Fade-in length in ms; 0 for none"),
      fadeOutMs: z.number().min(0).describe("Fade-out length in ms; 0 for none"),
    },
  },
  async ({ trackIndex, eventIndex, fadeInMs, fadeOutMs }) =>
    asyncLogged("vegas_set_fades", async () => {
      const current = await readAudioState(trackIndex, eventIndex);
      const conflict = fadeNormalizeConflict(current, { fadeInMs, fadeOutMs });
      if (conflict) throw new Error(conflict);
      return sendBridgeCommand(`fade ${trackIndex}|${eventIndex}|${fadeInMs}|${fadeOutMs}`);
    }),
);

server.registerTool(
  "vegas_set_normalize",
  {
    title: "Turn audio normalisation on or off for a VEGAS audio event",
    description:
      "Turns normalisation on or off for an audio event. When turned on, VEGAS recalculates the gain so the event's peak reaches the normalisation target. Audio events only. Changes the project; undo with Ctrl+Z in VEGAS. Call only after the user asked for it.",
    inputSchema: {
      trackIndex: z.number().int().min(0).describe("Audio track of the event, 0-based"),
      eventIndex: z.number().int().min(0).describe("Event on that track, 0-based"),
      normalize: z.boolean().describe("true to normalise, false to turn it off"),
    },
  },
  async ({ trackIndex, eventIndex, normalize }) =>
    asyncLogged("vegas_set_normalize", async () => {
      const current = await readAudioState(trackIndex, eventIndex);
      const conflict = fadeNormalizeConflict(current, { normalize });
      if (conflict) throw new Error(conflict);
      return sendBridgeCommand(`normalize ${trackIndex}|${eventIndex}|${normalize ? "on" : "off"}`);
    }),
);

server.registerTool(
  "vegas_set_speed",
  {
    title: "Change the speed of a VEGAS clip and its audio",
    description:
      "Speeds up a clip and its audio counterpart so they stay together, and the clip gets shorter. VEGAS retimes it, then the clips after it move back to close the gap. Rate 2 plays twice as fast and halves the clip. Speed-up only, from 1 to 10: to slow down or go back to normal, undo in VEGAS with Ctrl+Z. Captions added before the change keep their old timing and must be added again. Changes the project. Call only after the user asked for it.",
    inputSchema: {
      trackIndex: z.number().int().min(0).describe("Track of the clip, 0-based"),
      eventIndex: z.number().int().min(0).describe("Event on that track, 0-based"),
      rate: z.number().min(1).max(10).describe("Speed-up rate: 2 is twice as fast"),
    },
  },
  async ({ trackIndex, eventIndex, rate }) =>
    asyncLogged("vegas_set_speed", () => sendBridgeCommand(`speed ${trackIndex}|${eventIndex}|${rate}`)),
);

server.registerTool(
  "vegas_motion_info",
  {
    title: "Read the motion settings of a VEGAS video clip",
    description:
      "Reads whether the clip is scaled to fill the frame, how many motion keyframes it has, and the first keyframe's frame corners and rotation. Read-only.",
    inputSchema: {
      trackIndex: z.number().int().min(0).describe("Track of the video clip, 0-based"),
      eventIndex: z.number().int().min(0).describe("Event on that track, 0-based"),
    },
  },
  async ({ trackIndex, eventIndex }) =>
    asyncLogged("vegas_motion_info", () => sendBridgeCommand(`motion_info ${trackIndex}|${eventIndex}`)),
);

server.registerTool(
  "vegas_set_scale_to_fill",
  {
    title: "Scale a VEGAS video clip to fill the frame, or undo that",
    description:
      "Turns 'scale to fill' on or off for a video clip, which enlarges the clip so it covers the whole frame. Changes the project; undo with Ctrl+Z. Call only after the user asked for it.",
    inputSchema: {
      trackIndex: z.number().int().min(0).describe("Track of the video clip, 0-based"),
      eventIndex: z.number().int().min(0).describe("Event on that track, 0-based"),
      on: z.boolean().describe("true to scale to fill, false to turn it off"),
    },
  },
  async ({ trackIndex, eventIndex, on }) =>
    asyncLogged("vegas_set_scale_to_fill", () =>
      sendBridgeCommand(`motion_fill ${trackIndex}|${eventIndex}|${on ? "on" : "off"}`),
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
