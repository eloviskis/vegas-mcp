import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avDifferenceMs, classifyContent, defaultRenderPath, parseMaxVolume, parseStreamDurations } from "../src/vegas/render.js";

describe("parseStreamDurations", () => {
  it("reads video, audio and container durations from ffprobe JSON, in ms", () => {
    const d = parseStreamDurations({
      streams: [
        { codec_type: "video", duration: "78.663333" },
        { codec_type: "audio", duration: "76.464400" },
        { codec_type: "data", duration: "78.6" },
      ],
      format: { duration: "78.700000" },
    });
    assert.deepEqual(d, { videoMs: 78663.333, audioMs: 76464.4, containerMs: 78700 });
  });

  it("leaves a stream out when it is missing or has no duration", () => {
    assert.deepEqual(parseStreamDurations({ streams: [{ codec_type: "video" }] }), {});
    assert.deepEqual(parseStreamDurations({}), {});
  });
});

describe("avDifferenceMs", () => {
  it("is the video length minus the audio length", () => {
    assert.equal(avDifferenceMs({ videoMs: 78663.3, audioMs: 76464.4 }), 2198.9);
  });

  it("is null when either stream is missing, so a missing track is never reported as in sync", () => {
    assert.equal(avDifferenceMs({ videoMs: 1000 }), null);
    assert.equal(avDifferenceMs({ audioMs: 1000 }), null);
  });
});

describe("classifyContent", () => {
  // Values measured on the test project: the black and silent render read 0 and -91 dB; the good
  // renders read 28 to 157 and -1.6 dB and up.
  it("calls a render black when every sampled frame is near zero", () => {
    assert.deepEqual(classifyContent([0, 0, 0, 0, 0], -1.6), { looksBlank: true, looksSilent: false });
  });

  it("calls a render silent when its loudest sample is far below any real audio", () => {
    assert.deepEqual(classifyContent([28, 80, 73, 157, 28], -91), { looksBlank: false, looksSilent: true });
  });

  it("passes a render with picture and sound", () => {
    assert.deepEqual(classifyContent([28, 80, 73, 157, 28], -1.6), { looksBlank: false, looksSilent: false });
  });

  it("does not call a render silent when there is no audio to measure", () => {
    assert.deepEqual(classifyContent([28, 80], null), { looksBlank: false, looksSilent: false });
  });

  it("does not call a render black when no frame could be read", () => {
    assert.deepEqual(classifyContent([], -1.6), { looksBlank: false, looksSilent: false });
  });
});

describe("parseMaxVolume", () => {
  it("reads the peak from ffmpeg's volumedetect report", () => {
    const report = "[Parsed_volumedetect_0 @ 0x1] mean_volume: -16.9 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -1.8 dB\n";
    assert.equal(parseMaxVolume(report), -1.8);
  });

  it("is null when the report has no peak line", () => {
    assert.equal(parseMaxVolume("Output file does not contain any stream"), null);
  });
});

describe("defaultRenderPath", () => {
  it("puts the file under out/renders with a sortable timestamp", () => {
    const path = defaultRenderPath(new Date("2026-10-05T19:30:00.000Z"));
    assert.match(path.replaceAll("\\", "/"), /\/out\/renders\/render-2026-10-05T19-30-00-000Z\.mp4$/);
  });
});
