import { describe, expect, test } from "bun:test";
import {
  createRibbonPlan,
  createSpectralRibbonPoints,
  deriveDynamicGrade,
  visualTransient,
} from "../src/render/reactive-effects.js";
import { createSafeLayout } from "../src/render/layout.js";
import { LOW_FLASH_TRANSIENT_CAP, type VisualState } from "../src/render/conductor.js";
import type { AnalysisFrame } from "../src/types.js";

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
    waveform: Float32Array.from({ length: 64 }, (_, index) =>
      Math.sin((index / 63) * Math.PI * 2) * 0.4,
    ),
    ...overrides,
  };
}

function visual(overrides: Partial<VisualState> = {}): VisualState {
  return {
    ambient: 0.5,
    drive: 0.35,
    peak: 0.15,
    beat: 0.2,
    trend: 0.1,
    motion: 0.55,
    chapter: 0.4,
    form: 0.45,
    warmth: 0.5,
    ...overrides,
  };
}

function expectFiniteRecord(record: object): void {
  for (const value of Object.values(record)) {
    if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
  }
}

function distance(
  left: { x: number; y: number },
  right: { x: number; y: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

describe("spectral event-horizon ribbon", () => {
  test("creates a seeded, direct-seek deterministic volumetric ribbon", () => {
    const layout = createSafeLayout(1920, 1080);
    const plan = createRibbonPlan("fixed-ribbon");
    const points = createSpectralRibbonPoints(frame(), visual(), layout, 12.5, plan);
    const replayed = createSpectralRibbonPoints(frame(), visual(), layout, 12.5, plan);

    expect(plan).toEqual(createRibbonPlan("fixed-ribbon"));
    expect(createRibbonPlan("other-ribbon")).not.toEqual(plan);
    expect(points).toEqual(replayed);
    expect(points).toHaveLength(128);
    expect(points.some((point) => point.front)).toBe(true);
    expect(points.some((point) => !point.front)).toBe(true);

    for (const point of points) {
      expectFiniteRecord(point);
      expect(point.x).toBeWithin(layout.left, layout.right);
      expect(point.y).toBeWithin(layout.graphTop, layout.graphBottom);
      expect(point.leftX).toBeWithin(layout.left, layout.right);
      expect(point.leftY).toBeWithin(layout.graphTop, layout.graphBottom);
      expect(point.rightX).toBeWithin(layout.left, layout.right);
      expect(point.rightY).toBeWithin(layout.graphTop, layout.graphBottom);
      expect(point.depth).toBeGreaterThanOrEqual(0);
      expect(point.depth).toBeLessThanOrEqual(1);
      expect(point.front).toBe(point.depth >= 0.5);
      expect(point.energy).toBeGreaterThanOrEqual(0);
      expect(point.energy).toBeLessThanOrEqual(1);
      expect(point.progress).toBeGreaterThanOrEqual(0);
      expect(point.progress).toBeLessThanOrEqual(1);
      expect(point.hue).toBeGreaterThanOrEqual(0);
      expect(point.hue).toBeLessThan(360);
      expect(point.halfWidth).toBeGreaterThan(0);
      expect(point.waveform).toBeWithin(-1, 1);
      expect(point.emission).toBeGreaterThanOrEqual(0);
      expect(point.emission).toBeLessThanOrEqual(1);
    }

    const otherTime = createSpectralRibbonPoints(frame(), visual(), layout, 13.5, plan);
    expect(otherTime).not.toEqual(points);
  });

  test("keeps extreme ribbon centers and edges inside all platform graph bounds", () => {
    const loudFrame = frame({
      rms: 1,
      bass: 1,
      mid: 1,
      treble: 1,
      spectrum: Float32Array.from({ length: 128 }, () => 1),
      waveform: Float32Array.from({ length: 192 }, (_, index) =>
        index % 2 === 0 ? 1 : -1,
      ),
    });
    const loudVisual = visual({
      ambient: 0,
      drive: 0,
      peak: 1,
      beat: 1,
      motion: 1,
      chapter: 1,
      form: 1,
    });

    for (const layout of [
      createSafeLayout(1920, 1080),
      createSafeLayout(1080, 1080),
      createSafeLayout(1080, 1920),
    ]) {
      const points = createSpectralRibbonPoints(
        loudFrame,
        loudVisual,
        layout,
        7,
        createRibbonPlan("extreme-ribbon"),
        { lowFlash: false, samples: 256 },
      );
      for (const point of points) {
        for (const x of [point.x, point.leftX, point.rightX]) {
          expect(x).toBeWithin(layout.left, layout.right);
        }
        for (const y of [point.y, point.leftY, point.rightY]) {
          expect(y).toBeWithin(layout.graphTop, layout.graphBottom);
        }
      }
    }
  });

  test("uses waveform samples to deform opposite ribbon edges without moving its center", () => {
    const layout = createSafeLayout(1920, 1080);
    const plan = createRibbonPlan("waveform-edges");
    const common = frame({ spectrum: Float32Array.from({ length: 64 }, () => 0.55) });
    const neutral = createSpectralRibbonPoints(
      { ...common, waveform: Float32Array.from({ length: 64 }, () => 0) },
      visual(),
      layout,
      4,
      plan,
      { samples: 64 },
    );
    const positive = createSpectralRibbonPoints(
      { ...common, waveform: Float32Array.from({ length: 64 }, () => 1) },
      visual(),
      layout,
      4,
      plan,
      { samples: 64 },
    );
    const index = 31;
    const base = neutral[index];
    const shaped = positive[index];
    expect(base).toBeDefined();
    expect(shaped).toBeDefined();
    if (!base || !shaped) return;

    expect(shaped.x).toBeCloseTo(base.x, 10);
    expect(shaped.y).toBeCloseTo(base.y, 10);
    expect(
      distance({ x: shaped.x, y: shaped.y }, { x: shaped.leftX, y: shaped.leftY }),
    ).toBeGreaterThan(
      distance({ x: base.x, y: base.y }, { x: base.leftX, y: base.leftY }),
    );
    expect(
      distance({ x: shaped.x, y: shaped.y }, { x: shaped.rightX, y: shaped.rightY }),
    ).toBeLessThan(
      distance({ x: base.x, y: base.y }, { x: base.rightX, y: base.rightY }),
    );
  });

  test("caps beat-driven ribbon width and emission in low-flash mode", () => {
    const layout = createSafeLayout(1920, 1080);
    const plan = createRibbonPlan("ribbon-low-flash");
    const capped = createSpectralRibbonPoints(
      frame(),
      visual({ beat: 1 }),
      layout,
      2,
      plan,
      { lowFlash: true, samples: 64 },
    );
    const threshold = createSpectralRibbonPoints(
      frame(),
      visual({ beat: LOW_FLASH_TRANSIENT_CAP }),
      layout,
      2,
      plan,
      { lowFlash: true, samples: 64 },
    );
    const unrestricted = createSpectralRibbonPoints(
      frame(),
      visual({ beat: 1 }),
      layout,
      2,
      plan,
      { lowFlash: false, samples: 64 },
    );

    expect(capped).toEqual(threshold);
    expect(unrestricted[32]?.halfWidth ?? 0).toBeGreaterThan(capped[32]?.halfWidth ?? 0);
    expect(unrestricted[32]?.emission ?? 0).toBeGreaterThan(capped[32]?.emission ?? 0);
  });
});

describe("dynamic color grade", () => {
  test("stays bounded and grows from quiet ambience into a peak", () => {
    const quiet = deriveDynamicGrade(visual({ ambient: 1, drive: 0, peak: 0, beat: 0 }), true);
    const peak = deriveDynamicGrade(visual({ ambient: 0, drive: 0.4, peak: 0.6, beat: 1 }), true);

    expect(peak.bloom).toBeGreaterThan(quiet.bloom);
    expect(peak.vignetteScale).toBeLessThan(quiet.vignetteScale);
    for (const value of Object.values(peak)) expect(Number.isFinite(value)).toBe(true);
    expect(peak.bloom).toBeWithin(0, 0.17);
    expect(peak.vignetteScale).toBeWithin(0.82, 1.08);
  });

  test("caps beat-driven bloom when low-flash mode is enabled", () => {
    const beat = visual({ ambient: 0, drive: 1, peak: 0, beat: 1 });
    const thresholdBeat = visual({ ambient: 0, drive: 1, peak: 0, beat: LOW_FLASH_TRANSIENT_CAP });
    const restrained = deriveDynamicGrade(beat, true);
    const unrestricted = deriveDynamicGrade(beat, false);

    expect(visualTransient(1, true)).toBe(visualTransient(LOW_FLASH_TRANSIENT_CAP, true));
    expect(visualTransient(1, true)).toBe(LOW_FLASH_TRANSIENT_CAP);
    expect(deriveDynamicGrade(thresholdBeat, true).bloom).toBe(restrained.bloom);
    expect(unrestricted.bloom).toBeGreaterThan(restrained.bloom);
    expect(deriveDynamicGrade(beat, true)).toEqual(restrained);
  });
});
