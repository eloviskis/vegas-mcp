#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderOverlay } from "./remotion/bridge.js";
import { prepareSubtitles } from "./workflows/srt.js";

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
      "Renders an animated overlay with a real alpha channel (ProRes 4444, yuva444p10le) using Remotion. Returns the .mov path to import into VEGAS Pro and place on a track above the footage. Requires ffmpeg. Rendering takes tens of seconds.",
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

const transport = new StdioServerTransport();
await server.connect(transport);
