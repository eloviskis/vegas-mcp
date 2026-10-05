#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderOverlay } from "./remotion/bridge.js";
import { prepareSubtitles } from "./workflows/srt.js";
import { findSpeechCuts, listAudioTracks, transcribeSpeech } from "./workflows/speech.js";

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

const transport = new StdioServerTransport();
await server.connect(transport);
