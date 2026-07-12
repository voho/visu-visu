import { describe, expect, test } from "bun:test";
import { deriveVisualState } from "../src/render/conductor.js";
import type { AnalysisFrame, AudioAnalysis } from "../src/types.js";

function analysisFrame(energy: number, onset = 0): AnalysisFrame {
  return {
    rms: energy,
    peak: energy,
    bass: energy,
    mid: energy,
    treble: energy,
    centroid: 0.5,
    flux: onset,
    onset,
    spectrum: Float32Array.from({ length: 16 }, () => energy),
    waveform: Float32Array.from({ length: 32 }, (_, index) =>
      Math.sin((index / 31) * Math.PI * 2) * energy,
    ),
  };
}

function stagedAnalysis(): AudioAnalysis {
  const fps = 10;
  const frames = Array.from({ length: 60 }, (_, index) => {
    const energy = index < 20 ? 0.08 : index < 40 ? 0.08 + (index - 20) * 0.044 : 0.92;
    return analysisFrame(energy, index === 31 ? 1 : 0);
  });
  return {
    version: 1,
    sampleRate: 24_000,
    fps,
    duration: 6,
    spectrumBands: 16,
    waveformPoints: 32,
    sourceHash: "staged",
    sourceFileHash: "staged-file",
    frames,
  };
}

describe("visual conductor", () => {
  test("moves from ambient through a build into a driven peak", () => {
    const analysis = stagedAnalysis();
    const ambient = deriveVisualState(analysis, 0.8);
    const build = deriveVisualState(analysis, 2.6);
    const peak = deriveVisualState(analysis, 4.8);

    expect(ambient.ambient).toBeGreaterThan(ambient.drive);
    expect(build.trend).toBeGreaterThan(0);
    expect(build.motion).toBeGreaterThan(ambient.motion);
    expect(peak.drive).toBeGreaterThan(ambient.drive);
    expect(peak.peak).toBeGreaterThan(ambient.peak);
    expect(ambient.ambient + ambient.drive + ambient.peak).toBeCloseTo(1, 8);
    expect(build.ambient + build.drive + build.peak).toBeCloseTo(1, 8);
    expect(peak.ambient + peak.drive + peak.peak).toBeCloseTo(1, 8);
    expect(peak.form).toBeGreaterThan(ambient.form);
    expect(deriveVisualState(analysis, 2.6)).toEqual(build);
  });

  test("creates an absolute-time beat impulse with deterministic decay", () => {
    const analysis = stagedAnalysis();
    const hit = deriveVisualState(analysis, 3.1);
    const decay = deriveVisualState(analysis, 3.42);

    expect(hit.beat).toBeGreaterThan(0.9);
    expect(decay.beat).toBeGreaterThan(0);
    expect(decay.beat).toBeLessThan(hit.beat);
  });
});
