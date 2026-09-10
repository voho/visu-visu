import { describe, expect, test } from "bun:test";
import { selectClip } from "../src/audio/clip.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

function frame(energy = 0, overrides: Partial<AnalysisFrame> = {}): AnalysisFrame {
  return {
    rms: energy,
    peak: energy,
    bass: energy,
    mid: energy,
    treble: energy,
    centroid: 0,
    flux: 0,
    onset: 0,
    spectrum: new Float32Array(8),
    waveform: new Float32Array(8),
    ...overrides,
  };
}

function analysis(sample: (time: number) => AnalysisFrame, duration = 90, fps = 30): AudioAnalysis {
  return {
    version: ANALYSIS_VERSION,
    sampleRate: 48_000,
    fps,
    duration,
    spectrumBands: 8,
    waveformPoints: 8,
    sourceHash: "clip-test",
    sourceFileHash: "clip-test",
    frames: Array.from({ length: Math.ceil(duration * fps) }, (_, index) => sample(index / fps)),
  };
}

describe("song clip selection", () => {
  test("selects a sustained drop with three seconds of build-up over isolated louder hits", () => {
    const source = analysis((time) => frame(time >= 40 && time < 66 ? 0.8 : time === 15 ? 1 : 0.08));
    const clip = selectClip(source);
    expect(clip.reason).toBe("drop");
    expect(clip.drop).toBe(40);
    expect(clip.start).toBe(37);
    expect(clip.duration).toBe(30);
    expect(clip.end).toBe(67);
    expect(clip.dropOffset).toBe(3);
    expect(selectClip(source)).toEqual(clip);
  });

  test("prefers the stronger of two sustained drops and penalizes a quiet ending", () => {
    const source = analysis((time) => frame(
      time >= 20 && time < 37 ? 0.55 : time >= 55 && time < 79 ? 0.9 : time >= 88 ? 1 : 0.08,
    ));
    const clip = selectClip(source);
    expect(clip.drop).toBe(55);
    expect(clip.start).toBe(52);
  });

  test("weights low frequencies above equal-energy high-frequency sections", () => {
    const source = analysis((time) => frame(0.12, {
      bass: time >= 50 && time < 74 ? 0.8 : 0.05,
      treble: time >= 15 && time < 39 ? 0.8 : 0.05,
    }));
    expect(selectClip(source).drop).toBe(50);
  });

  test("uses the strongest sustained window for a gradual intro without inventing a drop", () => {
    for (const rampLength of [4, 8, 40]) {
      const source = analysis((time) => frame(time < rampLength ? time / rampLength : time < rampLength + 30 ? 1 : 0.02));
      const clip = selectClip(source);
      expect(clip.reason).toBe("energy");
      expect(clip.start).toBe(rampLength);
      expect(clip.drop).toBeNull();
      expect(clip.dropOffset).toBeNull();
    }
  });

  test("handles drops near the beginning and keeps three seconds of build-up near the end", () => {
    const beginning = selectClip(analysis((time) => frame(time >= 1 && time < 26 ? 0.8 : 0.05)));
    expect(beginning.drop).toBe(1);
    expect(beginning.start).toBe(0);
    expect(beginning.dropOffset).toBe(1);
    const ending = selectClip(analysis((time) => frame(time >= 82 ? 0.85 : 0.05)));
    expect(ending.drop).toBe(82);
    expect(ending.start).toBe(79);
    expect(ending.duration).toBe(11);
    expect(ending.dropOffset).toBe(3);
    expect(ending.end).toBe(90);
  });

  test("manual drop keeps its build-up and shortens at the source end", () => {
    const source = analysis(() => frame(0.2), 90.007, 60);
    const clip = selectClip(source, { drop: 86.217 });
    expect(clip.reason).toBe("manual");
    expect(clip.start).toBeCloseTo(83.2166666667, 8);
    expect(clip.drop).toBe(86.217);
    expect(clip.dropOffset).toBeCloseTo(3.0003333333, 8);
    expect(clip.end).toBe(source.duration);
    expect(clip.duration).toBeCloseTo(source.duration - clip.start, 10);
    const early = selectClip(source, { drop: 1.2 });
    expect(early.start).toBe(0);
    expect(early.dropOffset).toBe(1.2);
  });

  test("short sources retain their actual duration and silence selects the earliest window", () => {
    const source = analysis(() => frame(), 5.944, 60);
    expect(selectClip(source)).toEqual({
      start: 0, duration: 5.944, end: 5.944, drop: null, dropOffset: null, reason: "short-track", score: 0,
    });
    const silent = selectClip(analysis(() => frame()));
    expect(silent.reason).toBe("energy");
    expect(silent.start).toBe(0);
    expect(silent.duration).toBe(30);
    expect(silent.score).toBe(0);
    expect(selectClip(source, { drop: 2.5 }).reason).toBe("manual");
  });

  test("full-length clips remain within source and requested length after frame rounding", () => {
    const source = analysis((time) => frame(time > 50 ? 0.8 : 0.1), 70.011, 60);
    for (const requested of [30, 29.999, 20.001, 4.003]) {
      const clip = selectClip(source, { duration: requested });
      const encodedDuration = Math.ceil(clip.duration * 60 - 1e-9) / 60;
      expect(encodedDuration).toBeLessThanOrEqual(requested);
      expect(clip.start * 60).toBeCloseTo(Math.round(clip.start * 60), 9);
      expect(clip.end).toBeLessThanOrEqual(source.duration);
      expect(clip.duration).toBeGreaterThan(0);
    }
  });

  test("keeps manual drops inside the clip even with almost-full-length lead-ins", () => {
    const source = analysis(() => frame(0.2), 90, 60);
    for (const drop of [20, 20.009, 20.016]) {
      const clip = selectClip(source, { duration: 1.001, leadIn: 0.999, drop });
      expect(clip.start).toBeLessThanOrEqual(drop);
      expect(clip.end).toBeGreaterThan(drop);
      expect(clip.dropOffset).toBeLessThan(clip.duration);
      expect(Math.ceil(clip.duration * 60 - 1e-9) / 60).toBeLessThanOrEqual(1.001);
    }
  });

  test("finds the same sustained drop at 12, 30, and 60 analysis frames per second", () => {
    for (const fps of [12, 30, 60]) {
      const source = analysis((time) => frame(time >= 45 && time < 74 ? 0.8 : time === 10 ? 1 : 0.08), 90, fps);
      const clip = selectClip(source);
      expect(clip.drop).toBe(45);
      expect(clip.start).toBe(42);
      expect(clip.duration).toBe(30);
    }
  });

  test("rejects invalid options and invalid analysis timing", () => {
    const source = analysis(() => frame());
    for (const duration of [NaN, Infinity, -1, 0, 30.001]) expect(() => selectClip(source, { duration })).toThrow();
    for (const leadIn of [NaN, Infinity, -1, 30]) expect(() => selectClip(source, { leadIn })).toThrow();
    for (const drop of [NaN, Infinity, -1, 90, 91]) expect(() => selectClip(source, { drop })).toThrow();
    for (const fps of [NaN, Infinity, 0, -1]) expect(() => selectClip({ ...source, fps })).toThrow();
    expect(() => selectClip({ ...source, duration: 0 })).toThrow();
    expect(() => selectClip({ ...source, frames: [] })).toThrow();
  });
});
