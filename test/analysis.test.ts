import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { analyzeAudio, frameAt } from "../src/audio/analyze.js";
import type { AudioPcm } from "../src/types.js";

function sinePcm(frequency: number, duration = 1): AudioPcm {
  const sampleRate = 24_000;
  const samples = new Float32Array(sampleRate * duration);
  for (let index = 0; index < samples.length; index += 1) {
    const fade = Math.min(1, index / 1200, (samples.length - index) / 1200);
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.7 * fade;
  }
  const bytes = Buffer.from(samples.buffer);
  return {
    samples,
    sampleRate,
    duration,
    sourceHash: createHash("sha256").update(bytes).digest("hex"),
    sourceFileHash: "synthetic-file",
  };
}

describe("audio analysis", () => {
  test("produces normalized, time-indexed features deterministically", () => {
    const pcm = sinePcm(440);
    const left = analyzeAudio(pcm, 30, 64);
    const right = analyzeAudio(pcm, 30, 64);
    expect(left.frames).toHaveLength(30);
    expect(left).toEqual(right);
    const middle = frameAt(left, 0.5);
    expect(middle.rms).toBeGreaterThan(0.8);
    expect(middle.peak).toBeGreaterThan(0.8);
    expect(middle.spectrum).toHaveLength(64);
    expect(middle.waveform).toHaveLength(192);
    expect(Math.max(...middle.spectrum)).toBeGreaterThan(0.8);
    for (const value of [middle.rms, middle.peak, middle.centroid, middle.flux, middle.onset]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("clamps lookup to the available timeline", () => {
    const analysis = analyzeAudio(sinePcm(220, 0.2), 20, 32);
    expect(frameAt(analysis, -10)).toBe(analysis.frames[0]!);
    expect(frameAt(analysis, 99)).toBe(analysis.frames.at(-1)!);
  });

  test("keeps the same RMS attack and release times at 12 and 60 fps", () => {
    const pcm = sinePcm(440, 4);
    for (let index = 0; index < pcm.samples.length; index += 1) {
      if (index < pcm.sampleRate || index >= pcm.sampleRate * 2) pcm.samples[index] = 0;
    }
    const slow = analyzeAudio(pcm, 12, 64);
    const fast = analyzeAudio(pcm, 60, 64);

    expect(Math.abs(frameAt(slow, 1.25).rms - frameAt(fast, 1.25).rms)).toBeLessThan(0.03);
    // Both windows are completely silent here, so the relative fall measures
    // release duration without depending on FFT placement at the transition.
    const slowRelease = frameAt(slow, 2.5).rms / frameAt(slow, 2.25).rms;
    const fastRelease = frameAt(fast, 2.5).rms / frameAt(fast, 2.25).rms;
    expect(slowRelease).toBeGreaterThan(0.4);
    expect(slowRelease).toBeLessThan(0.5);
    expect(slowRelease).toBeCloseTo(fastRelease, 10);
  });
});
