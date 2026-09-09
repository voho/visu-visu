import { describe, expect, test } from "bun:test";
import { analyzeAudio } from "../src/audio/analyze.js";
import { parseProjectConfig } from "../src/config.js";
import { VisualizerRenderer } from "../src/render/renderer.js";

function meanRgbDifference(left: Buffer, right: Buffer): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (index % 4 !== 3) total += Math.abs(left[index]! - right[index]!);
  }
  return total / (left.length / 4 * 3);
}

describe("renderer material lighting", () => {
  test("fades continuously to zero while retaining visible light at normal strength", () => {
    const sampleRate = 24_000;
    const analysis = analyzeAudio({
      samples: Float32Array.from({ length: sampleRate }, (_, index) =>
        Math.sin(index * 2 * Math.PI * 180 / sampleRate) * 0.55),
      sampleRate, duration: 1, sourceHash: "light-continuity", sourceFileHash: "light-continuity",
    }, 12, 32);
    const render = (lighting: number) => new VisualizerRenderer(parseProjectConfig({
      output: { width: 320, height: 180, fps: 12 },
      text: { title: "Signal", artist: "Test" },
      visual: { lighting, bokehCount: 12, spectrumBands: 32 },
    }), "light-continuity").render(analysis, 0.5);
    const off = render(0);
    const nearlyOff = render(0.00001);
    const on = render(0.65);
    const residual = meanRgbDifference(off, nearlyOff);
    const visibleResponse = meanRgbDifference(off, on);
    // Enabling an infinitesimal amount must not switch gradient colors or
    // opacity. Permit only small 8-bit rounding differences in the full image.
    expect(residual).toBeLessThan(0.025);
    expect(visibleResponse).toBeGreaterThan(0.5);
    expect(residual).toBeLessThan(visibleResponse * 0.005);
  });
});
