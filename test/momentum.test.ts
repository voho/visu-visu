import { describe, expect, test } from "bun:test";
import { analyzeAudio } from "../src/audio/analyze.js";
import { HIT_LIFETIME, type HitEvent } from "../src/render/hit-plan.js";
import { MOMENTUM_TAU, momentumAt, momentumKernel, punchAt } from "../src/render/momentum.js";
import type { AudioPcm } from "../src/types.js";

const hit = (age: number, strength = 1, kick = 1): HitEvent => ({ time: 10 - age, age, strength, bassShare: kick, kick });

describe("momentum kernel", () => {
  test("starts at rest, peaks at tau and is gone by five tau", () => {
    expect(momentumKernel(0, 0.1)).toBe(0);
    expect(momentumKernel(-0.05, 0.1)).toBe(0);
    expect(momentumKernel(0.001, 0.1)).toBeLessThan(1e-3);
    expect(momentumKernel(0.1, 0.1)).toBeCloseTo(1, 12);
    expect(momentumKernel(0.5, 0.1)).toBeLessThan(0.01);
    let previous = 0;
    for (let step = 1; step <= 20; step += 1) {
      const value = momentumKernel(step * 0.005, 0.1);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
    for (let step = 21; step <= 120; step += 1) {
      const value = momentumKernel(step * 0.005, 0.1);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
    expect(momentumKernel(Number.NaN, 0.1)).toBe(0);
    expect(momentumKernel(0.1, 0)).toBe(0);
  });

  test("weights kicks over hats, sums live hits, and tapers out before the lifetime ends", () => {
    expect(punchAt([], 0.1)).toBe(0);
    expect(punchAt([hit(0.1)], 0.1)).toBeCloseTo(1, 12);
    expect(punchAt([hit(0.1, 1, 0)], 0.1)).toBeCloseTo(0.35, 12);
    expect(punchAt([hit(0.1, 0.5)], 0.1)).toBeCloseTo(0.5, 12);
    // Overlapping pushes add a little and saturate softly: still rising, never past 1.25.
    const two = punchAt([hit(0.1), hit(0.1)], 0.1);
    expect(two).toBeGreaterThan(1);
    expect(two).toBeLessThan(1.25);
    expect(punchAt([hit(0.1), hit(0.1), hit(0.1)], 0.1)).toBeGreaterThan(two);
    expect(punchAt([hit(0.1), hit(0.1), hit(0.1)], 0.1)).toBeLessThanOrEqual(1.25);
    expect(punchAt([hit(0.1, 0.79)], 0.1)).toBeCloseTo(0.79, 12);
    expect(punchAt([hit(HIT_LIFETIME)], MOMENTUM_TAU.push)).toBe(0);
    expect(punchAt([hit(HIT_LIFETIME - 0.2)], MOMENTUM_TAU.push)).toBeGreaterThan(0);
  });
});

describe("momentum from the hit plan", () => {
  const sampleRate = 24_000;
  const fps = 60;
  const pcm: AudioPcm = {
    samples: Float32Array.from({ length: sampleRate * 4 }, (_, index) =>
      Math.sin((2 * Math.PI * 180 * index) / sampleRate) * 0.55),
    sampleRate,
    duration: 4,
    sourceHash: "momentum",
    sourceFileHash: "momentum-file",
  };
  const analysis = analyzeAudio(pcm, fps, 32);
  // An onset every 0.5 s; the plan keeps them all (0.5 s > the refractory).
  for (let index = 30; index < analysis.frames.length; index += 30) analysis.frames[index]!.onset = 1;

  test("rises over several frames with heavier masses moving later and slower", () => {
    const hitTime = 1.5;
    const atHit = momentumAt(analysis, hitTime);
    // Nothing steps on the hit frame: only the previous hit's faint tail is there.
    const beforeHit = momentumAt(analysis, hitTime - 1 / fps);
    for (const key of ["push", "camera", "glow", "body", "flick"] as const) {
      expect(atHit[key]).toBeLessThan(0.05);
      expect(Math.abs(atHit[key] - beforeHit[key])).toBeLessThan(0.01);
    }
    const peaks = { push: 0, camera: 0, glow: 0, body: 0, flick: 0 };
    const peakAges = { push: 0, camera: 0, glow: 0, body: 0, flick: 0 };
    const steps = { push: 0, camera: 0, glow: 0, body: 0, flick: 0 };
    let previous = atHit;
    for (let frame = 1; frame <= fps * 0.45; frame += 1) {
      const current = momentumAt(analysis, hitTime + frame / fps);
      for (const key of ["push", "camera", "glow", "body", "flick"] as const) {
        steps[key] = Math.max(steps[key], Math.abs(current[key] - previous[key]));
        if (current[key] > peaks[key]) { peaks[key] = current[key]; peakAges[key] = frame / fps; }
      }
      previous = current;
    }
    for (const key of ["push", "camera", "glow", "body", "flick"] as const) {
      expect(peaks[key]).toBeGreaterThan(0.2);
      expect(Math.abs(peakAges[key] - MOMENTUM_TAU[key])).toBeLessThanOrEqual(1 / fps);
    }
    // The room needs eight or more frames at 60 fps to reach its peak; light may flick.
    expect(steps.push).toBeLessThanOrEqual(0.2);
    expect(steps.camera).toBeLessThanOrEqual(0.25);
    expect(steps.glow).toBeLessThanOrEqual(0.25);
    expect(steps.body).toBeLessThanOrEqual(0.32);
    expect(steps.flick).toBeGreaterThan(steps.push);
  });

  test("stays continuous through the densest hit train the plan allows", () => {
    const dense = analyzeAudio(pcm, fps, 32);
    // A hit every 0.35 s, just over the refractory: up to two are live at once.
    for (let index = 21; index < dense.frames.length; index += 21) dense.frames[index]!.onset = 1;
    const steps = { push: 0, camera: 0, glow: 0, body: 0, flick: 0 };
    let previous = momentumAt(dense, 0.5);
    for (let frame = 1; frame <= fps * 3; frame += 1) {
      const current = momentumAt(dense, 0.5 + frame / fps);
      for (const key of ["push", "camera", "glow", "body", "flick"] as const) {
        expect(current[key]).toBeGreaterThanOrEqual(0);
        expect(current[key]).toBeLessThanOrEqual(1.25);
        steps[key] = Math.max(steps[key], Math.abs(current[key] - previous[key]));
      }
      previous = current;
    }
    expect(steps.push).toBeLessThanOrEqual(0.2);
    expect(steps.camera).toBeLessThanOrEqual(0.25);
    expect(steps.glow).toBeLessThanOrEqual(0.25);
    expect(steps.body).toBeLessThanOrEqual(0.35);
    expect(steps.flick).toBeLessThanOrEqual(0.5);
  });

  test("is a pure function of absolute time", () => {
    const direct = momentumAt(analysis, 1.62);
    momentumAt(analysis, 3.9);
    momentumAt(analysis, 0.1);
    expect(momentumAt(analysis, 1.62)).toEqual(direct);
    expect(momentumAt(analysis, Number.NaN)).toEqual({ push: 0, camera: 0, glow: 0, body: 0, flick: 0 });
  });
});
