import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { cuesForClip, wordsToCues } from "../src/captions/cues.js";
import { CAPTION_STYLES } from "../src/captions/styles.js";
import type { Word } from "../src/cuts/detect.js";

const w = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs });

describe("wordsToCues", () => {
  it("breaks a line at a pause, so a speaker's pause becomes a new caption", () => {
    const cues = wordsToCues([w("Oi", 0, 300), w("tudo", 350, 700), w("bem", 2000, 2300)]);
    assert.deepEqual(cues, [
      { startMs: 0, endMs: 700, text: "Oi tudo", words: [w("Oi", 0, 300), w("tudo", 350, 700)] },
      { startMs: 2000, endMs: 2300, text: "bem", words: [w("bem", 2000, 2300)] },
    ]);
  });

  it("breaks a line after maxWords even without a pause", () => {
    const words = ["um", "dois", "tres", "quatro"].map((t, i) => w(t, i * 300, i * 300 + 250));
    const cues = wordsToCues(words, { maxWords: 3 });
    assert.deepEqual(cues.map((c) => c.text), ["um dois tres", "quatro"]);
  });

  it("breaks a line before it exceeds maxChars", () => {
    const cues = wordsToCues(
      [w("aaaaaaaaaa", 0, 200), w("bbbbbbbbbb", 250, 450)],
      { maxChars: 15 },
    );
    assert.deepEqual(cues.map((c) => c.text), ["aaaaaaaaaa", "bbbbbbbbbb"]);
  });

  it("returns nothing for no words", () => {
    assert.deepEqual(wordsToCues([]), []);
  });
});

describe("cuesForClip", () => {
  it("moves cues into the clip's own time and clips them at its edges", () => {
    // Clip plays media from 4 s for 10 s. A cue at 3–5 s keeps only its 4–5 s part, which is 0–1 s in the clip.
    const out = cuesForClip(
      [
        { startMs: 3000, endMs: 5000, text: "a" },
        { startMs: 20000, endMs: 21000, text: "fora" },
      ],
      { takeOffsetMs: 4000, lengthMs: 10000 },
    );
    assert.deepEqual(out, [{ startMs: 0, endMs: 1000, text: "a" }]);
  });

  it("maps a sped-up clip so one media second takes half a second on the timeline", () => {
    // Clip is 10 s on the timeline at 2x, so it plays media 0–20 s. A cue at 4–6 s is at 2–3 s.
    const out = cuesForClip([{ startMs: 4000, endMs: 6000, text: "a" }], {
      takeOffsetMs: 0,
      lengthMs: 10000,
      playbackRate: 2,
    });
    assert.deepEqual(out, [{ startMs: 2000, endMs: 3000, text: "a" }]);
  });

  it("drops cues past the media a sped-up clip plays", () => {
    const out = cuesForClip([{ startMs: 21000, endMs: 22000, text: "fora" }], {
      takeOffsetMs: 0,
      lengthMs: 10000,
      playbackRate: 2,
    });
    assert.deepEqual(out, []);
  });

  it("starts from the take offset at the clip's rate", () => {
    // Clip plays media from 25 s at 2x for 10 s, so media 25–45 s. A cue at 30–31 s is at 2.5–3 s.
    const out = cuesForClip([{ startMs: 30000, endMs: 31000, text: "b" }], {
      takeOffsetMs: 25000,
      lengthMs: 10000,
      playbackRate: 2,
    });
    assert.deepEqual(out, [{ startMs: 2500, endMs: 3000, text: "b" }]);
  });

  it("retimes the words of a cue with the clip, and keeps the cue text", () => {
    const cue = {
      startMs: 2000,
      endMs: 4000,
      text: "um dois",
      words: [
        { text: "um", startMs: 2000, endMs: 2500 },
        { text: "dois", startMs: 3000, endMs: 4000 },
      ],
    };
    const out = cuesForClip([cue], { takeOffsetMs: 0, lengthMs: 10000, playbackRate: 2 });
    assert.deepEqual(out, [
      {
        startMs: 1000,
        endMs: 2000,
        text: "um dois",
        words: [
          { text: "um", startMs: 1000, endMs: 1250 },
          { text: "dois", startMs: 1500, endMs: 2000 },
        ],
      },
    ]);
  });
});

describe("caption styles", () => {
  it("has exactly one look in the composition for each style name", () => {
    // The looks are the keys of LOOKS in Captions.tsx, one per line as `name: { color: ...`.
    const source = readFileSync(new URL("../remotion/src/Captions.tsx", import.meta.url), "utf8");
    const looks = [...source.matchAll(/^\s*"?([a-z-]+)"?: \{ color: /gm)].map((m) => m[1]).sort();
    assert.deepEqual(looks, [...CAPTION_STYLES].sort());
  });
});
