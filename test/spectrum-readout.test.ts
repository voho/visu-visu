import { describe, expect, test } from "bun:test";
import { audioFieldAt } from "../src/render/audio-field.js";
import { SPECTRUM_STRIP_BANDS, spectrumReadoutAt } from "../src/render/spectrum-readout.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function track(sample: (index: number, band: number) => number, fps = 60): AudioAnalysis {
  return { version: ANALYSIS_VERSION, sampleRate: 24000, fps, duration: 6,
    spectrumBands: 64, waveformPoints: 32, sourceHash: "readout", sourceFileHash: "readout-file",
    frames: Array.from({ length: fps * 6 }, (_, index) => ({
      rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset: 0,
      spectrum: Float32Array.from({ length: 64 }, (_, band) => sample(index, band)), waveform: new Float32Array(32),
    })) };
}

describe("64-band spectrum envelopes and falling peaks", () => {
  test("resolves adjacent source bins independently while material signals remain 32 bands", () => {
    const analysis = track((_, band) => band === 17 ? 0.8 : 0);
    const { levels, peaks } = spectrumReadoutAt(analysis, 1);
    expect(levels).toHaveLength(SPECTRUM_STRIP_BANDS);
    expect(levels[17]).toBeGreaterThan(0.99);
    expect(peaks[17]).toBe(1);
    for (let band = 0; band < 64; band++) if (band !== 17) {
      expect(levels[band]).toBe(0);
      expect(peaks[band]).toBe(0);
    }
    expect(audioFieldAt(analysis, 1).spectrum).toHaveLength(32);
  });

  test("captures a hit immediately, holds for 200 ms, then falls at 0.38 per second", () => {
    const analysis = track((index, band) => index === 60 && band === 17 ? 0.12 : 0);
    expect(spectrumReadoutAt(analysis, 1 - 1e-6).peaks[17]).toBe(0);
    const hit = spectrumReadoutAt(analysis, 1);
    expect(hit.peaks[17]).toBeCloseTo(1, 6);
    expect(hit.levels[17]).toBe(0); // the bar retains its gentler attack
    for (const time of [1.03, 1.1, 1.199, 1.2]) expect(spectrumReadoutAt(analysis, time).peaks[17]).toBeCloseTo(1, 6);
    for (const time of [1.3, 1.7, 2, 2.6, 3.5]) {
      expect(spectrumReadoutAt(analysis, time).peaks[17]).toBeCloseTo(1 - (time - 1.2) * 0.38, 6);
    }
    const earlier = spectrumReadoutAt(analysis, 1.301).peaks[17]!;
    const later = spectrumReadoutAt(analysis, 1.309).peaks[17]!;
    expect(earlier - later).toBeCloseTo(0.008 * 0.38, 6);
  });

  test("restarts peak hold when a later hit overtakes the falling cap", () => {
    const analysis = track((index, band) => band !== 17 ? 0 : index === 60 ? 0.12 : index === 120 ? 0.11 : 0);
    const height = (0.11 / 0.12) ** 0.8;
    expect(spectrumReadoutAt(analysis, 1.99).peaks[17]).toBeLessThan(height);
    for (const time of [2, 2.05, 2.2]) expect(spectrumReadoutAt(analysis, time).peaks[17]).toBeCloseTo(height, 6);
    expect(spectrumReadoutAt(analysis, 2.4).peaks[17]).toBeCloseTo(height - 0.2 * 0.38, 6);
    const quieter = track((index, band) => band !== 17 ? 0 : index === 60 ? 0.12 : index === 96 ? 0.03 : 0);
    // An undershooting hit must not freeze a cap that is already descending.
    expect(spectrumReadoutAt(quieter, 1.8).peaks[17]).toBeCloseTo(1 - 0.6 * 0.38, 6);
  });

  test("uses elapsed seconds at any analysis rate and is independent of seeks", () => {
    const sample = (fps: number) => track((index, band) => band === 17 && index === fps ? 0.12 : 0, fps);
    const analysis = sample(60), fresh = sample(60);
    const expected = spectrumReadoutAt(analysis, 2.317);
    for (const time of [5.99, 0, 4.1, 1.2, 1, 3]) spectrumReadoutAt(fresh, time);
    expect(spectrumReadoutAt(fresh, 2.317)).toEqual(expected);
    expect(spectrumReadoutAt(sample(20), 2.317).peaks).toEqual(expected.peaks);
    // Moving across an FFT boundary never steps downward between 60 fps frames.
    const before = spectrumReadoutAt(analysis, 2 - 1e-6).peaks[17]!;
    const after = spectrumReadoutAt(analysis, 2 + 1e-6).peaks[17]!;
    expect(before - after).toBeCloseTo(2e-6 * 0.38, 6);
  });

  test("silent and invalid input never invents peaks, and expired hits fade to silence", () => {
    const silent = track(() => 0);
    const broken = track((_, band) => band % 2 ? Number.NaN : Infinity);
    for (const analysis of [silent, broken, { ...silent, frames: [] }]) {
      for (const time of [0, 1.357, 5.9, Number.NaN, -2]) {
        const state = spectrumReadoutAt(analysis, time);
        expect(Array.from(state.peaks)).toEqual(new Array(64).fill(0));
        expect(Array.from(state.levels)).toEqual(new Array(64).fill(0));
      }
    }
    const hit = track((index, band) => index === 60 && band === 17 ? 0.12 : 0);
    expect(spectrumReadoutAt(hit, 5.9).peaks[17]).toBeLessThan(1e-5);
  });
});

