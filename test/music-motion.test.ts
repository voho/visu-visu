import { describe, expect, test } from "bun:test";
import { deriveMusicMotion } from "../src/render/music-motion.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

function frame(overrides: Partial<AnalysisFrame> = {}): AnalysisFrame {
  return {
    rms: 0,
    peak: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    centroid: 0,
    flux: 0,
    onset: 0,
    spectrum: new Float32Array(16),
    waveform: new Float32Array(16),
    ...overrides,
  };
}

function analysis(sample: (time: number) => AnalysisFrame, fps = 30, duration = 4): AudioAnalysis {
  return {
    version: ANALYSIS_VERSION,
    sampleRate: 48_000,
    fps,
    duration,
    spectrumBands: 16,
    waveformPoints: 16,
    sourceHash: "music-motion",
    sourceFileHash: "music-motion",
    frames: Array.from({ length: Math.ceil(fps * duration) }, (_, index) => sample(index / fps)),
  };
}

function rhythm(time: number): AnalysisFrame {
  const beat = Math.max(0, 1 - (time % 0.5) * 9);
  return frame({ rms: 0.3 + beat * 0.5, bass: beat * 0.4, treble: beat * 0.08 });
}

describe("musical motion transport", () => {
  test("gives identical absolute seeks after arbitrary render order and with a fresh profile", () => {
    const source = analysis(rhythm);
    const expected = deriveMusicMotion(source, 2.617);
    for (const time of [3.8, 0, 2.1, 0.24, 3.1, 1.08]) deriveMusicMotion(source, time);
    expect(deriveMusicMotion(source, 2.617)).toEqual(expected);
    expect(deriveMusicMotion(analysis(rhythm), 2.617)).toEqual(expected);
  });

  test("produces 60 distinct, continuous positions from a lower-rate analysis", () => {
    const source = analysis(rhythm, 24);
    const samples = Array.from({ length: 60 }, (_, index) => deriveMusicMotion(source, 1 + index / 60));
    expect(new Set(samples.map((sample) => sample.slowTime)).size).toBe(60);
    expect(new Set(samples.map((sample) => sample.fastTime)).size).toBe(60);
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      expect(current.slowTime - previous.slowTime).toBeWithin(0.2 / 60 - 1e-9, 1 / 60 + 1e-9);
      expect(current.fastTime - previous.fastTime).toBeWithin(1 / 60 - 1e-9, 5 / 60 + 1e-9);
    }
    for (const boundary of [1, 1.5, 2]) {
      const before = deriveMusicMotion(source, boundary - 1e-8);
      const after = deriveMusicMotion(source, boundary + 1e-8);
      expect(after.slowTime - before.slowTime).toBeWithin(0, 2e-8 + 1e-12);
      expect(after.fastTime - before.fastTime).toBeWithin(0, 1e-7 + 1e-12);
    }
  });

  test("energetic music travels faster while retaining separate slow and fast timescales", () => {
    const quiet = deriveMusicMotion(analysis(() => frame()), 3);
    const loud = deriveMusicMotion(analysis(rhythm), 3);
    expect(loud.slowTime).toBeGreaterThan(quiet.slowTime * 2);
    expect(loud.fastTime).toBeGreaterThan(quiet.fastTime * 1.8);
    expect(loud.fastTime).toBeGreaterThan(loud.slowTime * 2.5);
    expect(quiet.slowTime).toBeCloseTo(0.6, 10);
    expect(quiet.fastTime).toBeCloseTo(3, 10);
  });

  test("bass and treble respond separately with exact decay in seconds and no future hits", () => {
    const source = analysis((time) => frame({
      bass: time >= 1 && time < 2 ? 0.07 : 0,
      treble: time >= 2 ? 0.025 : 0,
    }));
    expect(deriveMusicMotion(source, 1 - 1e-9).bassPulse).toBe(0);
    const kick = deriveMusicMotion(source, 1);
    expect(kick.bassPulse).toBeGreaterThan(0.8);
    expect(kick.treblePulse).toBe(0);
    expect(deriveMusicMotion(source, 1.16).bassPulse).toBeCloseTo(kick.bassPulse / Math.E, 10);
    expect(deriveMusicMotion(source, 2 - 1e-9).treblePulse).toBe(0);
    const shimmer = deriveMusicMotion(source, 2);
    expect(shimmer.treblePulse).toBeGreaterThan(0.7);
    expect(deriveMusicMotion(source, 2.08).treblePulse).toBeCloseTo(shimmer.treblePulse / Math.E, 10);
  });

  test("keeps the sustained bed moving after fast percussion has decayed", () => {
    const source = analysis((time) => frame({
      rms: time >= 1 && time < 2 ? 0.8 : 0,
      bass: time >= 1 && time < 2 ? 0.3 : 0,
    }));
    const after = deriveMusicMotion(source, 2.5);
    expect(after.sustain).toBeGreaterThan(0.45);
    expect(after.bassPulse).toBeLessThan(0.001);
    expect(deriveMusicMotion(source, 1 - 1e-9).sustain).toBe(0);
  });

  test("uses positive high-band changes even when the mean treble stays constant", () => {
    const source = analysis((time) => frame({
      treble: 0.1,
      spectrum: Float32Array.from({ length: 16 }, (_, index) =>
        index < 10 ? 0 : index % 2 === (time >= 1 ? 0 : 1) ? 0.2 : 0,
      ),
    }));
    expect(deriveMusicMotion(source, 1 - 1e-9).treblePulse).toBe(0);
    expect(deriveMusicMotion(source, 1).treblePulse).toBeGreaterThan(0.8);
    expect(deriveMusicMotion(source, 1).bassPulse).toBe(0);
  });

  test("normalizes quiet frequency bands independently and smooths them without anticipating notes", () => {
    const source = analysis((time) => frame({
      bass: time >= 1 ? 0.07 : 0,
      mid: time >= 1.5 ? 0.1 : 0,
      treble: time >= 2 ? 0.025 : 0,
    }));
    const beforeBass = deriveMusicMotion(source, 1 - 1e-9);
    expect(beforeBass.bassEnergy).toBe(0);
    expect(beforeBass.midEnergy).toBe(0);
    expect(beforeBass.trebleEnergy).toBe(0);
    expect(deriveMusicMotion(source, 1.2).bassEnergy).toBeGreaterThan(0.9);
    expect(deriveMusicMotion(source, 1.2).midEnergy).toBe(0);
    expect(deriveMusicMotion(source, 1.7).midEnergy).toBeGreaterThan(0.9);
    expect(deriveMusicMotion(source, 1.7).trebleEnergy).toBe(0);
    expect(deriveMusicMotion(source, 2.1).trebleEnergy).toBeGreaterThan(0.5);
    for (let index = 0; index < 240; index += 1) {
      const motion = deriveMusicMotion(source, index / 60);
      for (const key of ["bassEnergy", "midEnergy", "trebleEnergy", "bassPulse", "treblePulse", "sustain", "attack"] as const) {
        expect(motion[key]).toBeWithin(0, 1);
      }
    }
  });

  test("does not manufacture a first-frame hit or amplify silence noise", () => {
    const immediate = deriveMusicMotion(analysis(() => frame({ bass: 1, treble: 1, onset: 1 })), 0);
    expect(immediate.bassPulse).toBe(0);
    expect(immediate.treblePulse).toBe(0);
    expect(immediate.attack).toBe(0);
    const noise = analysis((time) => frame({
      rms: 0.0001,
      bass: (1 + Math.sin(time * 60)) * 0.0001,
      treble: (1 + Math.cos(time * 90)) * 0.0001,
    }));
    for (let index = 0; index < 180; index += 1) {
      const motion = deriveMusicMotion(noise, index / 60);
      expect(motion.bassPulse).toBe(0);
      expect(motion.treblePulse).toBe(0);
      expect(motion.sustain).toBe(0);
    }
  });

  test("sustained envelopes and transport do not depend on the analysis sampling rate", () => {
    const sample = (time: number) => frame({ rms: time >= 1 && time < 2 ? 0.8 : 0 });
    for (const time of [0.5, 1, 1.173, 1.9, 2, 2.615, 3]) {
      const low = deriveMusicMotion(analysis(sample, 24), time);
      const high = deriveMusicMotion(analysis(sample, 60), time);
      expect(low.sustain).toBeCloseTo(high.sustain, 10);
      expect(low.slowTime).toBeCloseTo(high.slowTime, 10);
      expect(low.fastTime).toBeCloseTo(high.fastTime, 10);
    }
    const bands = (time: number) => frame({
      bass: time >= 1 && time < 2 ? 0.3 : 0,
      mid: time >= 1 && time < 2 ? 0.2 : 0,
      treble: time >= 1 && time < 2 ? 0.08 : 0,
    });
    for (const time of [1.173, 2.615]) {
      const low = deriveMusicMotion(analysis(bands, 24), time);
      const high = deriveMusicMotion(analysis(bands, 60), time);
      expect(low.bassEnergy).toBeCloseTo(high.bassEnergy, 10);
      expect(low.midEnergy).toBeCloseTo(high.midEnergy, 10);
      expect(low.trebleEnergy).toBeCloseTo(high.trebleEnergy, 10);
    }
  });

  test("handles empty analyses and holds the final sample without transport discontinuities", () => {
    const empty = analysis(() => frame(), 30, 0);
    expect(deriveMusicMotion(empty, 2)).toEqual({
      slowTime: 0.4, fastTime: 2, bassPulse: 0, treblePulse: 0,
      bassEnergy: 0, midEnergy: 0, trebleEnergy: 0, attack: 0, sustain: 0,
    });
    const short = analysis(() => frame({ rms: 0.7 }), 30, 0.1);
    expect(deriveMusicMotion(short, 5).slowTime).toBeGreaterThan(4.9);
    expect(deriveMusicMotion(short, -1)).toEqual(deriveMusicMotion(short, 0));
    for (const value of Object.values(deriveMusicMotion(short, 5))) expect(Number.isFinite(value)).toBe(true);
  });
});
