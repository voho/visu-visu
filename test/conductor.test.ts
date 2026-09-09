import { describe, expect, test } from "bun:test";
import { onsetEventsBetween } from "../src/audio/onsets.js";
import {
  deriveChoreography,
  deriveVisualState,
  LOW_FLASH_TRANSIENT_CAP,
  type VisualState,
} from "../src/render/conductor.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

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

function makeAnalysis(
  energies: number[],
  onsets: number[],
  sourceHash = "conductor-fixture",
  fps = 10,
): AudioAnalysis {
  return {
    version: ANALYSIS_VERSION,
    sampleRate: 24_000,
    fps,
    duration: energies.length / fps,
    spectrumBands: 16,
    waveformPoints: 32,
    sourceHash,
    sourceFileHash: `${sourceHash}-file`,
    frames: energies.map((energy, index) => analysisFrame(energy, onsets[index] ?? 0)),
  };
}

function stagedAnalysis(): AudioAnalysis {
  const energies = Array.from({ length: 120 }, (_, index) => {
    if (index < 20) return 0.06;
    if (index < 40) return 0.06 + ((index - 20) / 20) * 0.66;
    if (index < 70) return 0.9;
    if (index < 90) return 0.9 - ((index - 70) / 20) * 0.82;
    return 0.08;
  });
  const onsets = energies.map((_, index) => {
    if (index >= 40 && index < 70 && index % 5 === 0) return 1;
    if (index >= 20 && index < 40 && index % 7 === 0) return 0.35;
    return 0;
  });
  return makeAnalysis(energies, onsets, "staged");
}

function visual(overrides: Partial<VisualState> = {}): VisualState {
  return {
    ambient: 1,
    drive: 0,
    peak: 0,
    beat: 0,
    trend: 0,
    motion: 0.22,
    chapter: 0,
    form: 0,
    ...overrides,
  };
}

