import { describe, expect, test } from "bun:test";
import { FLASH_MAX_RATE, HIT_LIFETIME, HIT_REFRACTORY, LOW_FLASH_RING_ALPHA, hitEventsAt, hitRingAlpha, hitRingReach, hitVariation } from "../src/render/hit-plan.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

const FPS = 60;

function frame(overrides: Partial<AnalysisFrame> = {}): AnalysisFrame {
  return {
    rms: 0.3, peak: 0.3, bass: 0.3, mid: 0.3, treble: 0.3, centroid: 0.4, flux: 0, onset: 0,
    spectrum: new Float32Array(16), waveform: new Float32Array(16), ...overrides,
  };
}

/** Onsets at the given times (seconds) with the given strengths; every other frame is silent. */
function analysis(onsets: Array<[time: number, strength: number, bands?: Partial<AnalysisFrame>]>, duration = 12): AudioAnalysis {
  const frames = Array.from({ length: Math.ceil(FPS * duration) }, () => frame());
  for (const [time, strength, bands] of onsets) {
    const index = Math.round(time * FPS);
    frames[index] = frame({ onset: strength, ...bands });
  }
  return {
    version: ANALYSIS_VERSION, sampleRate: 48_000, fps: FPS, duration,
    spectrumBands: 16, waveformPoints: 16, sourceHash: "hits", sourceFileHash: "hits", frames,
  };
}

describe("cached hit plan", () => {
  test("never anticipates a hit and drops it after its lifetime", () => {
    const source = analysis([[2, 0.8]]);
    expect(hitEventsAt(source, 2 - 1e-9)).toEqual([]);
    const [hit] = hitEventsAt(source, 2);
    expect(hit).toBeDefined();
    expect(hit!.age).toBe(0);
    expect(hit!.time).toBe(2);
    expect(hitEventsAt(source, 2 + HIT_LIFETIME - 1e-6)).toHaveLength(1);
    expect(hitEventsAt(source, 2 + HIT_LIFETIME + 1e-6)).toEqual([]);
    expect(hitEventsAt(source, Number.NaN)).toEqual([]);
    expect(hitEventsAt(source, -1)).toEqual([]);
    expect(hitEventsAt({ ...source, frames: [] }, 1)).toEqual([]);
  });

  test("keeps one of two onsets 0.1 s apart, the stronger one, and never exceeds the flash rate", () => {
    const pair = analysis([[3, 0.5], [3.1, 0.9]]);
    const live = hitEventsAt(pair, 3.2);
    expect(live).toHaveLength(1);
    expect(live[0]!.time).toBe(3.1);
    // A dense pattern (every 0.1 s for 4 s) thins to at most FLASH_MAX_RATE hits per second.
    const dense = analysis(Array.from({ length: 40 }, (_, index) => [4 + index * 0.1, 0.7 + (index % 3) * 0.1]));
    const kept = new Set<number>();
    for (let time = 4; time <= 8.8; time += 1 / FPS) for (const hit of hitEventsAt(dense, time)) kept.add(hit.time);
    const times = [...kept].sort((left, right) => left - right);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(HIT_REFRACTORY - 1e-9);
    }
    expect(times.length).toBeLessThanOrEqual(Math.ceil(4 * FLASH_MAX_RATE) + 1);
    expect(times.length).toBeGreaterThanOrEqual(6);
  });

  test("ranks a lone weak onset lowest among clipped equals and reads the onset frame's bass share", () => {
    const strong = Array.from({ length: 6 }, (_, index): [number, number] => [1 + index * 0.5, 1]);
    const source = analysis([...strong, [4.2, 0.6]], 12);
    const weak = hitEventsAt(source, 4.2)[0]!;
    const clipped = hitEventsAt(source, 3.5)[0]!;
    expect(weak.time).toBe(4.2);
    expect(weak.strength).toBeLessThan(clipped.strength);
    expect(weak.strength).toBeCloseTo(0.3, 6);
    // Equals tie at rank 0.5, so a clipped run sizes to ~0.75 and a rare louder hit can still exceed it.
    expect(clipped.strength).toBeWithin(0.75, 0.85);
    const kick = analysis([[2, 1, { bass: 0.9, mid: 0.05, treble: 0.05 }]]);
    const hat = analysis([[2, 1, { bass: 0.02, mid: 0.08, treble: 0.9 }]]);
    expect(hitEventsAt(kick, 2)[0]!.bassShare).toBeGreaterThan(0.85);
    expect(hitEventsAt(hat, 2)[0]!.bassShare).toBeLessThan(0.05);
    // A kicks-only or hats-only track still lands whole on one side of the split.
    expect(hitEventsAt(kick, 2)[0]!.kick).toBe(1);
    expect(hitEventsAt(hat, 2)[0]!.kick).toBe(0);
    // A mixed track splits at its own median bass share: the same 0.5 share is a
    // kick among hats and a hat among kicks.
    const hats = Array.from({ length: 8 }, (_, index): [number, number, Partial<AnalysisFrame>] =>
      [1 + index, 1, { bass: 0.2, mid: 0.4, treble: 0.4 }]);
    const kicks = hats.map(([time, strength]): [number, number, Partial<AnalysisFrame>] =>
      [time, strength, { bass: 0.8, mid: 0.1, treble: 0.1 }]);
    const middle: [number, number, Partial<AnalysisFrame>] = [9.5, 1, { bass: 0.5, mid: 0.25, treble: 0.25 }];
    expect(hitEventsAt(analysis([...hats, middle], 12), 9.5)[0]!.kick).toBe(1);
    expect(hitEventsAt(analysis([...kicks, middle], 12), 9.5)[0]!.kick).toBe(0);
  });

  test("returns the newest hits first, at most three, identically for direct seeks and sequential queries", () => {
    const onsets = Array.from({ length: 30 }, (_, index): [number, number] => [1 + index * 0.37, 0.4 + (index % 5) * 0.12]);
    const source = analysis(onsets, 14);
    const direct = hitEventsAt(source, 7.31);
    expect(direct.length).toBeWithin(1, 3);
    for (let index = 1; index < direct.length; index += 1) expect(direct[index]!.age).toBeGreaterThan(direct[index - 1]!.age);
    const sequential = analysis(onsets, 14);
    for (let time = 0; time < 7.31; time += 1 / FPS) hitEventsAt(sequential, time);
    expect(hitEventsAt(sequential, 7.31)).toEqual(direct);
    for (const time of [13, 0.2, 9.9, 7.31, 2.5]) hitEventsAt(source, time);
    expect(hitEventsAt(source, 7.31)).toEqual(direct);
  });

  test("ring light ramps in over 50 ms in both modes, never exceeds the lowFlash cap and fades out by the lifetime", () => {
    expect(hitRingAlpha(0, 1, true)).toBe(0);
    expect(hitRingAlpha(0, 1, false)).toBe(0);
    expect(hitRingAlpha(0.05, 1, false)).toBeGreaterThan(0.5);
    expect(hitRingAlpha(0.025, 1, false)).toBeGreaterThan(0);
    expect(hitRingAlpha(0.025, 1, false)).toBeLessThan(hitRingAlpha(0.05, 1, false));
    let peak = 0;
    for (let age = 0; age <= HIT_LIFETIME + 0.1; age += 0.005) {
      for (const size of [0.2, 0.6, 1, 4]) {
        const alpha = hitRingAlpha(age, size, true, 1.5);
        expect(alpha).toBeLessThanOrEqual(LOW_FLASH_RING_ALPHA);
        expect(alpha).toBeGreaterThanOrEqual(0);
        peak = Math.max(peak, alpha);
      }
    }
    expect(peak).toBe(LOW_FLASH_RING_ALPHA);
    expect(hitRingAlpha(HIT_LIFETIME, 1, false)).toBe(0);
    expect(hitRingAlpha(0.2, 0.5, true)).toBeLessThan(hitRingAlpha(0.2, 1, true));
    expect(hitRingAlpha(0.2, 1, true, 0)).toBe(0);
  });

  test("ring reach grows monotonically from its start, bigger for bigger hits, and never past the clip fit", () => {
    for (const fit of [0.8, 0.97, 1.2]) {
      for (const size of [0, 0.3, 0.6, 1]) {
        let previous = -1;
        for (let age = 0; age <= HIT_LIFETIME + 0.1; age += 0.01) {
          const reach = hitRingReach(age, size, fit);
          expect(reach).toBeGreaterThanOrEqual(previous - 1e-12);
          expect(reach).toBeLessThanOrEqual(fit + 1e-12);
          previous = reach;
        }
      }
      expect(hitRingReach(0, 1, fit)).toBeCloseTo(Math.min(0.5, fit), 9);
      expect(hitRingReach(HIT_LIFETIME, 1, fit)).toBeCloseTo(fit, 9);
    }
    // A quiet tap stops well inside the reserve; a full hit is only limited by the clip.
    expect(hitRingReach(HIT_LIFETIME, 0.3, 1.2)).toBeLessThan(0.8);
    expect(hitRingReach(HIT_LIFETIME, 0.3, 1.2)).toBeLessThan(hitRingReach(HIT_LIFETIME, 1, 1.2));
    // Half the lifetime already covers most of the growth (ease-out).
    expect(hitRingReach(HIT_LIFETIME / 2, 1, 1)).toBeGreaterThan(0.5 + 0.5 * 0.7);
    // A clip too small for the start radius returns the fit itself, never a negative or NaN reach.
    expect(hitRingReach(0.1, 1, 0.2)).toBe(0.2);
    expect(hitRingReach(0.1, 1, -1)).toBe(0);
  });
});

