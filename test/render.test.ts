import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avDifferenceMs, defaultRenderPath, parseStreamDurations } from "../src/vegas/render.js";

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

describe("defaultRenderPath", () => {
  it("puts the file under out/renders with a sortable timestamp", () => {
    const path = defaultRenderPath(new Date("2026-10-05T19:30:00.000Z"));
    assert.match(path.replaceAll("\\", "/"), /\/out\/renders\/render-2026-10-05T19-30-00-000Z\.mp4$/);
  });
});