function longestRun(values: boolean[]): number {
  let current = 0;
  let longest = 0;
  for (const value of values) {
    current = value ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

describe("adaptive visual conductor", () => {
  test("creates contrasting quiet, build, peak, and release sections", () => {
    const analysis = stagedAnalysis();
    const states = analysis.frames.map((_, index) =>
      deriveVisualState(analysis, index / analysis.fps),
    );
    const quiet = states[10]!;
    const build = states.slice(20, 40);
    const plateau = states.slice(40, 70);
    const release = states.slice(70, 90);
    const strongestPeak = plateau.reduce((best, state) =>
      state.peak > best.peak ? state : best,
    );

    expect(quiet.ambient).toBeGreaterThan(0.75);
    expect(Math.max(...build.map((state) => state.trend))).toBeGreaterThan(0.2);
    expect(Math.max(...build.map((state) => state.drive))).toBeGreaterThan(0.55);
    expect(strongestPeak.peak).toBeGreaterThan(0.65);
    expect(longestRun(plateau.map((state) => state.peak > 0.6))).toBeGreaterThanOrEqual(3);
    expect(Math.min(...release.map((state) => state.trend))).toBeLessThan(-0.2);
    expect(release.at(-1)?.peak ?? 1).toBeLessThan(strongestPeak.peak);
    expect(strongestPeak.motion).toBeGreaterThan(quiet.motion);
    expect(strongestPeak.form).toBeGreaterThan(quiet.form);

    for (const state of states) {
      expect(state.ambient + state.drive + state.peak).toBeCloseTo(1, 10);
      for (const value of [
        state.ambient,
        state.drive,
        state.peak,
        state.beat,
        state.motion,
        state.chapter,
        state.form,
      ]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(state.trend).toBeGreaterThanOrEqual(-1);
      expect(state.trend).toBeLessThanOrEqual(1);
    }
  });

  test("ignores the synthetic frame-zero onset", () => {
    const analysis = makeAnalysis(
      Array.from({ length: 30 }, () => 0.05),
      Array.from({ length: 30 }, (_, index) => (index === 0 ? 1 : 0)),
      "opening-onset",
    );
    const opening = deriveVisualState(analysis, 0);
    const afterOpening = deriveVisualState(analysis, 0.1);

    expect(opening.beat).toBe(0);
    expect(opening.peak).toBe(0);
    expect(afterOpening.beat).toBe(0);
    expect(afterOpening.peak).toBe(0);
    expect(opening.ambient).toBeGreaterThan(0.9);
  });

  test("keeps a compressed rhythmic track driven instead of permanently ambient or peak", () => {
    const analysis = makeAnalysis(
      Array.from({ length: 80 }, () => 0.65),
      Array.from({ length: 80 }, (_, index) => (index > 0 && index % 3 === 0 ? 1 : 0)),
      "compressed",
    );
    const states = analysis.frames.map((_, index) =>
      deriveVisualState(analysis, index / analysis.fps),
    );

    expect(Math.max(...states.map((state) => state.beat))).toBeGreaterThan(0.9);
    expect(Math.max(...states.map((state) => state.drive))).toBeGreaterThan(0.45);
    expect(Math.min(...states.map((state) => state.ambient))).toBeLessThan(0.6);
    expect(Math.max(...states.map((state) => state.peak))).toBeLessThan(0.25);
  });

  test("is deterministic for repeated, reverse-order, and equivalent fresh analyses", () => {
    const analysis = stagedAnalysis();
    const equivalent = stagedAnalysis();
    const times = [1.2, 3.4, 5.2, 7.6, 9.1];
    const expected = times.map((time) => deriveVisualState(analysis, time));

    for (const time of times.slice().reverse()) deriveVisualState(analysis, time);
    expect(times.map((time) => deriveVisualState(analysis, time))).toEqual(expected);
    expect(times.map((time) => deriveVisualState(equivalent, time))).toEqual(expected);
  });

  test("creates an absolute-time beat impulse with deterministic decay", () => {
    const onsets = Array.from({ length: 30 }, (_, index) => (index === 10 ? 1 : 0));
    const analysis = makeAnalysis(Array.from({ length: 30 }, () => 0.4), onsets, "beat");
    const hit = deriveVisualState(analysis, 1);
    const decay = deriveVisualState(analysis, 1.3);

    expect(hit.beat).toBeGreaterThan(0.9);
    expect(decay.beat).toBeGreaterThan(0);
    expect(decay.beat).toBeLessThan(hit.beat);
    expect(deriveVisualState(analysis, 1.3)).toEqual(decay);
  });

  test("fires a clipped onset plateau immediately and only once", () => {
    const analysis = makeAnalysis(
      Array.from({ length: 90 }, () => 0.4),
      Array.from({ length: 90 }, (_, index) =>
        index === 0 || (index >= 30 && index <= 32) ? 1 : 0,
      ),
      "plateau",
      30,
    );
    expect(deriveVisualState(analysis, 0.999).beat).toBe(0);
    expect(deriveVisualState(analysis, 1).beat).toBe(1);
    expect(deriveVisualState(analysis, 32 / 30).beat).toBeLessThan(0.7);
    expect(onsetEventsBetween(analysis, 0, 3)).toEqual([
      { index: 30, time: 1, strength: 1 },
    ]);
    expect(onsetEventsBetween(analysis, 1.001, 3)).toEqual([]);
    expect(onsetEventsBetween(analysis, 0, 0.999)).toEqual([]);
    expect(onsetEventsBetween(analysis, 1, 1)).toHaveLength(1);
  });

  test("preserves rhythmic choreography at 12 and 60 fps", () => {
    const pulseTrack = (fps: number): AudioAnalysis => {
      const energies = Array.from({ length: fps * 8 }, () => 0.65);
      const onsets = energies.map((_, index) =>
        index > 0 && index % (fps / 2) === 0 ? 1 : 0,
      );
      return makeAnalysis(energies, onsets, `rhythm-${fps}`, fps);
    };
    const slow = pulseTrack(12);
    const fast = pulseTrack(60);
    for (const time of [2, 2.25, 2.5, 3, 3.25, 4]) {
      const slowState = deriveVisualState(slow, time);
      const fastState = deriveVisualState(fast, time);
      for (const key of ["beat", "drive", "peak", "ambient"] as const) {
        expect(slowState[key]).toBeCloseTo(fastState[key], 9);
      }
    }
    // A seek before the next hit must never borrow its future impulse.
    expect(deriveVisualState(slow, 2.49).beat).toBeLessThan(0.05);
    expect(deriveVisualState(fast, 2.49).beat).toBeLessThan(0.05);
  });
});

describe("visual choreography", () => {
  test("hands the composition from ambience through build and peak into release", () => {
    const ambient = deriveChoreography(visual(), 0, true);
    const build = deriveChoreography(
      visual({ ambient: 0, drive: 1, trend: 0.5, motion: 0.7, chapter: 0.6 }),
      0.2,
      true,
    );
    const peak = deriveChoreography(
      visual({ ambient: 0, peak: 1, beat: 1, motion: 0.9, chapter: 1, form: 1 }),
      1,
      true,
    );
    const release = deriveChoreography(
      visual({ ambient: 0.7, drive: 0.3, trend: -1, motion: 0.4, chapter: 0.2 }),
      0.1,
      true,
    );

    expect(ambient.layers.halo).toBeGreaterThan(ambient.layers.spiral);
    expect(ambient.layers.waveform).toBeGreaterThan(ambient.layers.tunnel);
    expect(build.layers.tunnel).toBeGreaterThan(build.layers.halo);
    expect(build.layers.tunnel).toBeGreaterThan(ambient.layers.tunnel);
    expect(peak.layers.spiral).toBeGreaterThan(peak.layers.halo);
    expect(peak.layers.spiral).toBeGreaterThan(peak.layers.tunnel);
    expect(peak.layers.spiral).toBeGreaterThan(peak.layers.waveform);
    expect(release.modes.release).toBeGreaterThan(release.modes.build);
    expect(release.layers.halo).toBeGreaterThan(build.layers.halo);

    for (const choreography of [ambient, build, peak, release]) {
      expect(
        choreography.modes.ambient +
          choreography.modes.build +
          choreography.modes.peak +
          choreography.modes.release,
      ).toBeCloseTo(1, 10);
      for (const value of Object.values(choreography.layers)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  test("caps fast accents without flattening sustained choreography", () => {
    const energetic = visual({ ambient: 0, peak: 1, beat: 1, motion: 0.9, chapter: 1, form: 1 });
    const threshold = visual({ ambient: 0, peak: 1, beat: LOW_FLASH_TRANSIENT_CAP });
    const restrained = deriveChoreography(energetic, 1, true);
    const restrainedAtThreshold = deriveChoreography(
      threshold,
      LOW_FLASH_TRANSIENT_CAP,
      true,
    );
    const unrestricted = deriveChoreography(energetic, 1, false);

    expect(restrained.impact).toBe(LOW_FLASH_TRANSIENT_CAP);
    expect(restrained.onset).toBe(LOW_FLASH_TRANSIENT_CAP);
    expect(restrainedAtThreshold.impact).toBe(restrained.impact);
    expect(restrainedAtThreshold.onset).toBe(restrained.onset);
    expect(unrestricted.impact).toBeGreaterThan(restrained.impact);
    expect(unrestricted.onset).toBeGreaterThan(restrained.onset);
    expect(unrestricted.modes).toEqual(restrained.modes);
    expect(unrestricted.layers).toEqual(restrained.layers);
  });
});
