import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractAudio, normaliseWords, parseAudioTracks, transcribeWords, TranscribeError } from "../src/transcribe/transcribe.js";

describe("normaliseWords", () => {
  it("drops empty tokens and trims text", () => {
    const words = normaliseWords([
      { text: " Eu ", startMs: 0, endMs: 200 },
      { text: "   ", startMs: 200, endMs: 300 },
      { text: "quero", startMs: 300, endMs: 500 },
    ]);
    assert.deepEqual(words.map((w) => w.text), ["Eu", "quero"]);
  });

  it("pushes an overlapping start to the end of the previous word", () => {
    const words = normaliseWords([
      { text: "a", startMs: 0, endMs: 500 },
      { text: "b", startMs: 400, endMs: 900 },
    ]);
    assert.deepEqual(words[1], { text: "b", startMs: 500, endMs: 900 });
  });

  it("gives a zero-length word one millisecond so the detector accepts it", () => {
    const words = normaliseWords([{ text: "oi", startMs: 1000, endMs: 1000 }]);
    assert.deepEqual(words[0], { text: "oi", startMs: 1000, endMs: 1001 });
  });
});

describe("parseAudioTracks", () => {
  it("numbers audio tracks from 0 and keeps codec, channels and language", () => {
    const tracks = parseAudioTracks({
      streams: [
        { codec_name: "aac", channels: 2, sample_rate: "48000", tags: { language: "por" } },
        { codec_name: "unknown", channels: 4, sample_rate: "48000", tags: { title: "Multicanal" } },
      ],
    });
    assert.deepEqual(tracks, [
      { index: 0, codec: "aac", channels: 2, sampleRate: 48000, language: "por" },
      { index: 1, codec: "unknown", channels: 4, sampleRate: 48000, title: "Multicanal" },
    ]);
  });

  it("returns no tracks for a file without audio", () => {
    assert.deepEqual(parseAudioTracks({ streams: [] }), []);
    assert.deepEqual(parseAudioTracks({}), []);
  });
});

describe("extractAudio", () => {
  it("names the missing media file instead of failing inside ffmpeg", () => {
    assert.throws(
      () => extractAudio("C:/definitely/not/here.mp4", "C:/tmp/out.wav"),
      (error: unknown) => error instanceof TranscribeError && /Media file not found/.test(error.message),
    );
  });
});

describe("transcribeWords", () => {
  it("names the missing audio file before starting Python", () => {
    assert.throws(
      () => transcribeWords({ audioPath: "C:/definitely/not/here.wav" }),
      /Audio file not found/,
    );
  });

  it("explains how to create the environment when it is absent", () => {
    const previous = process.env.VEGAS_MCP_PYTHON;
    process.env.VEGAS_MCP_PYTHON = "C:/definitely/not/python.exe";
    try {
      assert.throws(
        () => transcribeWords({ audioPath: import.meta.filename }),
        /Whisper environment missing.*faster-whisper/s,
      );
    } finally {
      if (previous === undefined) delete process.env.VEGAS_MCP_PYTHON;
      else process.env.VEGAS_MCP_PYTHON = previous;
    }
  });
});
