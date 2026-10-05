import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Burned-in captions as one transparent layer for the whole clip. There is no background fill,
 * so the render keeps its alpha channel and sits over the footage in VEGAS like any overlay.
 *
 * Cue times are in milliseconds from the start of the layer. The composition reads the frame,
 * converts it to a time, and shows whichever cue covers that time.
 */

export type CaptionCue = { startMs: number; endMs: number; text: string };

export type CaptionsProps = {
  cues: CaptionCue[];
  textColor: string;
  /** Total length. Read by `calculateMetadata` so the composition matches the clip. */
  durationInFrames?: number;
};

export const CAPTIONS_DEFAULTS: CaptionsProps = {
  cues: [],
  textColor: "#FFFFFF",
};

export const Captions: React.FC<CaptionsProps> = ({ cues, textColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;
  const cue = cues.find((c) => nowMs >= c.startMs && nowMs < c.endMs);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 260 }}>
      {cue ? (
        <div
          style={{
            maxWidth: "86%",
            textAlign: "center",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 64,
            fontWeight: 800,
            lineHeight: 1.2,
            color: textColor,
            textShadow: "0 6px 24px rgba(0,0,0,0.7)",
          }}
        >
          {cue.text}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
