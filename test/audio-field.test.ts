import { describe, expect, test } from "bun:test";
import { audioFieldAt, audioFieldGeometry, smoothedFrameAt } from "../src/render/audio-field.js";
import { frameAt } from "../src/audio/analyze.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

function source(sample: (time: number) => { rms: number; spectrum?: Float32Array }, fps = 60): AudioAnalysis {
  return { version: ANALYSIS_VERSION, sampleRate: 24000, fps, duration: 8, spectrumBands: 32, waveformPoints: 32,
    sourceHash: "audio-field", sourceFileHash: "audio-field-file",
    frames: Array.from({ length: fps * 8 }, (_, index): AnalysisFrame => {
      const value = sample(index / fps);
      return { rms: value.rms, peak: value.rms, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset: 0,
        spectrum: value.spectrum ?? new Float32Array(32), waveform: new Float32Array(32) };
    }) };
}
const burst = (time: number) => ({ rms: time >= 1 && time < 1.5 ? 0.8 : 0 });

describe("visible spectrum and amplitude field", () => {
  test("separates quick amplitude response from slow breathing without anticipating a hit", () => {
    const analysis = source(burst);
    expect(audioFieldAt(analysis, 1 - 1e-9).fast).toBe(0);
    expect(audioFieldAt(analysis, 1).slow).toBe(0);
    const attack = audioFieldAt(analysis, 1.05);
    expect(attack.fast).toBeGreaterThan(attack.slow * 4);
    expect(attack.fast).toBeGreaterThan(0.7);
    const release = audioFieldAt(analysis, 2.5);
    expect(release.fast).toBeLessThan(0.01);
    expect(release.slow).toBeGreaterThan(0.2);
    expect(Array.from(release.spectrum)).toEqual(new Array(32).fill(0));
  });

  test("has the same physical timing across frame rates and arbitrary seeks", () => {
    const a = source(burst, 30), b = source(burst, 60);
    const expected = audioFieldAt(a, 1.617);
    for (const time of [7, 0.1, 4.6, 1, 5.7]) audioFieldAt(a, time);
    expect(audioFieldAt(a, 1.617)).toEqual(expected);
    expect(audioFieldAt(b, 1.617).fast).toBeCloseTo(expected.fast, 10);
    expect(audioFieldAt(b, 1.617).slow).toBeCloseTo(expected.slow, 10);
    const changed = source(time => time > 4 ? { rms: 1 } : burst(time), 30);
    expect(audioFieldAt(changed, 1.617)).toEqual(expected);
  });

  test("eases spectrum velocity through FFT changes while preserving causal and frame-rate-independent hits", () => {
    const signal = (time: number) => ({ rms: 0.3,
      spectrum: new Float32Array(32).fill(time >= 1 && time < 1.5 ? 0.8 : 0) });
    const a = source(signal, 30), b = source(signal, 60);
    expect(Array.from(audioFieldAt(a, 1).spectrum)).toEqual(new Array(32).fill(0));
    expect(audioFieldAt(a, 1.001).spectrum[0]!).toBeLessThan(0.002);
    expect(audioFieldAt(a, 1.1).spectrum[0]!).toBeGreaterThan(0.65);
    for (const boundary of [1, 1.5]) {
      const epsilon = 0.0001;
      const before = audioFieldAt(a, boundary - epsilon).spectrum[0]!;
      const at = audioFieldAt(a, boundary).spectrum[0]!;
      const after = audioFieldAt(a, boundary + epsilon).spectrum[0]!;
      expect(Math.abs((after - at) / epsilon - (at - before) / epsilon)).toBeLessThan(0.15);
    }
    const changed = source(time => time > 4 ? { rms: 1, spectrum: new Float32Array(32).fill(1) } : signal(time), 30);
    for (const time of [1.025, 1.173, 1.617, 2.23]) {
      const expected = audioFieldAt(a, time);
      for (const seek of [7.1, 0, 3.13, 0.7]) audioFieldAt(a, seek);
      expect(audioFieldAt(a, time)).toEqual(expected);
      const higherRate = audioFieldAt(b, time);
      expect(higherRate.fast).toBeCloseTo(expected.fast, 10);
      expect(higherRate.slow).toBeCloseTo(expected.slow, 10);
      expect(higherRate.spectrum).toEqual(expected.spectrum);
      expect(audioFieldAt(changed, time)).toEqual(expected);
    }
  });

  test("shows frequency shape separately from amplitude and gives bass larger, longer-lived stems", () => {
    const band = (index: number) => source(time => ({ rms: 0.3,
      spectrum: Float32Array.from({ length: 32 }, (_, i) => i === index && time >= 1 && time < 1.5 ? 0.8 : 0) }));
    const low = audioFieldAt(band(0), 1.45), high = audioFieldAt(band(31), 1.45);
    expect(low.fast).toBe(high.fast);
    expect(low.slow).toBe(high.slow);
    const a = audioFieldGeometry(low.spectrum, [], low.fast, low.slow, 0);
    const b = audioFieldGeometry(high.spectrum, [], high.fast, high.slow, 0);
    expect(a.halos).toEqual(b.halos);
    const longest = (field: typeof a) => Math.max(...field.spokes.map(p => Math.hypot(p.x2 - p.x1, p.y2 - p.y1)));
    expect(longest(a)).toBeGreaterThan(longest(b) * 2.5);
    const lowTail = audioFieldAt(band(0), 1.8).spectrum[0]!;
    const highTail = audioFieldAt(band(31), 1.8).spectrum[31]!;
    expect(lowTail).toBeGreaterThan(highTail * 4);
  });

  test("retains the signed waveform and bounds every point even at maximum energy", () => {
    const a = audioFieldGeometry(new Float32Array(32).fill(1), new Float32Array(32).fill(1), 1, 1, 4);
    const b = audioFieldGeometry(new Float32Array(32).fill(1), new Float32Array(32).fill(-1), 1, 1, 4);
    const middle = Math.floor(a.wave.length / 2);
    expect(a.wave[middle]!.y).toBeGreaterThan(b.wave[middle]!.y + 0.1);
    expect(a.spokes).toEqual(b.spokes);
    expect(a.wave[0]).toEqual(b.wave[0]);
    expect(a.wave.at(-1)).toEqual(b.wave.at(-1));
    for (const field of [a, b, audioFieldGeometry([NaN, Infinity], [NaN], NaN, Infinity, NaN)]) {
      for (const point of [...field.wave, ...field.halos.flatMap(h => h.points), ...field.spokes.flatMap(p => [{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }])]) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("softens adjacent spectral steps without moving peaks or losing band energy", () => {
    for (const peak of [0, 8, 17, 31]) {
      const spectrum = Float32Array.from({ length: 32 }, (_, i) => i === peak ? 1 : 0);
      const field = audioFieldGeometry(spectrum, [], 0, 0, 0);
      const energies = field.spokes.filter((_, i) => i % 2 === 0).map(p => p.energy);
      expect(field.spokes).toHaveLength(64);
      expect(energies.indexOf(Math.max(...energies))).toBe(peak);
      expect(energies.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
      expect(energies[peak]!).toBeGreaterThanOrEqual(0.75);
      expect(energies[peak === 31 ? peak - 1 : peak + 1]!).toBeGreaterThan(0.1);
      expect(Math.max(...energies.map((value, i) => Math.abs(value - (energies[i + 1] ?? value))))).toBeLessThan(0.8);
      for (let band = 0; band < 32; band++) {
        expect(field.spokes[band * 2]!.energy).toBe(field.spokes[band * 2 + 1]!.energy);
      }
    }
  });

  test("rounds waveform extrema while retaining signed samples and avoiding interpolation overshoot", () => {
    const field = audioFieldGeometry([], [0, 1, 0, -1, 0], 1, 0, 0);
    const last = field.wave.length - 1;
    const values = field.wave.map((point, index) => {
      if (index === 0 || index === last) return 0;
      const taper = Math.sin(index / last * Math.PI) ** 1.2;
      return (Math.hypot(point.x, point.y) - 0.88) / (0.08 * taper);
    });
    const peak = last / 4;
    expect(values[peak]!).toBeCloseTo(1, 10);
    expect(values[peak * 2]!).toBeCloseTo(0, 10);
    expect(values[peak * 3]!).toBeCloseTo(-1, 10);
    expect(values[peak]! - values[peak - 1]!).toBeLessThan(0.0015);
    expect(values[peak]! - values[peak + 1]!).toBeLessThan(0.0015);
    for (let index = 1; index < last; index++) {
      expect(Math.abs(values[index]!)).toBeLessThanOrEqual(1 + 1e-12);
      expect(values[index]! * (index < last / 2 ? 1 : -1)).toBeGreaterThanOrEqual(-1e-12);
    }
  });
});

describe("smoothedFrameAt", () => {
  test("keeps the frame's own onset, loudness and waveform but follows the band envelopes", () => {
    const fps = 60;
    const bands = 64;
    const quiet = () => new Float32Array(bands).fill(0.02);
    const loud = () => new Float32Array(bands).fill(0.9);
    const frames = Array.from({ length: fps * 2 }, (_, index) => ({
      rms: index >= fps ? 0.8 : 0.1, peak: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, centroid: 0.5, flux: 0,
      onset: index === fps ? 1 : 0,
      spectrum: index >= fps ? loud() : quiet(),
      waveform: Float32Array.from({ length: 8 }, (_, point) => (index >= fps ? 0.5 : 0.1) * Math.sin(point)),
    }));
    const analysis = {
      version: 2, sampleRate: 24_000, fps, duration: 2, spectrumBands: bands, waveformPoints: 8,
      sourceHash: "smooth", sourceFileHash: "smooth-file", frames,
    };
    const raw = frameAt(analysis, 1);
    const atStep = smoothedFrameAt(analysis, 1);
    expect(atStep.spectrum).toHaveLength(bands);
    expect(atStep.onset).toBe(raw.onset);
    expect(atStep.rms).toBe(raw.rms);
    expect(atStep.waveform).toBe(raw.waveform);
    // The envelopes have not moved yet on the step frame and build over the next frames.
    expect(atStep.spectrum[10]!).toBeLessThan(0.1);
    const oneFrame = smoothedFrameAt(analysis, 1 + 1 / fps).spectrum[10]!;
    const fourFrames = smoothedFrameAt(analysis, 1 + 4 / fps).spectrum[10]!;
    const settled = smoothedFrameAt(analysis, 1.9).spectrum[10]!;
    expect(oneFrame).toBeGreaterThan(atStep.spectrum[10]!);
    expect(fourFrames).toBeGreaterThan(oneFrame);
    expect(fourFrames).toBeLessThan(0.9);
    expect(settled).toBeCloseTo(0.9, 2);
    // Bass, mid and treble follow the smoothed spectrum, not the per-frame FFT.
    expect(atStep.bass).toBeLessThan(0.1);
    expect(smoothedFrameAt(analysis, 1.9).bass).toBeCloseTo(0.9, 2);
    expect(smoothedFrameAt(analysis, 1.9).mid).toBeCloseTo(0.9, 2);
    expect(smoothedFrameAt(analysis, 1.9).treble).toBeCloseTo(0.9, 2);
    for (const value of atStep.spectrum) expect(value).toBeGreaterThanOrEqual(0);
    expect(smoothedFrameAt(analysis, 1.5)).toEqual(smoothedFrameAt(analysis, 1.5));
  });
});
