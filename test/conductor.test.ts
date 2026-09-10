import { describe, expect, test } from "bun:test";
import { onsetEventsBetween } from "../src/audio/onsets.js";
import {
  deriveChoreography,
  deriveSectionLevel,
  deriveVisualState,
  LOW_FLASH_TRANSIENT_CAP,
  presenceAt,
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
    warmth: 0.5,
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

describe("section level", () => {
  test("is quiet in silence, full in the loud stretch, and rises monotonically across a step", () => {
    const energies = Array.from({ length: 400 }, (_, index) => (index < 200 ? 0.05 : 0.9));
    const analysis = makeAnalysis(energies, [], "section-step", 10);
    expect(deriveSectionLevel(analysis, 5)).toBe(0);
    expect(deriveSectionLevel(analysis, 35)).toBe(1);
    let previous = -1;
    for (let time = 14; time <= 26; time += 0.1) {
      const level = deriveSectionLevel(analysis, time);
      expect(level).toBeGreaterThanOrEqual(previous);
      expect(level).toBeLessThanOrEqual(1);
      previous = level;
    }
    // The symmetric 2.5 s window starts leaning in before the step and settles after it.
    expect(deriveSectionLevel(analysis, 18.5)).toBeGreaterThan(0);
    expect(deriveSectionLevel(analysis, 17)).toBeLessThan(1e-9);
    expect(deriveSectionLevel(analysis, 23)).toBe(1);
  });

  test("is bit-identical for repeated and reverse-order queries and empty analyses", () => {
    const analysis = stagedAnalysis();
    const times = [0.5, 2.1, 3.9, 6.4, 8.8, 11.5];
    const expected = times.map((time) => deriveSectionLevel(analysis, time));
    for (const time of times.slice().reverse()) deriveSectionLevel(analysis, time);
    expect(times.map((time) => deriveSectionLevel(analysis, time))).toEqual(expected);
    expect(times.map((time) => deriveSectionLevel(stagedAnalysis(), time))).toEqual(expected);
    expect(Math.max(...expected)).toBeGreaterThan(0.8);
    expect(Math.min(...expected)).toBeLessThan(0.2);
    expect(deriveSectionLevel(makeAnalysis([], [], "empty"), 1)).toBe(0);
    // A non-finite time reads as the start of the song instead of indexing prefix[NaN].
    expect(deriveSectionLevel(analysis, Number.NaN)).toBe(deriveSectionLevel(analysis, 0));
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

describe("warmth", () => {
  function centroidAnalysis(centroids: number[], name: string): AudioAnalysis {
    const analysis = makeAnalysis(centroids.map(() => 0.5), [], name);
    analysis.frames.forEach((frame, index) => { frame.centroid = centroids[index]!; });
    return analysis;
  }

  test("spans the track's own centroid range, follows it monotonically and stays in 0..1", () => {
    const centroids = Array.from({ length: 200 }, (_, index) => 0.1 + 0.3 * (index / 199));
    const analysis = centroidAnalysis(centroids, "warmth-ramp");
    let previous = -1;
    for (let time = 0; time < 20; time += 0.5) {
      const { warmth } = deriveVisualState(analysis, time);
      expect(warmth).toBeGreaterThanOrEqual(previous);
      expect(warmth).toBeWithin(0, 1.000001);
      previous = warmth;
    }
    expect(deriveVisualState(analysis, 0.5).warmth).toBe(0);
    expect(deriveVisualState(analysis, 19.5).warmth).toBe(1);
    // The same centroid reads the same on a brighter master: p10..p90 of this track, not absolute values.
    const brighter = centroidAnalysis(centroids.map((value) => value + 0.4), "warmth-bright");
    expect(deriveVisualState(brighter, 10).warmth).toBeCloseTo(deriveVisualState(analysis, 10).warmth, 6);
    // A flat centroid is neither cool nor warm, and a non-finite one is ignored.
    const flat = centroidAnalysis(centroids.map(() => 0.3), "warmth-flat");
    expect(deriveVisualState(flat, 5).warmth).toBeCloseTo(0.5, 6);
    const broken = centroidAnalysis(centroids.map((value, index) => (index % 7 === 0 ? Number.NaN : value)), "warmth-nan");
    expect(Number.isFinite(deriveVisualState(broken, 10).warmth)).toBe(true);
    // A non-finite time reads like time 0 instead of leaking NaN into the state.
    const atNaN = deriveVisualState(analysis, Number.NaN);
    for (const value of Object.values(atNaN)) expect(Number.isFinite(value)).toBe(true);
    expect(atNaN.warmth).toBe(deriveVisualState(analysis, 0).warmth);
  });

  test("is a section-scale signal: a centroid alternating with the beat reads as neutral", () => {
    // 10 s dull, 10 s alternating every 0.2 s between dull and bright, 10 s bright (10 fps).
    const alternating = Array.from({ length: 100 }, (_, index) => (Math.floor(index / 2) % 2 === 0 ? 0.2 : 0.8));
    const centroids = [...Array.from({ length: 100 }, () => 0.2), ...alternating, ...Array.from({ length: 100 }, () => 0.8)];
    const analysis = centroidAnalysis(centroids, "warmth-beat");
    for (let time = 13; time <= 17; time += 0.1) expect(deriveVisualState(analysis, time).warmth).toBeWithin(0.35, 0.65);
    expect(deriveVisualState(analysis, 5).warmth).toBeLessThan(0.05);
    expect(deriveVisualState(analysis, 25).warmth).toBeGreaterThan(0.95);
    // Nothing moves faster than the section window: no full swing inside one second.
    for (let time = 0; time < 29; time += 0.1) {
      expect(Math.abs(deriveVisualState(analysis, time + 1).warmth - deriveVisualState(analysis, time).warmth)).toBeLessThan(0.45);
    }
    // A track whose centroid only alternates with the beat stays neutral instead of
    // having its residual ripple stretched to 0..1.
    const onlyBeat = centroidAnalysis(alternating, "warmth-only-beat");
    for (let time = 3; time <= 7; time += 0.5) expect(deriveVisualState(onlyBeat, time).warmth).toBeWithin(0.3, 0.7);
  });

  test("is deterministic for repeated, reverse-order and equivalent fresh analyses", () => {
    const centroids = Array.from({ length: 120 }, (_, index) => 0.5 + 0.4 * Math.sin(index / 9));
    const analysis = centroidAnalysis(centroids, "warmth-seek");
    const times = [0.4, 3.3, 6.1, 9.7, 11.2];
    const expected = times.map((time) => deriveVisualState(analysis, time).warmth);
    for (const time of times.slice().reverse()) deriveVisualState(analysis, time);
    expect(times.map((time) => deriveVisualState(analysis, time).warmth)).toEqual(expected);
    expect(times.map((time) => deriveVisualState(centroidAnalysis(centroids, "warmth-seek"), time).warmth)).toEqual(expected);
    expect(Math.max(...expected) - Math.min(...expected)).toBeGreaterThan(0.5);
    expect(deriveVisualState(makeAnalysis([], [], "empty-warmth"), 1).warmth).toBe(0.5);
  });
});

describe("sculpture presence", () => {
  test("arrives over the first seconds and steps back to 45% before the end", () => {
    const duration = 163;
    expect(presenceAt(0, duration)).toBe(0);
    expect(presenceAt(0.4, duration)).toBe(0);
    expect(presenceAt(3.2, duration)).toBe(1);
    expect(presenceAt(52, duration)).toBe(1);
    expect(presenceAt(duration - 14, duration)).toBe(1);
    expect(presenceAt(duration - 3, duration)).toBeCloseTo(0.45, 6);
    expect(presenceAt(duration, duration)).toBeCloseTo(0.45, 6);
    let previous = 0;
    for (let time = 0; time <= 3.2; time += 0.05) {
      const current = presenceAt(time, duration);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
    for (let time = duration - 14; time <= duration; time += 0.1) {
      const current = presenceAt(time, duration);
      expect(current).toBeLessThanOrEqual(previous + 1e-9);
      previous = current;
    }
  });

  test("shrinks both windows on short tracks and treats a missing duration as no departure", () => {
    // A one-second fixture still shows the object for its middle; a six-second loop is fully present by 1.8 s.
    expect(presenceAt(0.5, 1)).toBe(1);
    expect(presenceAt(1.8, 6)).toBe(1);
    expect(presenceAt(3.3, 6)).toBeCloseTo(1, 6);
    expect(presenceAt(6, 6)).toBeCloseTo(0.45, 6);
    expect(presenceAt(1000, NaN)).toBe(1);
    expect(presenceAt(1000, 0)).toBe(1);
    expect(presenceAt(NaN, 163)).toBe(0);
  });
});
