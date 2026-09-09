import { describe, expect, test } from "bun:test";
import { createResonanceFilaments, createResonancePlan, type ResonanceFilament } from "../src/render/resonance.js";
import { createSafeLayout } from "../src/render/layout.js";
import type { VisualState } from "../src/render/conductor.js";
import type { AnalysisFrame } from "../src/types.js";
import type { MusicMotion } from "../src/render/music-motion.js";

function frame(overrides: Partial<AnalysisFrame> = {}): AnalysisFrame {
  return {
    rms: 0.3,
    peak: 0.4,
    bass: 0.25,
    mid: 0.35,
    treble: 0.4,
    centroid: 0.5,
    flux: 0.2,
    onset: 0.1,
    spectrum: Float32Array.from({ length: 64 }, (_, index) => 0.08 + index / 100),
    waveform: Float32Array.from({ length: 192 }, (_, index) => Math.sin(index / 192 * Math.PI * 2) * 0.4),
    ...overrides,
  };
}

function visual(overrides: Partial<VisualState> = {}): VisualState {
  return { ambient: 0.5, drive: 0.35, peak: 0.15, beat: 0.2, trend: 0.1, motion: 0.55, chapter: 0.4, form: 0.45, ...overrides };
}

function motion(time: number, overrides: Partial<MusicMotion> = {}): MusicMotion {
  return {
    slowTime: time * 0.75, fastTime: time * 3,
    bassPulse: 0, treblePulse: 0,
    bassEnergy: 0.65, midEnergy: 0.45, trebleEnergy: 0.4,
    attack: 0, sustain: 0.65,
    ...overrides,
  };
}

/** Outer silhouette, independent of the way individual filaments circulate. */
function outline(filaments: ResonanceFilament[], centerX: number, centerY: number): number[] {
  const radii = Array<number>(64).fill(0);
  for (const strand of filaments) {
    for (const point of strand.points) {
      const x = point.x - centerX;
      const y = point.y - centerY;
      const sector = Math.min(63, Math.floor((Math.atan2(y, x) + Math.PI) / (Math.PI * 2) * 64));
      radii[sector] = Math.max(radii[sector]!, Math.hypot(x, y));
    }
  }
  const maximum = Math.max(...radii);
  return radii.map((radius) => radius / maximum);
}

/** Remove scale and in-plane rotation: neither alone counts as morphing. */
function silhouetteChange(left: number[], right: number[]): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < left.length; shift += 1) {
    const squared = left.reduce((sum, radius, index) =>
      sum + (radius - right[(index + shift) % right.length]!) ** 2, 0);
    smallest = Math.min(smallest, Math.sqrt(squared / left.length));
  }
  return smallest;
}

