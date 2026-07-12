import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { analyzeAudio } from "../src/audio/analyze.js";
import { parseProjectConfig } from "../src/config.js";
import { VisualizerRenderer } from "../src/render/renderer.js";
import type { AudioPcm } from "../src/types.js";

describe("visualizer renderer", () => {
  test("renders identical RGBA bytes for the same time and seed", () => {
    const sampleRate = 24_000;
    const samples = Float32Array.from({ length: sampleRate }, (_, index) =>
      Math.sin((2 * Math.PI * 180 * index) / sampleRate) * 0.55,
    );
    const pcm: AudioPcm = {
      samples,
      sampleRate,
      duration: 1,
      sourceHash: "fixture",
      sourceFileHash: "fixture-file",
    };
    const config = parseProjectConfig({
      output: { width: 320, height: 240, fps: 12 },
      text: { title: "Signal", artist: "Test" },
      visual: { bokehCount: 12, spectrumBands: 32 },
    });
    const analysis = analyzeAudio(pcm, 12, 32);
    const fullTimelineRenderer = new VisualizerRenderer(config, "fixed-seed");
    const clippedTimelineRenderer = new VisualizerRenderer(config, "fixed-seed");
    const first = fullTimelineRenderer.render(analysis, 0.5);
    const second = clippedTimelineRenderer.render(analysis, 0.5);
    const digest = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

    expect(first.byteLength).toBe(320 * 240 * 4);
    expect(digest(first)).toBe(digest(second));

    const earlier = fullTimelineRenderer.render(analysis, 0.2);
    const earlierDigest = digest(earlier);
    fullTimelineRenderer.render(analysis, 0.8);
    expect(digest(earlier)).toBe(earlierDigest);
  });
});
