import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSilencedetect, silenceToCuts } from "../src/cuts/silence.js";

const LOG = [
  "[silencedetect @ 0x1] silence_start: 1.5",
  "[silencedetect @ 0x1] silence_end: 2.9 | silence_duration: 1.4",
  "[silencedetect @ 0x1] silence_start: 6",
  "[silencedetect @ 0x1] silence_end: 6.5 | silence_duration: 0.5",
  "[silencedetect @ 0x1] silence_start: 9.25",
].join("\n");

describe("parseSilencedetect", () => {
  it("pairs each silence_start with its silence_end, in ms", () => {
    assert.deepEqual(parseSilencedetect(LOG), [
      { startMs: 1500, endMs: 2900 },
      { startMs: 6000, endMs: 6500 },
    ]);
  });

  it("ignores a silence that is still open at the end of the file", () => {
    assert.deepEqual(parseSilencedetect("silence_start: 9.25"), []);
  });

  it("returns nothing for output without silence lines", () => {
    assert.deepEqual(parseSilencedetect("nothing here"), []);
  });
});

describe("silenceToCuts", () => {
  it("keeps the same breathing room as word pauses and drops short silences", () => {
    const cuts = silenceToCuts(
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 5000, endMs: 5300 },
      ],
      { pausePaddingMs: 250, minPauseMs: 700 },
    );
    assert.deepEqual(cuts, [{ startMs: 1250, endMs: 1750, reasons: ["silence"] }]);
  });

  it("drops a silence that padding would leave with no length", () => {
    assert.deepEqual(
      silenceToCuts([{ startMs: 0, endMs: 800 }], { pausePaddingMs: 400, minPauseMs: 700 }),
      [],
    );
  });
});