describe("fast promo spectrum with slow peak caps", () => {
  test("reacts within the first 60 fps frame and releases quickly with lighter treble momentum", () => {
    const analysis = track(index => index === 60 ? 0.12 : 0);
    const before = spectrumReadoutAt(analysis, 1 - 1e-6, "promo");
    expect(Array.from(before.levels)).toEqual(new Array(64).fill(0));
    expect(Array.from(before.peaks)).toEqual(new Array(64).fill(0));
    const onset = spectrumReadoutAt(analysis, 1, "promo");
    expect(onset.levels[0]).toBe(0);
    expect(onset.peaks[0]).toBe(1);
    const nextFrame = spectrumReadoutAt(analysis, 61 / 60, "promo");
    expect(Math.min(...nextFrame.levels)).toBeGreaterThan(0.65);
    const released = spectrumReadoutAt(analysis, 1.3, "promo");
    expect(Math.max(...released.levels)).toBeLessThan(0.1);
    expect(released.levels[63]!).toBeLessThan(released.levels[0]!);
    expect(Math.min(...released.peaks)).toBe(1);
  });

  test("holds raw peaks for 300 ms, then falls independently at 0.22 per second", () => {
    const analysis = track((index, band) => index === 60 && band === 17 ? 0.12 : 0);
    for (const time of [1, 1.02, 1.15, 1.299, 1.3]) {
      expect(spectrumReadoutAt(analysis, time, "promo").peaks[17]).toBeCloseTo(1, 6);
    }
    for (const time of [1.4, 1.8, 2.3, 3.7, 5.7]) {
      expect(spectrumReadoutAt(analysis, time, "promo").peaks[17]).toBeCloseTo(1 - (time - 1.3) * 0.22, 6);
    }
    const earlier = spectrumReadoutAt(analysis, 2.301, "promo").peaks[17]!;
    const later = spectrumReadoutAt(analysis, 2.309, "promo").peaks[17]!;
    expect(earlier - later).toBeCloseTo(0.008 * 0.22, 6);
    expect(spectrumReadoutAt(analysis, 2.3, "promo").levels[17]!).toBeLessThan(1e-5);
    expect(spectrumReadoutAt(analysis, 6, "promo").peaks[17]!).toBeLessThan(1e-5);
  });

  test("keeps standard and promo caches independent and remains deterministic across seeks", () => {
    const sample = (fps = 60) => track((index, band) => index === fps && band === 17 ? 0.12 : 0, fps);
const analysis = sample(), fresh = sample();
    const standard = spectrumReadoutAt(analysis, 61 / 60);
    const promo = spectrumReadoutAt(analysis, 61 / 60, "promo");
    expect(promo.levels[17]!).toBeGreaterThan(standard.levels[17]! * 2);
    for (const time of [5.99, 0, 4.1, 1.2, 1, 3]) {
      spectrumReadoutAt(fresh, time, "promo");
      spectrumReadoutAt(fresh, time, "standard");
    }
    expect(spectrumReadoutAt(fresh, 61 / 60, "promo")).toEqual(promo);
    expect(spectrumReadoutAt(fresh, 61 / 60)).toEqual(standard);
    expect(spectrumReadoutAt(analysis, 61 / 60, "standard")).toEqual(standard);
    const expected = spectrumReadoutAt(analysis, 2.317, "promo");
    expect(spectrumReadoutAt(fresh, 2.317, "promo")).toEqual(expected);
    expect(spectrumReadoutAt(sample(20), 2.317, "promo").peaks).toEqual(expected.peaks);
    const before = spectrumReadoutAt(analysis, 2 - 1e-6, "promo").peaks[17]!;
    const after = spectrumReadoutAt(analysis, 2 + 1e-6, "promo").peaks[17]!;
    expect(before - after).toBeCloseTo(2e-6 * 0.22, 6);
  });

  test("never creates promo motion from silent, invalid or empty spectra", () => {
    const silent = track(() => 0);
    const broken = track((_, band) => band % 2 ? Number.NaN : Infinity);
    for (const analysis of [silent, broken, { ...silent, frames: [] }]) {
      for (const time of [0, 1.357, 5.9, Number.NaN, -2]) {
        const state = spectrumReadoutAt(analysis, time, "promo");
        expect(Array.from(state.levels)).toEqual(new Array(64).fill(0));
        expect(Array.from(state.peaks)).toEqual(new Array(64).fill(0));
      }
    }
  });
});

