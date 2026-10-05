import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Burned-in captions as one transparent layer for the whole clip. Each style is one entry in the
 * LOOKS table below. A style draws its text, outline, shadow and, for the karaoke styles, lights up
 * the words as they are spoken. There is no background fill unless the style asks for a box, so the
 * render keeps its alpha channel and sits over the footage in VEGAS like any overlay.
 *
 * Cue times are in milliseconds from the start of the layer. The composition reads the frame,
 * converts it to a time, and shows whichever cue covers that time. Word times drive the karaoke
 * styles and are optional; without them those styles show the plain line.
 */

export type CaptionWord = { text: string; startMs: number; endMs: number };
export type CaptionCue = { startMs: number; endMs: number; text: string; words?: CaptionWord[] };

export type CaptionsProps = {
  cues: CaptionCue[];
  style?: keyof typeof LOOKS;
  /** Base text colour. Defaults to the style's own colour. */
  textColor?: string;
  /** Colour of the spoken words, or of the box behind the spoken word. Defaults to yellow. */
  highlightColor?: string;
  /** Total length. Read by `calculateMetadata` so the composition matches the clip. */
  durationInFrames?: number;
};

export const CAPTIONS_DEFAULTS: CaptionsProps = {
  cues: [],
  style: "youtube",
};

type Look = {
  color: string;
  weight: number;
  /** Font size in px for a 1080-pixel short side. Scaled for other frame sizes. */
  size: number;
  /** Outline thickness in px at 1080, 0 for none. */
  outline: number;
  shadow: string;
  /** Background behind the whole line, for the boxed style. */
  box?: string;
  /** How spoken words show: `fill` recolours them, `box` boxes the current one, `word` shows one at a time. */
  highlight?: "fill" | "box" | "word";
};

/** Text colour inside a yellow box. Dark, so it reads on the highlight. */
const BOX_TEXT = "#111111";

const LOOKS = {
  youtube: { color: "#FFFFFF", weight: 800, size: 64, outline: 6, shadow: "0 6px 24px rgba(0,0,0,0.7)" },
  subtitle: { color: "#FFFFFF", weight: 600, size: 52, outline: 0, shadow: "none", box: "rgba(0,0,0,0.62)" },
  tiktok: { color: "#FFD400", weight: 900, size: 72, outline: 8, shadow: "0 6px 18px rgba(0,0,0,0.5)" },
  minimal: { color: "#FFFFFF", weight: 500, size: 56, outline: 0, shadow: "0 2px 8px rgba(0,0,0,0.6)" },
  karaoke: { color: "#FFFFFF", weight: 800, size: 64, outline: 6, shadow: "0 6px 24px rgba(0,0,0,0.7)", highlight: "fill" },
  "karaoke-box": { color: "#FFFFFF", weight: 800, size: 64, outline: 6, shadow: "0 6px 24px rgba(0,0,0,0.7)", highlight: "box" },
  wordbox: { color: "#FFFFFF", weight: 900, size: 84, outline: 0, shadow: "none", highlight: "word" },
} satisfies Record<string, Look>;

export const Captions: React.FC<CaptionsProps> = ({ cues, style = "youtube", textColor, highlightColor = "#FFD400" }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;
  const cue = cues.find((c) => nowMs >= c.startMs && nowMs < c.endMs);
  if (!cue) return <AbsoluteFill />;

  const look: Look = LOOKS[style] ?? LOOKS.youtube;
  const scale = Math.min(width, height) / 1080;
  const color = textColor ?? look.color;
  const fontSize = look.size * scale;
  const radius = Math.round(14 * scale);
  const pad = `${Math.round(6 * scale)}px ${Math.round(18 * scale)}px`;

  const words = cue.words && cue.words.length > 0 ? cue.words : null;
  const activeWord = words?.find((w) => nowMs >= w.startMs && nowMs < w.endMs);

  let content: React.ReactNode = cue.text;
  if (look.highlight === "word") {
    // One word at a time, in a yellow box. Between words nothing shows, which is the style.
    const text = words ? activeWord?.text : cue.text;
    if (!text) return <AbsoluteFill />;
    content = (
      <span
        style={{
          display: "inline-block",
          background: highlightColor,
          color: BOX_TEXT,
          borderRadius: radius,
          padding: pad,
          fontSize: fontSize * 1.1,
        }}
      >
        {text}
      </span>
    );
  } else if (words && look.highlight) {
    content = words.map((w, i) => {
      const space = i < words.length - 1 ? " " : "";
      if (look.highlight === "fill") {
        const spoken = nowMs >= w.startMs;
        return (
          <span key={i} style={{ color: spoken ? highlightColor : color }}>
            {w.text}
            {space}
          </span>
        );
      }
      const active = nowMs >= w.startMs && nowMs < w.endMs;
      return (
        <span
          key={i}
          style={
            active
              ? {
                  background: highlightColor,
                  color: BOX_TEXT,
                  borderRadius: Math.round(10 * scale),
                  padding: `0 ${Math.round(8 * scale)}px`,
                  // The outline and shadow of the line are inherited, and would blur the dark text inside the box.
                  WebkitTextStroke: "0px transparent",
                  textShadow: "none",
                }
              : undefined
          }
        >
          {w.text}
          {space}
        </span>
      );
    });
  }

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: Math.round(height * 0.14) }}>
      <div
        style={{
          maxWidth: "86%",
          textAlign: "center",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize,
          fontWeight: look.weight,
          lineHeight: 1.2,
          color,
          // Stroke is drawn behind the fill, so only its outer half shows: double the width.
          WebkitTextStroke: look.outline ? `${look.outline * 2 * scale}px #000000` : undefined,
          paintOrder: "stroke fill",
          textShadow: look.shadow,
          background: look.box,
          borderRadius: look.box ? radius : undefined,
          padding: look.box ? pad : undefined,
        }}
      >
        {content}
      </div>
    </AbsoluteFill>
  );
};
