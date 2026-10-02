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