describe("stereo readout", () => {
  const stereo = () => {
    const analysis = track(() => 0);
    for (const [index, frame] of analysis.frames.entries()) {
      frame.spectrumLeft = Float32Array.from({ length: 64 }, (_, band) =>
        index >= 60 && index < 120 && band === 17 ? 0.8 : 0);
      frame.spectrumRight = Float32Array.from({ length: 64 }, (_, band) =>
        index >= 60 && index < 120 ? (band === 17 ? 0.2 : band === 43 ? 0.8 : 0) : 0);
    }
    return analysis;
  };

  test("shares each band's ceiling so stereo balance is not independently amplified", () => {
    const analysis = stereo();
    for (const profile of ["standard", "promo"] as const) {
      const left = spectrumReadoutAt(analysis, 1.8, profile, "left");
      const right = spectrumReadoutAt(analysis, 1.8, profile, "right");
      expect(left.levels[17]!).toBeGreaterThan(0.99);
      expect(right.levels[17]!).toBeCloseTo(0.25 ** 0.8, 5);
      expect(left.levels[43]).toBe(0);
      expect(right.levels[43]!).toBeGreaterThan(0.99);
      expect(left.peaks[17]).toBe(1);
      expect(right.peaks[17]!).toBeCloseTo(0.25 ** 0.8, 5);
      expect(spectrumReadoutAt(analysis, 1.8, profile).levels[17]).toBe(0);
    }
  });

  test("keeps channel history independent of seeks, profile and channel evaluation order", () => {
    const analysis = stereo(), fresh = stereo();
    const expected = spectrumReadoutAt(analysis, 2.317, "promo", "left");
    for (const time of [5.9, 0, 1.5, 4.1]) {
      spectrumReadoutAt(fresh, time, "standard", "right");
      spectrumReadoutAt(fresh, time, "promo", "right");
      spectrumReadoutAt(fresh, time, "promo", "left");
    }
    expect(spectrumReadoutAt(fresh, 2.317, "promo", "left")).toEqual(expected);
    expect(spectrumReadoutAt(fresh, 2.317, "promo", "right"))
      .toEqual(spectrumReadoutAt(analysis, 2.317, "promo", "right"));
    expect(expected.peaks[17]!).toBeCloseTo(1 - (2.317 - (119 / 60 + 0.3)) * 0.22, 6);
  });
});