function largestDisplacement(left: ResonanceFilament[], right: ResonanceFilament[]): number {
  let largest = 0;
  for (let strand = 0; strand < left.length; strand += 1) {
    for (let point = 0; point < (left[strand]?.points.length ?? 0); point += 1) {
      const a = left[strand]?.points[point];
      const b = right[strand]?.points[point];
      if (a && b) largest = Math.max(largest, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return largest;
}

describe("harmonic resonance sculpture", () => {
  test("is seedable, closed, and independent of the order in which song times are rendered", () => {
    const plan = createResonancePlan("resonance");
    const layout = createSafeLayout(1920, 1080);
    const result = createResonanceFilaments(plan, frame(), visual(), layout, 9.4, true);
    createResonanceFilaments(plan, frame(), visual(), layout, 132, true);
    expect(createResonanceFilaments(plan, frame(), visual(), layout, 9.4, true)).toEqual(result);
    expect(createResonancePlan("resonance")).toEqual(plan);
    expect(createResonancePlan("another-song")).not.toEqual(plan);
    expect(result).toHaveLength(72);
    for (const strand of result) {
      expect(strand.points).toHaveLength(241);
      expect(strand.points[0]).toEqual(strand.points.at(-1));
      expect(strand.points.some((point) => point.depth < 0.5)).toBe(true);
      expect(strand.points.some((point) => point.depth >= 0.5)).toBe(true);
    }
  });

  test("retains camera and glow clearance at full energy across aspect ratios and rotations", () => {
    const plan = createResonancePlan("full-energy");
    const loud = frame({ bass: 1, mid: 1, treble: 1, spectrum: new Float32Array(128).fill(1), waveform: new Float32Array(192).fill(1) });
    const peak = visual({ drive: 1, peak: 1, beat: 1 });
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [360, 1920]] as const) {
      const layout = createSafeLayout(width, height);
      for (const time of [0, 13, 47, 134, 600]) {
        const result = createResonanceFilaments(plan, loud, peak, layout, time, false);
        for (const strand of result) {
          expect(strand.alpha).toBeWithin(0, 1);
          expect(strand.depth).toBeWithin(0, 1);
          for (const point of strand.points) {
            // Reserve additional headroom for camera motion and emission.
            expect(layout.centerX + (point.x - layout.centerX) * 1.07).toBeWithin(layout.left, layout.right);
            expect(layout.horizon + (point.y - layout.horizon) * 1.07).toBeWithin(layout.graphTop, layout.graphBottom);
            expect(point.depth).toBeWithin(0, 1);
            expect(point.energy).toBeWithin(0, 1);
          }
        }
      }
    }
  });

  test("moves continuously and never turns audio energy into a time-dependent rotation jump", () => {
    const plan = createResonancePlan("motion");
    const layout = createSafeLayout(1920, 1080);
    const sample = (time: number, state = visual()) => createResonanceFilaments(plan, frame(), state, layout, time, true);
    expect(largestDisplacement(sample(8), sample(8 + 1 / 60))).toBeWithin(0.001, 2);
    expect(largestDisplacement(sample(8), sample(18))).toBeGreaterThan(10);
    // At the end of a long song, a small energy change must still make only a
    // small deformation: multiplying absolute time by drive would fail this.
    const late = sample(3_600);
    expect(largestDisplacement(late, sample(3_600, visual({ drive: 0.36, peak: 0.16, motion: 0.56 })))).toBeLessThan(0.75);
  });

  test("visibly morphs its outline within one second, beyond uniform zoom or rotation", () => {
    const layout = createSafeLayout(1920, 1080);
    const audio = frame({ bass: 0, mid: 0, treble: 0, spectrum: new Float32Array(64), waveform: new Float32Array(192) });
    // Include the showcase seed: its initial nearly edge-on view must not keep
    // it looking like the same flattened ring throughout a short music clip.
    for (const seed of ["shape-dynamics", "loop-smoke"]) {
      const plan = createResonancePlan(seed);
      const sample = (time: number) => outline(
        createResonanceFilaments(plan, audio, visual(), layout, time, true, motion(time)),
        layout.centerX, layout.horizon,
      );
      // More than 3.5% RMS silhouette change survives the best rotation/scale
      // alignment. A static torus with moving strands would fail this check.
      for (const time of [0, 2, 4]) {
        expect(silhouetteChange(sample(time), sample(time + 1))).toBeGreaterThan(0.035);
      }
    }
  });

  test("equal band amplitudes give bass the largest physical deformation", () => {
    const plan = createResonancePlan("shape-dynamics");
    const layout = createSafeLayout(1920, 1080);
    const audio = frame({ bass: 0, mid: 0, treble: 0, spectrum: new Float32Array(64), waveform: new Float32Array(192) });
    for (const time of [0, 2, 6, 19]) {
      const quiet = motion(time, { bassEnergy: 0, midEnergy: 0, trebleEnergy: 0 });
      const sample = (overrides: Partial<MusicMotion> = {}) =>
        createResonanceFilaments(plan, audio, visual(), layout, time, true, { ...quiet, ...overrides });
      const baseline = sample();
      const bass = largestDisplacement(baseline, sample({ bassEnergy: 0.75 }));
      const mids = largestDisplacement(baseline, sample({ midEnergy: 0.75 }));
      const treble = largestDisplacement(baseline, sample({ trebleEnergy: 0.75 }));
      expect(bass).toBeGreaterThan(20);
      expect(bass).toBeGreaterThan(mids * 1.5);
      expect(mids).toBeGreaterThan(treble * 1.5);
    }
  });

  test("musical morphing has smooth frame-to-frame velocity even late in a song", () => {
    const plan = createResonancePlan("shape-dynamics");
    const layout = createSafeLayout(1920, 1080);
    const sample = (time: number, overrides: Partial<MusicMotion> = {}) =>
      createResonanceFilaments(plan, frame(), visual(), layout, time, true, motion(time, overrides));
    for (const time of [8, 120, 3_600]) {
      const before = sample(time - 1 / 60);
      const current = sample(time);
      const after = sample(time + 1 / 60);
      let velocityChange = 0;
      for (let strand = 0; strand < current.length; strand += 1) {
        for (let point = 0; point < current[strand]!.points.length; point += 1) {
          const a = before[strand]!.points[point]!;
          const b = current[strand]!.points[point]!;
          const c = after[strand]!.points[point]!;
          velocityChange = Math.max(velocityChange, Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y));
        }
      }
      // Fast motion is intentional; discontinuous changes of velocity are not.
      expect(velocityChange).toBeLessThan(0.15);
      expect(largestDisplacement(current, sample(time, { bassEnergy: 0.66 }))).toBeLessThan(1);
      createResonanceFilaments(plan, frame(), visual(), layout, 13, true, motion(13));
      expect(sample(time)).toEqual(current);
    }
  });

  test("responds to spectral color and coherent waveforms while filtering alternating PCM spikes", () => {
    const plan = createResonancePlan("audio-response");
    const layout = createSafeLayout(1920, 1080);
    const sample = (audio: AnalysisFrame) => createResonanceFilaments(plan, audio, visual(), layout, 7, true);
    const quiet = frame({ spectrum: new Float32Array(64), waveform: new Float32Array(192) });
    const baseline = sample(quiet);
    const spectral = sample({ ...quiet, spectrum: new Float32Array(64).fill(1) });
    const bass = sample({ ...quiet, bass: 1 });
    const harmonic = sample({ ...quiet, waveform: Float32Array.from({ length: 192 }, (_, index) => Math.sin(index / 192 * Math.PI * 2)) });
    const noisy = sample({ ...quiet, waveform: Float32Array.from({ length: 192 }, (_, index) => index % 2 ? 1 : -1) });
    expect(largestDisplacement(baseline, spectral)).toBeGreaterThan(10);
    expect(largestDisplacement(baseline, bass)).toBeGreaterThan(10);
    expect(largestDisplacement(baseline, harmonic)).toBeGreaterThan(0.5);
    expect(largestDisplacement(baseline, noisy)).toBeLessThan(1e-8);
    expect(spectral[0]?.points[0]?.energy ?? 0).toBeGreaterThan(baseline[0]?.points[0]?.energy ?? 0);
  });

  test("caps rapid beat accents without reducing sustained musical response", () => {
    const plan = createResonancePlan("low-flash");
    const layout = createSafeLayout(1920, 1080);
    const sample = (beat: number, lowFlash: boolean) => createResonanceFilaments(plan, frame(), visual({ beat }), layout, 4, lowFlash);
    const capped = sample(1, true);
    expect(capped).toEqual(sample(0.3, true));
    expect(sample(0.2, true)).toEqual(sample(0.2, false));
    const unrestricted = sample(1, false);
    expect(unrestricted[0]?.alpha ?? 0).toBeGreaterThan(capped[0]?.alpha ?? 0);
    expect(largestDisplacement(capped, unrestricted)).toBeWithin(0.01, 1.5);
  });

  test("accepts empty audio buffers and clamps non-finite or out-of-range analysis values", () => {
    const result = createResonanceFilaments(
      createResonancePlan("empty"),
      frame({ bass: Number.NaN, mid: 2, treble: -1, spectrum: new Float32Array(), waveform: new Float32Array() }),
      visual({ beat: Number.POSITIVE_INFINITY }),
      createSafeLayout(640, 360),
      0,
      true,
    );
    for (const strand of result) {
      for (const point of strand.points) {
        for (const value of Object.values(point)) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});
