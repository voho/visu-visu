import { describe, expect, test } from "bun:test";
import { planMilkdrop } from "../src/milkdrop/plan.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

const presets = ["vortex", "ribbons", "cosmic-dust", "fog-tunnel", "julia-fractal", "plasma", "folded-tunnel", "moebius"];
function frame(energy: number, onset = 0): AnalysisFrame {
  return { rms: energy, peak: energy, bass: energy, mid: energy * 0.7, treble: energy * 0.4,
    centroid: 0.4, flux: onset, onset, spectrum: new Float32Array(32), waveform: new Float32Array(32) };
}
function track(duration = 80, fps = 60, energy = 0.6, hits = true): AudioAnalysis {
  return { version: ANALYSIS_VERSION, sampleRate: 24_000, fps, duration, spectrumBands: 32, waveformPoints: 32,
    sourceHash: "milkdrop-plan", sourceFileHash: "milkdrop-plan-file",
    frames: Array.from({ length: Math.ceil(duration * fps) }, (_, index) => frame(energy,
      hits && index > 0 && index % Math.round(fps / 2) === 0 ? 0.8 : 0)) };
}

describe("MilkDrop preset planning", () => {
  test("repeats a seeded schedule, varies seeds and cycles without immediate repeats", () => {
    const analysis = track(160);
    const source = presets.slice();
    const expected = planMilkdrop(analysis, "repeat", 10.25, 120 * 60, 60, source);
    expect(planMilkdrop(analysis, "repeat", 10.25, 120 * 60, 60, source)).toEqual(expected);
    expect(source).toEqual(presets);
    expect(planMilkdrop(analysis, "other", 10.25, 120 * 60, 60, source)).not.toEqual(expected);
    expect(new Set(expected.schedule.slice(0, presets.length).map(entry => entry.preset)).size).toBe(presets.length);
    for (let index = 1; index < expected.schedule.length; index++) {
      expect(expected.schedule[index]!.preset).not.toBe(expected.schedule[index - 1]!.preset);
    }
  });

  test("keeps preroll bounded and output time exact for fractional starts", () => {
    const analysis = track();
    for (const fps of [24, 29.97, 60, 120]) for (const start of [0, 0.001, 0.499, 1.001, 3.999, 4.001, 20.317]) {
      const plan = planMilkdrop(analysis, "warmup", start, 101, fps, presets);
      expect(plan.simulationStart).toBeGreaterThanOrEqual(0);
      expect(plan.outputStartFrame).toBeInteger();
      expect(plan.outputStartFrame / fps).toBeLessThanOrEqual(4);
      expect(plan.simulationStart + plan.outputStartFrame / fps).toBeCloseTo(start, 10);
      expect(plan.simulationFrames).toBe(101 + plan.outputStartFrame);
      expect(plan.schedule[0]).toMatchObject({ frame: 0, blendSeconds: 0 });
      for (const entry of plan.schedule) {
        expect(entry.frame).toBeInteger();
        expect(entry.frame).toBeGreaterThanOrEqual(0);
        expect(entry.frame).toBeLessThan(plan.simulationFrames);
        expect(presets).toContain(entry.preset);
      }
    }
  });

  test("gives thirty seconds at least three different presets, with separated smooth blends", () => {
    for (const energy of [0, 0.1, 1]) for (const start of [0, 2.37, 11]) {
      const plan = planMilkdrop(track(80, 60, energy, false), "quiet-variety", start, 1800, 60, presets);
      const visible = plan.schedule.filter((entry, index) => {
        const next = plan.schedule[index + 1];
        const end = next ? next.frame + Math.ceil(next.blendSeconds * 60) : plan.simulationFrames;
        return end > plan.outputStartFrame && entry.frame < plan.simulationFrames;
      });
      expect(new Set(visible.map(entry => entry.preset)).size).toBeGreaterThanOrEqual(3);
      for (let index = 1; index < plan.schedule.length; index++) {
        const entry = plan.schedule[index]!, prior = plan.schedule[index - 1]!;
        expect((entry.frame - prior.frame) / 60).toBeGreaterThanOrEqual(8);
        expect((entry.frame - prior.frame) / 60).toBeLessThanOrEqual(13 + 1 / 60);
        expect(entry.blendSeconds).toBeGreaterThanOrEqual(2.5);
        expect(entry.blendSeconds).toBeLessThanOrEqual(4);
      }
    }
  });

  test("strong musical onsets advance a transition but cannot bypass the dwell time", () => {
    const quiet = track(40, 60, 0.05, false);
    const loud = track(40, 60, 0.95, true);
    const quietPlan = planMilkdrop(quiet, "music", 0, 1800, 60, presets);
    const loudPlan = planMilkdrop(loud, "music", 0, 1800, 60, presets);
    expect(loudPlan.schedule[1]!.frame).toBeLessThan(quietPlan.schedule[1]!.frame);
    expect(loudPlan.schedule[1]!.frame).toBeGreaterThanOrEqual(8 * 60);
    expect(loudPlan.schedule[1]!.blendSeconds).toBeLessThan(quietPlan.schedule[1]!.blendSeconds);
    expect(loud.frames[loudPlan.schedule[1]!.frame]!.onset).toBeGreaterThanOrEqual(0.16);
  });

  test("never borrows future audio or changes an earlier schedule when the tail changes", () => {
    const analysis = track(40, 60, 0.3, true);
    const changed = structuredClone(analysis);
    const cutoff = 20.25;
    for (let index = Math.floor(cutoff * 60); index < changed.frames.length; index++) changed.frames[index] = frame(1, index % 30 === 0 ? 1 : 0);
    for (const fps of [24, 60, 120]) {
      const a = planMilkdrop(analysis, "causal", 0, 30 * fps, fps, presets);
      const b = planMilkdrop(changed, "causal", 0, 30 * fps, fps, presets);
      const prefix = (plan: typeof a) => plan.schedule.filter(entry => entry.frame / fps < cutoff);
      expect(prefix(a)).toEqual(prefix(b));
      const short = planMilkdrop(analysis, "causal", 0, 15 * fps, fps, presets);
      expect(short.schedule).toEqual(a.schedule.filter(entry => entry.frame < 15 * fps));
    }
  });

  test("keeps short tracks and one-preset selections valid", () => {
    const analysis = track(0.2);
    const plan = planMilkdrop(analysis, "short", 0.01, 5, 60, presets);
    expect(plan.schedule).toHaveLength(1);
    expect(plan.simulationFrames).toBe(5);
    expect(plan.simulationStart).toBe(0.01);
    const single = planMilkdrop(track(), "single", 20, 1800, 60, ["vortex", "vortex"]);
    expect(single.schedule).toEqual([{ frame: 0, preset: "vortex", blendSeconds: 0 }]);
    const empty = { ...analysis, frames: [] };
    expect(planMilkdrop(empty, "empty", 0, 12, 60, presets).schedule).toHaveLength(1);
  });

  test("rejects malformed dimensions and empty preset IDs", () => {
    const analysis = track(1);
    for (const start of [-1, NaN, Infinity]) expect(() => planMilkdrop(analysis, "bad", start, 60, 60, presets)).toThrow();
    for (const count of [0, -1, 1.5, Infinity]) expect(() => planMilkdrop(analysis, "bad", 0, count, 60, presets)).toThrow();
    for (const fps of [0, -1, NaN, Infinity]) expect(() => planMilkdrop(analysis, "bad", 0, 60, fps, presets)).toThrow();
    expect(() => planMilkdrop(analysis, "bad", 0, 60, 60, [])).toThrow();
    expect(() => planMilkdrop(analysis, "bad", 0, 60, 60, [""])).toThrow();
  });
});
