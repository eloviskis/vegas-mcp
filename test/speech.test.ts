import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findSpeechCuts, transcribeSpeech } from "../src/workflows/speech.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vegas-mcp-speech-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeWords = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
};

describe("findSpeechCuts", () => {
  it("returns each cut with the words it removes", () => {
    const path = writeWords(
      "ok.words.json",
      JSON.stringify({
        words: [
          { text: "Eu,", startMs: 0, endMs: 240 },
          { text: "eu", startMs: 300, endMs: 380 },
          { text: "quero", startMs: 380, endMs: 740 },
          { text: "ir", startMs: 2000, endMs: 2300 },
        ],
      }),
    );

    const result = findSpeechCuts({ wordsPath: path });

    assert.equal(result.count, result.cuts.length);
    const repeat = result.cuts.find((c) => c.reasons.includes("repeat"));
    assert.ok(repeat, "expected a repeat cut");
    assert.equal(repeat.text, "Eu,");
    assert.equal(repeat.durationMs, repeat.endMs - repeat.startMs);

    const pause = result.cuts.find((c) => c.reasons.includes("pause"));
    assert.ok(pause, "expected a pause cut");
    assert.equal(pause.text, "(silêncio)");
    assert.equal(result.totalCutMs, result.cuts.reduce((s, c) => s + c.durationMs, 0));
  });

  it("passes detection options through", () => {
    const path = writeWords(
      "options.words.json",
      JSON.stringify({ words: [{ text: "a", startMs: 0, endMs: 500 }, { text: "b", startMs: 1100, endMs: 1500 }] }),
    );
    const result = findSpeechCuts({ wordsPath: path, minPauseMs: 500, pausePaddingMs: 0 });
    assert.deepEqual(result.cuts, [
      { startMs: 500, endMs: 1100, reasons: ["pause"], durationMs: 600, text: "(silêncio)" },
    ]);
  });

  it("names a missing file", () => {
    assert.throws(() => findSpeechCuts({ wordsPath: join(dir, "absent.json") }), /Words file not found/);
  });

  it("explains invalid JSON and points to transcribe_speech", () => {
    const path = writeWords("broken.json", "{ not json");
    assert.throws(() => findSpeechCuts({ wordsPath: path }), /Not valid JSON.*transcribe_speech/s);
  });

  it("names the field that has the wrong shape", () => {
    const path = writeWords("shape.json", JSON.stringify({ words: [{ text: "a", startMs: "zero", endMs: 5 }] }));
    assert.throws(() => findSpeechCuts({ wordsPath: path }), /unexpected shape at "words\.0\.startMs"/);
  });

  it("rejects words that overlap, using the detector's message", () => {
    const path = writeWords(
      "overlap.json",
      JSON.stringify({ words: [{ text: "a", startMs: 0, endMs: 500 }, { text: "b", startMs: 400, endMs: 900 }] }),
    );
    assert.throws(() => findSpeechCuts({ wordsPath: path }), /starts before the previous word ends/);
  });
});

describe("transcribeSpeech", () => {
  it("names a missing media file before running ffmpeg", () => {
    assert.throws(
      () => transcribeSpeech({ path: join(dir, "absent.mp4"), outputDir: dir }),
      /Media file not found/,
    );
  });
});
