import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { audioFieldAt, audioFieldGeometry, drawAudioField } from "../src/render/audio-field.js";
import { createSafeLayout } from "../src/render/layout.js";
import { randomPalette } from "../src/render/palette.js";
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
    expect(a.wave[64]!.y).toBeGreaterThan(b.wave[64]!.y + 0.1);
    expect(a.spokes).toEqual(b.spokes);
    expect(a.wave[0]).toEqual(b.wave[0]);
    for (const field of [a, b, audioFieldGeometry([NaN, Infinity], [NaN], NaN, Infinity, NaN)]) {
      for (const point of [...field.wave, ...field.halos.flatMap(h => h.points), ...field.spokes.flatMap(p => [{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }])]) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("keeps a maximum-energy field below credits in both output orientations and restores Canvas state", () => {
    const field = audioFieldGeometry(new Float32Array(32).fill(1), new Float32Array(32).fill(1), 1, 1, 4);
    for (const [width, height] of [[640, 360], [360, 640]]) {
      const canvas = createCanvas(width!, height!), context = canvas.getContext("2d");
      const layout = createSafeLayout(width!, height!);
      context.globalAlpha = 0.8;
      for (const front of [false, true]) drawAudioField(context, layout, field, randomPalette("field"), front, false);
      expect(context.globalAlpha).toBe(0.8);
      expect(context.globalCompositeOperation).toBe("source-over");
      const pixels = context.getImageData(0, 0, width!, height!).data;
      let lit = 0;
      for (let i = 3; i < Math.floor(layout.graphTop) * width! * 4; i += 4) expect(pixels[i]).toBe(0);
      for (let i = 3; i < pixels.length; i += 4) lit += Number(pixels[i]! > 0);
      expect(lit).toBeGreaterThan(500);
    }
  });
});
