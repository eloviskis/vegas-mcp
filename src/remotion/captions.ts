import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptionCue } from "../captions/cues.js";
import type { CaptionStyle } from "../captions/styles.js";

/**
 * Renders the Captions composition as one transparent .mov for the whole clip. Same pipeline as
 * renderOverlay: Remotion CLI invoked through Node, props as JSON, ProRes 4444 with alpha.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** `src/remotion/` → `<package root>/remotion`, and the same from `dist/remotion/`. */
const projectRoot = resolve(here, "..", "..", "remotion");

export class CaptionRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionRenderError";
  }
}

export type RenderCaptionsRequest = {
  cues: CaptionCue[];
  /** Length of the layer in ms. It should equal the clip it sits over. */
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  style?: CaptionStyle;
  /** Base text colour. Left out, the style's own colour is used. */
  textColor?: string;
  /** Colour of the spoken word or its box. Left out, yellow is used. */
  highlightColor?: string;
  /** Absolute .mov path. Defaults to <package>/out/captions-<timestamp>.mov */
  outputPath?: string;
};

export type RenderCaptionsResult = {
  path: string;
  cueCount: number;
  durationFrames: number;
  renderSeconds: number;
};

export function renderCaptions(request: RenderCaptionsRequest): RenderCaptionsResult {
  if (!existsSync(projectRoot)) {
    throw new CaptionRenderError(`Overlay project missing at ${projectRoot}.`);
  }
  const cliEntry = join(projectRoot, "node_modules", "@remotion", "cli", "remotion-cli.js");
  if (!existsSync(cliEntry)) {
    throw new CaptionRenderError(`Remotion CLI not found at ${cliEntry}. Run: npm install --prefix "${projectRoot}"`);
  }

  const fps = request.fps ?? 30;
  const width = request.width ?? 1080;
  const height = request.height ?? 1920;
  const durationFrames = Math.max(2, Math.round((request.durationMs / 1000) * fps));
  const outputPath =
    request.outputPath ?? join(projectRoot, "..", "out", `captions-${Date.now()}.mov`);
  mkdirSync(dirname(outputPath), { recursive: true });

  // JSON.stringify leaves out undefined colours, so the composition falls back to the style's own.
  const props = JSON.stringify({
    cues: request.cues,
    style: request.style ?? "youtube",
    textColor: request.textColor,
    highlightColor: request.highlightColor,
    durationInFrames: durationFrames,
  });

  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      cliEntry,
      "render",
      "Captions",
      outputPath,
      `--props=${props}`,
      `--width=${width}`,
      `--height=${height}`,
      `--frames=0-${durationFrames - 1}`,
      "--codec=prores",
      "--prores-profile=4444",
      "--image-format=png",
      "--pixel-format=yuva444p10le",
    ],
    { cwd: projectRoot, encoding: "utf-8", timeout: 30 * 60_000 },
  );

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim().slice(0, 800);
    throw new CaptionRenderError(`Remotion caption render failed: ${detail}`);
  }
  if (!existsSync(outputPath)) {
    throw new CaptionRenderError(`Remotion reported success but ${outputPath} does not exist.`);
  }

  return {
    path: outputPath,
    cueCount: request.cues.length,
    durationFrames,
    renderSeconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
  };
}