describe("hit ring variation", () => {
  test("is fixed by the seed and the hit's time, differs between hits, and stays within its ranges", () => {
    const first = hitVariation("seed-a", { time: 12.5 });
    expect(hitVariation("seed-a", { time: 12.5 })).toEqual(first);
    expect(hitVariation("seed-a", { time: 12.5 + 1e-6 })).toEqual(first);
    expect(hitVariation("seed-b", { time: 12.5 })).not.toEqual(first);
    expect(hitVariation("seed-a", { time: 13.0 })).not.toEqual(first);
    for (let index = 0; index < 200; index += 1) {
      const variation = hitVariation("seed-a", { time: index * 0.37 });
      expect(variation.diameter).toBeGreaterThanOrEqual(0.82);
      expect(variation.diameter).toBeLessThanOrEqual(1.18);
      expect(variation.ratio).toBeGreaterThanOrEqual(0.78);
      expect(variation.ratio).toBeLessThanOrEqual(1.22);
      expect(variation.thickness).toBeGreaterThanOrEqual(0.7);
      expect(variation.thickness).toBeLessThanOrEqual(1.4);
      expect(Math.abs(variation.tilt)).toBeLessThanOrEqual(0.3);
      expect(variation.drift).toBeGreaterThanOrEqual(0.05);
      expect(variation.drift).toBeLessThanOrEqual(0.14);
      expect(variation.driftAngle).toBeGreaterThanOrEqual(0);
      expect(variation.driftAngle).toBeLessThanOrEqual(Math.PI * 2);
    }
  });
});
