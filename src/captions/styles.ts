/**
 * Caption looks the Captions composition can draw. The names are the keys of the LOOKS table in
 * remotion/src/Captions.tsx; a test keeps the two lists in step. The looks follow the caption
 * presets of mcp-cut and capcut-mcp (both MIT). The drawing code is our own, nothing is copied.
 */
export const CAPTION_STYLES = [
  "youtube",
  "subtitle",
  "tiktok",
  "minimal",
  "karaoke",
  "karaoke-box",
  "wordbox",
] as const;

export type CaptionStyle = (typeof CAPTION_STYLES)[number];

/** One line per style, for the tool description. */
export const CAPTION_STYLE_HELP: Record<CaptionStyle, string> = {
  youtube: "bold white with a black outline (default)",
  subtitle: "white on a dark translucent box",
  tiktok: "bold yellow with a black outline",
  minimal: "thin white with a soft shadow",
  karaoke: "words turn yellow as they are spoken",
  "karaoke-box": "the word being spoken sits in a yellow box",
  wordbox: "one word at a time in a yellow box",
};
