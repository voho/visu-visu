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

  test("separates real channel frequencies without changing the mono motion features", () => {
    const left = sinePcm(375), right = sinePcm(3000);
    const samples = Float32Array.from(left.samples, (value, index) => (value + right.samples[index]!) / 2);
    const pcm = { ...left, samples, channels: { left: left.samples, right: right.samples } };
    const stereo = analyzeAudio(pcm, 60, 64), mono = analyzeAudio({ ...left, samples }, 60, 64);
    const frame = frameAt(stereo, 0.5);
    const strongest = (spectrum: Float32Array) => spectrum.indexOf(Math.max(...spectrum));
    const low = strongest(frame.spectrumLeft!), high = strongest(frame.spectrumRight!);
    expect(high - low).toBeGreaterThan(15);
    expect(frame.spectrumLeft![low]!).toBeGreaterThan(0.8);
    expect(frame.spectrumRight![low]!).toBeLessThan(0.01);
    // Logarithmic high bands span more FFT bins, so the pure treble tone has
    // less band-mean energy than bass; it must still remain clearly visible.
    expect(frame.spectrumRight![high]!).toBeGreaterThan(0.4);
    expect(frame.spectrumLeft![high]!).toBeLessThan(0.01);
    expect(stereo.frames.map(({ spectrumLeft: _left, spectrumRight: _right, ...value }) => value))
      .toEqual(mono.frames.map(({ spectrumLeft: _left, spectrumRight: _right, ...value }) => value));
  });

  test("retains out-of-phase stereo energy and uses one scale for both channels", () => {
    const pcm = sinePcm(750);
    const phaseCancelled = analyzeAudio({ ...pcm, samples: new Float32Array(pcm.samples.length),
      channels: { left: pcm.samples, right: Float32Array.from(pcm.samples, value => -value) } }, 60, 64);
    const frame = frameAt(phaseCancelled, 0.5);
    expect(Math.max(...frame.spectrum)).toBe(0);
    expect(Math.max(...frame.spectrumLeft!)).toBeGreaterThan(0.9);
    expect(frame.spectrumLeft).toEqual(frame.spectrumRight);
    const unequal = frameAt(analyzeAudio({ ...pcm, channels: { left: pcm.samples,
      right: Float32Array.from(pcm.samples, value => value * 0.1) } }, 60, 64), 0.5);
    const strongest = unequal.spectrumLeft!.indexOf(Math.max(...unequal.spectrumLeft!));
    expect(unequal.spectrumRight![strongest]!).toBeLessThan(unequal.spectrumLeft![strongest]! * 0.8);
    expect(unequal.spectrumRight![strongest]!).toBeGreaterThan(0);
    expect(() => analyzeAudio({ ...pcm, channels: { left: pcm.samples, right: new Float32Array(1) } }, 60, 64))
      .toThrow("Stereo channels must match");
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
