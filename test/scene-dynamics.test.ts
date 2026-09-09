import { describe, expect, test } from "bun:test";
import { deriveSceneDynamics, SCENE_LAYER_NAMES } from "../src/render/scene-dynamics.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

const base = { drift: 0.04, cloud: 0.1, body: 0.24, detail: 0.6, spark: 1.2, impact: 0.08 };
const speed = { drift: 0.12, cloud: 0.28, body: 0.8, detail: 1.8, spark: 3.6, impact: 1.6 };
const delay = { drift: 0.18, cloud: 0.14, body: 0.08, detail: 0.04, spark: 0.015, impact: 0.025 };

function frame(spectrum = new Float32Array(64), onset = 0): AnalysisFrame {
  return { rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset,
    spectrum, waveform: new Float32Array(32) };
}

function source(sample: (time: number) => AnalysisFrame, fps = 60, duration = 8): AudioAnalysis {
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps, duration,
    spectrumBands: 64, waveformPoints: 32, sourceHash: "scene-dynamics", sourceFileHash: "scene-dynamics",
    frames: Array.from({ length: Math.ceil(fps * duration) }, (_, index) => sample(index / fps)),
  };
}

const burst = (time: number) => frame(new Float32Array(64).fill(time >= 1 && time < 2 ? 0.8 : 0), time === 1 ? 1 : 0);

