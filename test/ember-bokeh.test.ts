import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { createEmberPlan, drawEmbers, emberPoseAt, EMBER_MAX_ALPHA, type EmberDrive } from "../src/render/ember-bokeh.js";
import { createSafeLayout, creditLockupEllipse } from "../src/render/layout.js";
import { deriveSceneDynamics } from "../src/render/scene-dynamics.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function analysis(): AudioAnalysis {
  const fps = 30, duration = 12;
  return {
    version: ANALYSIS_VERSION, fps, duration, sampleRate: 48_000, spectrumBands: 32, waveformPoints: 32,
    sourceHash: "embers", sourceFileHash: "embers",
    frames: Array.from({ length: fps * duration }, (_, index) => ({
      rms: 0.4, peak: 0.6, bass: 0.3 + 0.2 * Math.sin(index / 7), mid: 0.2, treble: 0.1, centroid: 0.4, flux: 0, onset: 0,
      spectrum: Float32Array.from({ length: 32 }, (_, band) => 0.3 + 0.2 * Math.sin(band + index / 11)),
      waveform: new Float32Array(32),
    })),
  };
}

function driveAt(time: number, overrides: Partial<EmberDrive> = {}): EmberDrive {
  const width = 1920, height = 1080;
  return {
    time, dynamics: deriveSceneDynamics(analysis(), Math.min(11, Math.max(0, time))), section: 0.7, kick: 0.5, treblePulse: 0.4,
    bands: Float32Array.from({ length: 32 }, (_, band) => (band % 3) / 2),
    pan: { x: 0.01, y: -0.005 }, cover: { x: 0.02, y: 0.01 },
    layout: createSafeLayout(width, height), width, height, gain: 1, ...overrides,
  };
}

