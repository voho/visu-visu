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
  test("holds one preset from a candidate pool for a whole song without reloads or blends", () => {
    const selection = ["tunnel-race", "mandelbox-explorer", "fractal-descent"];
    const analysis = track();
    const result = planMilkdrop(analysis, "flight", 0, 70 * 60, 60, selection);
    expect(result.schedule).toHaveLength(1);
    expect(result.schedule[0]).toMatchObject({ frame: 0, blendSeconds: 0 });
    expect(selection).toContain(result.schedule[0].preset);
    expect(planMilkdrop(analysis, "flight", 0, 70 * 60, 60, selection)).toEqual(result);
    expect(selection).toEqual(["tunnel-race", "mandelbox-explorer", "fractal-descent"]);
    expect(planMilkdrop(analysis, "flight", 0, 3600 * 60, 60, selection).schedule).toEqual(result.schedule);
  });

  test("keeps the same preset across clips, frame rates, analysis settings and candidate order", () => {
    const analysis = track();
    const expected = planMilkdrop(analysis, "auto", 0, 80 * 60, 60, presets).schedule;
    for (const fps of [24, 29.97, 60, 120]) for (const start of [0, 0.49, 3.99, 20.317, 50]) {
      const resampled = { ...track(80, fps), spectrumBands: 128, waveformPoints: 128 };
      expect(planMilkdrop(resampled, "auto", start, 101, fps, presets).schedule).toEqual(expected);
      expect(planMilkdrop(resampled, "auto", start, 101, fps, presets.toReversed()).schedule).toEqual(expected);
    }
    // Metadata and filenames do not change the identity of the decoded song.
    expect(planMilkdrop({ ...analysis, sourceFileHash: "changed-tags" }, "auto", 40, 1800, 60, presets).schedule).toEqual(expected);
  });

  test("varies automatic choices by song identity and permits a new choice with a configured seed", () => {
    const analysis = track(1), bySong = new Set<string>(), bySeed = new Set<string>();
    for (let index = 0; index < 32; index++) {
      bySong.add(planMilkdrop({ ...analysis, sourceHash: `song-${index}` }, "auto", 0, 60, 60, presets).schedule[0].preset);
      bySeed.add(planMilkdrop(analysis, `seed-${index}`, 0, 60, 60, presets).schedule[0].preset);
    }
    expect(bySong.size).toBeGreaterThan(4);
    expect(bySeed.size).toBeGreaterThan(4);
  });

  test("honors a pinned preset regardless of source, seed or excerpt", () => {
    for (const seed of ["auto", "custom"]) for (const start of [0, 20]) {
      const analysis = { ...track(1), sourceHash: `source-${seed}-${start}` };
      expect(planMilkdrop(analysis, seed, start, 1800, 60, ["tunnel-race"]).schedule)
        .toEqual([{ frame: 0, preset: "tunnel-race", blendSeconds: 0 }]);
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
      expect(plan.schedule).toHaveLength(1);
      expect(plan.schedule[0]).toMatchObject({ frame: 0, blendSeconds: 0 });
    }
  });

  test("strong onsets and energy changes never trigger preset changes", () => {
    const quiet = track(40, 60, 0.05, false), loud = track(40, 60, 0.95, true);
    const quietPlan = planMilkdrop(quiet, "music", 0, 1800, 60, presets);
    const loudPlan = planMilkdrop(loud, "music", 0, 1800, 60, presets);
    expect(quietPlan.schedule).toHaveLength(1);
    expect(loudPlan.schedule).toEqual(quietPlan.schedule);
  });

  test("keeps short tracks, empty features and one-preset selections valid", () => {
    const analysis = track(0.2);
    const plan = planMilkdrop(analysis, "short", 0.01, 5, 60, presets);
    expect(plan.schedule).toHaveLength(1);
    expect(plan.simulationFrames).toBe(5);
    expect(plan.simulationStart).toBe(0.01);
    const single = planMilkdrop(track(), "single", 20, 1800, 60, ["vortex", "vortex"]);
    expect(single.schedule).toEqual([{ frame: 0, preset: "vortex", blendSeconds: 0 }]);
    expect(planMilkdrop({ ...analysis, frames: [] }, "short", 0, 12, 60, presets).schedule).toEqual(plan.schedule);
  });

  test("rejects malformed dimensions and empty preset IDs", () => {
    const analysis = track(1);
    for (const start of [-1, NaN, Infinity]) expect(() => planMilkdrop(analysis, "bad", start, 60, 60, presets)).toThrow();
    for (const count of [0, -1, 1.5, Infinity]) expect(() => planMilkdrop(analysis, "bad", 0, count, 60, presets)).toThrow();
    for (const fps of [0, -1, NaN, Infinity, 241]) expect(() => planMilkdrop(analysis, "bad", 0, 60, fps, presets)).toThrow();
    expect(() => planMilkdrop(analysis, "bad", 0, 60, 60, [])).toThrow();
    expect(() => planMilkdrop(analysis, "bad", 0, 60, 60, [""])).toThrow();
    expect(() => planMilkdrop(analysis, "bad", 4, Number.MAX_SAFE_INTEGER, 60, presets)).toThrow();
  });
});