describe("independent scene momentum tiers", () => {
  test("slower tiers keep gathering momentum while fast detail releases after a burst", () => {
    const analysis = source(burst);
    const before = deriveSceneDynamics(analysis, 1 - 1e-9);
    for (const layer of SCENE_LAYER_NAMES) expect(before[layer].energy).toBe(0);
    const start = deriveSceneDynamics(analysis, 2);
    const tail = deriveSceneDynamics(analysis, 3);
    for (const layer of SCENE_LAYER_NAMES) {
      expect(start[layer].energy).toBeGreaterThan(0.01);
    }
    // The slow cascade intentionally keeps moving after the driving sound has
    // ended; the fast tiers already release instead of tracking the same curve.
    expect(tail.drift.energy).toBeGreaterThan(start.drift.energy);
    expect(tail.cloud.energy).toBeGreaterThan(start.cloud.energy);
    expect(tail.body.energy).toBeLessThan(start.body.energy * 0.5);
    expect(tail.detail.energy).toBeLessThan(start.detail.energy * 0.08);
    expect(tail.spark.energy).toBeLessThan(start.spark.energy * 0.001);
    expect(tail.drift.energy).toBeGreaterThan(tail.spark.energy * 100);
    expect(tail.impact.energy).toBeGreaterThan(tail.detail.energy * 5);
  });

  test("fractional FFT ranges separate bass, mids and treble while retaining larger bass response", () => {
    const band = (low: number, high: number) => source(() => frame(Float32Array.from({ length: 64 }, (_, index) =>
      index / 64 >= low && index / 64 < high ? 0.8 : 0)));
    const bass = deriveSceneDynamics(band(0, 0.3), 6);
    const mids = deriveSceneDynamics(band(0.42, 0.66), 6);
    const treble = deriveSceneDynamics(band(0.75, 1), 6);
    expect(bass.body.energy).toBeGreaterThan(0.8);
    expect(bass.drift.energy).toBeGreaterThan(0.45);
    expect(bass.detail.energy).toBe(0);
    expect(bass.spark.energy).toBe(0);
    expect(mids.detail.energy).toBeGreaterThan(0.5);
    expect(mids.body.energy).toBe(0);
    expect(mids.spark.energy).toBe(0);
    expect(treble.spark.energy).toBeGreaterThan(0.35);
    expect(treble.body.energy).toBe(0);
    expect(treble.drift.energy).toBe(0);
    expect(bass.body.energy).toBeGreaterThan(treble.spark.energy * 2);
    // A sustained initial bass note does not manufacture an impact event.
    expect(bass.impact.energy).toBe(0);
  });

  test("momentum delays acceleration independently and keeps clock velocity continuous at attacks", () => {
    const analysis = source(burst);
    const velocity = (time: number) => {
      const dt = 1e-5;
      const left = deriveSceneDynamics(analysis, time - dt);
      const right = deriveSceneDynamics(analysis, time + dt);
      return Object.fromEntries(SCENE_LAYER_NAMES.map((layer) => [layer,
        ((right[layer].clock - left[layer].clock) / (2 * dt) - base[layer]) / speed[layer],
      ])) as Record<typeof SCENE_LAYER_NAMES[number], number>;
    };
    for (const momentum of Object.values(velocity(1))) expect(Math.abs(momentum)).toBeLessThan(1e-6);
    const accelerating = velocity(1.22);
    expect(accelerating.spark).toBeGreaterThan(accelerating.body);
    expect(accelerating.body).toBeGreaterThan(accelerating.cloud * 10);
    expect(accelerating.cloud).toBeGreaterThan(accelerating.drift * 5);
    // The displayed modulation is the same momentum value that determines
    // motion speed, rather than the sharper input envelope that drives it.
    for (const time of [1.4, 2.17, 3.5]) {
      const state = deriveSceneDynamics(analysis, time);
      const measured = velocity(time);
      for (const layer of SCENE_LAYER_NAMES) expect(measured[layer]).toBeCloseTo(state[layer].energy, 7);
    }
    const previous = deriveSceneDynamics(analysis, 2 - 1e-8);
    const next = deriveSceneDynamics(analysis, 2 + 1e-8);
    for (const layer of SCENE_LAYER_NAMES) {
      expect(next[layer].clock - previous[layer].clock).toBeGreaterThanOrEqual(0);
      expect(next[layer].clock - previous[layer].clock).toBeLessThan((base[layer] + speed[layer]) * 2.1e-8);
    }
  });

  test("adds different physical response delays without delaying idle drift", () => {
    const analysis = source(burst);
    for (const layer of SCENE_LAYER_NAMES) {
      const arrival = 1 + delay[layer];
      const before = deriveSceneDynamics(analysis, arrival - 1e-9)[layer];
      const after = deriveSceneDynamics(analysis, arrival + 0.025)[layer];
      expect(before.energy).toBe(0);
      expect(before.clock).toBeCloseTo(base[layer] * (arrival - 1e-9), 10);
      expect(after.energy).toBeGreaterThan(0);
      expect(after.clock).toBeGreaterThan(base[layer] * (arrival + 0.025));
      const atStart = deriveSceneDynamics(analysis, delay[layer] * 0.5)[layer];
      expect(atStart.energy).toBe(0);
      expect(atStart.clock).toBeCloseTo(base[layer] * delay[layer] * 0.5, 12);
    }
    const early = deriveSceneDynamics(analysis, 1.06);
    expect(early.spark.energy).toBeGreaterThan(early.detail.energy);
    expect(early.detail.energy).toBeGreaterThan(0);
    expect(early.body.energy).toBe(0);
    expect(early.cloud.energy).toBe(0);
    expect(early.drift.energy).toBe(0);
  });

  test("later loud sections cannot rescale earlier momentum, delays, or clock positions", () => {
    const quiet = (time: number) => frame(new Float32Array(64).fill(time >= 1 && time < 3 ? 0.06 : 0));
    const short = source(quiet, 30, 4);
    const extended = source(time => time < 4 ? quiet(time) : frame(new Float32Array(64).fill(1), 1), 30, 12);
    for (const time of [0, 0.8, 1.2, 2.7, 3.99]) {
      expect(deriveSceneDynamics(extended, time)).toEqual(deriveSceneDynamics(short, time));
    }
  });

  test("normalization recovery does not manufacture impacts in a sustained note", () => {
    const held = source(time => frame(new Float32Array(64).fill(time < 0.5 ? 0.8 : 0.2)), 60, 16);
    // The initial loud note is not a hit, and its only change is downward.
    // The reference later decays and increases gain, without creating onsets.
    for (const time of [0.5, 1, 4, 8, 15]) {
      expect(deriveSceneDynamics(held, time).impact.energy).toBe(0);
      expect(deriveSceneDynamics(held, time).impact.clock).toBeCloseTo(base.impact * time, 10);
    }
  });

  test("absolute seeks and rendering cadence reproduce the same six clocks", () => {
    const analysis = source(burst, 24);
    const expected = deriveSceneDynamics(analysis, 2.617);
    for (const time of [7.8, 0, 1.2, 4.6, 0.1]) deriveSceneDynamics(analysis, time);
    expect(deriveSceneDynamics(analysis, 2.617)).toEqual(expected);
    expect(deriveSceneDynamics(source(burst, 24), 2.617)).toEqual(expected);
    const frames = Array.from({ length: 60 }, (_, index) => deriveSceneDynamics(analysis, 1 + index / 60));
    for (const layer of SCENE_LAYER_NAMES) {
      expect(new Set(frames.map((value) => value[layer].clock)).size).toBe(60);
      for (let index = 1; index < frames.length; index += 1) {
        const delta = frames[index]![layer].clock - frames[index - 1]![layer].clock;
        expect(delta).toBeGreaterThanOrEqual(base[layer] / 60 - 1e-12);
        expect(delta).toBeLessThanOrEqual((base[layer] + speed[layer]) / 60 + 1e-12);
      }
    }
    // The continuous spectral envelopes and integrated momentum have the same
    // result when a piecewise-constant signal is analyzed at a different fps.
    const highRate = source(burst, 60);
    for (const layer of ["drift", "cloud", "body", "detail", "spark"] as const) {
      expect(deriveSceneDynamics(highRate, 2.617)[layer].energy).toBeCloseTo(expected[layer].energy, 10);
      expect(deriveSceneDynamics(highRate, 2.617)[layer].clock).toBeCloseTo(expected[layer].clock, 10);
    }
  });

  test("silence retains gentle separate drift, and empty or malformed analysis stays finite", () => {
    const silence = source(() => frame());
    const empty = { ...silence, frames: [] };
    for (const analysis of [silence, empty]) {
      const state = deriveSceneDynamics(analysis, 7.5);
      for (const layer of SCENE_LAYER_NAMES) {
        expect(state[layer].energy).toBe(0);
        expect(state[layer].clock).toBeCloseTo(7.5 * base[layer], 10);
      }
    }
    const malformed = { ...source(() => frame(Float32Array.from([NaN, Infinity, -1, 4]), NaN)), fps: NaN };
    for (const time of [-1, NaN, Infinity, 3, Number.MAX_VALUE]) {
      for (const layer of Object.values(deriveSceneDynamics(malformed, time))) {
        expect(Number.isFinite(layer.clock)).toBe(true);
        expect(layer.clock).toBeGreaterThanOrEqual(0);
        expect(layer.energy).toBeWithin(0, 1);
      }
    }
  });
});