describe("cover-coloured ember bokeh", () => {
  test("plans deterministically per seed with a fixed far/near split and eight sparkling smallest embers", () => {
    const plan = createEmberPlan("embers", 28);
    expect(plan).toEqual(createEmberPlan("embers", 28));
    expect(createEmberPlan("other", 28)).not.toEqual(plan);
    expect(plan).toHaveLength(28);
    expect(plan.filter((ember) => !ember.near)).toHaveLength(12);
    expect(plan.filter((ember) => ember.near)).toHaveLength(16);
    expect(plan.filter((ember) => ember.sparkle)).toHaveLength(8);
    const sparkleMax = Math.max(...plan.filter((ember) => ember.sparkle).map((ember) => ember.radius));
    const plainMin = Math.min(...plan.filter((ember) => !ember.sparkle).map((ember) => ember.radius));
    expect(sparkleMax).toBeLessThanOrEqual(plainMin);
    for (const ember of plan) {
      expect(ember.near).toBe(ember.depth >= 0.55);
      expect(ember.band).toBeGreaterThanOrEqual(0);
      expect(ember.band).toBeLessThan(32);
      expect(ember.tint).toBeGreaterThanOrEqual(0);
      expect(ember.tint).toBeLessThan(1);
    }
    expect(createEmberPlan("embers", 0)).toEqual([]);
    expect(createEmberPlan("embers", NaN)).toEqual([]);
  });

  test("keeps every pose finite, inside the wrap margin and under the alpha ceiling at any time", () => {
    const plan = createEmberPlan("poses", 28);
    for (const time of [0, 100, 1000, NaN]) {
      for (const ember of plan) {
        const pose = emberPoseAt(ember, driveAt(time));
        for (const value of Object.values(pose)) expect(Number.isFinite(value)).toBe(true);
        expect(pose.x / 1920).toBeWithin(-0.2, 1.2);
        expect(pose.y / 1080).toBeWithin(-0.2, 1.2);
        expect(pose.alpha).toBeGreaterThanOrEqual(0);
        expect(pose.alpha).toBeLessThanOrEqual(EMBER_MAX_ALPHA);
        expect(pose.radius).toBeGreaterThan(0);
      }
    }
  });

  test("dims inside the credit ellipse, swells near embers on the kick and pulses with its band", () => {
    const layout = createSafeLayout(1920, 1080);
    const credit = creditLockupEllipse(layout, 1920, 1080);
    const [ember] = createEmberPlan("credit", 28);
    const drive = driveAt(5, { pan: { x: 0, y: 0 }, cover: { x: 0, y: 0 } });
    const lockup = { ...ember!, x: credit.x, y: credit.y, phase: 0 };
    // Put the rest position where the pose lands at this time: rest y minus the rise, wrapped.
    const at = emberPoseAt(lockup, drive);
    const shifted = { ...lockup, y: lockup.y + (credit.y - at.y / 1080) };
    const inside = emberPoseAt(shifted, drive);
    expect(inside.y / 1080).toBeCloseTo(credit.y, 6);
    expect(inside.alpha).toBeLessThan(0.05);
    const outside = emberPoseAt({ ...shifted, x: 0.05, y: shifted.y + 0.5 }, drive);
    expect(outside.alpha).toBeGreaterThan(inside.alpha * 4);

    const near = createEmberPlan("credit", 28).find((candidate) => candidate.near)!;
    const far = createEmberPlan("credit", 28).find((candidate) => !candidate.near)!;
    expect(emberPoseAt(near, driveAt(5, { kick: 1 })).radius / emberPoseAt(near, driveAt(5, { kick: 0 })).radius).toBeCloseTo(1.25, 6);
    expect(emberPoseAt(far, driveAt(5, { kick: 1 })).radius).toBe(emberPoseAt(far, driveAt(5, { kick: 0 })).radius);
    const quiet = emberPoseAt({ ...far, x: 0.5, y: 0.9 }, driveAt(5, { bands: new Float32Array(32) }));
    const loud = emberPoseAt({ ...far, x: 0.5, y: 0.9 }, driveAt(5, { bands: new Float32Array(32).fill(1) }));
    expect(loud.alpha).toBeGreaterThan(quiet.alpha * 2);
    expect(emberPoseAt(far, driveAt(5, { gain: 0 })).alpha).toBe(0);
  });

  test("parallax moves the near plane more than the far one and the rise never jumps between frames", () => {
    const plan = createEmberPlan("parallax", 28);
    const near = plan.find((ember) => ember.near)!;
    const far = plan.find((ember) => !ember.near)!;
    const still = driveAt(3, { pan: { x: 0, y: 0 }, cover: { x: 0, y: 0 } });
    const panned = driveAt(3, { pan: { x: 0.02, y: 0 }, cover: { x: 0, y: 0 } });
    const nearShift = emberPoseAt(near, panned).x - emberPoseAt(near, still).x;
    const farShift = emberPoseAt(far, panned).x - emberPoseAt(far, still).x;
    expect(nearShift / farShift).toBeCloseTo(1.7 / 0.5, 6);
    let previous = emberPoseAt(near, driveAt(0));
    for (let frame = 1; frame <= 330; frame += 1) {
      const pose = emberPoseAt(near, driveAt(frame / 30));
      const step = Math.abs(pose.y - previous.y);
      // Either a small rise or the analytic wrap from the top back to the bottom.
      expect(step < 4 || Math.abs(step - 1.3 * 1080) < 4).toBe(true);
      previous = pose;
    }
  });

  test("preserves bass-to-treble assignments when the readout doubles its resolution", () => {
    const ember = { ...createEmberPlan("treble", 1)[0]!, band: 31, x: 0.1, y: 0.8 };
    const spectrum32 = new Float32Array(32);
    spectrum32[31] = 0.6;
    const spectrum64 = new Float32Array(64);
    spectrum64[62] = 0.4;
    spectrum64[63] = 0.8;
    const pose32 = emberPoseAt(ember, driveAt(2, { bands: spectrum32 }));
    const pose64 = emberPoseAt(ember, driveAt(2, { bands: spectrum64 }));
    expect(pose64.alpha).toBeCloseTo(pose32.alpha, 7);
    expect(pose64.alpha).toBeGreaterThan(emberPoseAt(ember, driveAt(2, { bands: new Float32Array(64) })).alpha * 2);
  });

  test("draws only its plane, in palette colours, and restores the context", () => {
    const plan = createEmberPlan("draw", 28);
    const canvas = createCanvas(320, 180);
    const context = canvas.getContext("2d");
    const drive = driveAt(4, { width: 320, height: 180, layout: createSafeLayout(320, 180), bands: new Float32Array(32).fill(1) });
    context.globalCompositeOperation = "multiply";
    context.globalAlpha = 0.5;
    drawEmbers(context, plan, [[1, 0.5, 0.2]], drive, "far");
    expect(context.globalCompositeOperation).toBe("multiply");
    expect(context.globalAlpha).toBeCloseTo(0.5, 2);
    context.globalAlpha = 1;
    context.clearRect(0, 0, 320, 180);
    drawEmbers(context, plan, [[1, 0.5, 0.2]], drive, "near");
    const pixels = context.getImageData(0, 0, 320, 180).data;
    let lit = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3]! === 0) continue;
      lit += 1;
      // Every lit pixel is the one ember colour (alpha-premultiplication rounding aside).
      expect(pixels[index]!).toBeGreaterThanOrEqual(pixels[index + 1]!);
      expect(pixels[index + 1]!).toBeGreaterThanOrEqual(pixels[index + 2]!);
    }
    expect(lit).toBeGreaterThan(200);
    context.clearRect(0, 0, 320, 180);
    drawEmbers(context, plan, [], drive, "near");
    expect(context.getImageData(0, 0, 320, 180).data.every((value) => value === 0)).toBe(true);
  });
});
