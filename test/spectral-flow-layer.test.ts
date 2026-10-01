import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";
import { createSafeLayout } from "../src/render/layout.js";
import { randomPalette, type ScenePalette } from "../src/render/palette.js";
import { SpectralFlowLayer, spectralFlowStateAt } from "../src/render/spectral-flow-layer.js";
import { FLOW_AGES } from "../src/render/spectral-flow.js";

function analysis(variant = 0, silent = false): AudioAnalysis {
  const fps = 60, duration = 12;
  return {
    version: ANALYSIS_VERSION, fps, duration, sampleRate: 48_000,
    spectrumBands: 32, waveformPoints: 64, sourceHash: `flow-${variant}`, sourceFileHash: `flow-${variant}`,
    frames: Array.from({ length: fps * duration }, (_, index) => {
      const time = index / fps, gain = silent ? 0 : 1;
      const bass = (0.2 + Math.sin(time * (1.2 + variant)) * 0.16) * gain;
      return {
        rms: (0.22 + bass * 0.6) * gain, peak: (0.45 + bass) * gain,
        bass, mid: (0.15 + Math.sin(time * 0.8) * 0.1) * gain,
        treble: (0.1 + Math.sin(time * 3.1) * 0.07) * gain,
        centroid: 0.4 * gain, flux: bass * 0.05, onset: 0,
        spectrum: Float32Array.from({ length: 32 }, (_, band) =>
          (0.22 + Math.sin(time * (0.8 + band * 0.1) + band + variant) * 0.18) * gain),
        waveform: Float32Array.from({ length: 64 }, (_, point) =>
          Math.sin(point * 0.3 + time * 0.7 + variant) * 0.4 * gain),
      };
    }),
  };
}

const neutral: ScenePalette = { source: "artwork", colors: [[0.7, 0.7, 0.7], [0.3, 0.3, 0.3]], anchorHue: 0 };
const green: ScenePalette = { source: "artwork", colors: [[0.1, 0.8, 0.1], [0.04, 0.35, 0.04]], anchorHue: 120 };

function fixture(width = 320, height = 180, palette = neutral, lowFlash = false, seed = "flow-canvas") {
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  const layout = createSafeLayout(width, height);
  const layer = new SpectralFlowLayer(width, height, layout, palette, seed, lowFlash);
  const render = (audio: AudioAnalysis, time: number, intensity = 1): Buffer => {
    context.clearRect(0, 0, width, height);
    layer.draw(context, audio, time, intensity);
    return Buffer.from(context.getImageData(0, 0, width, height).data);
  };
  return { canvas, context, layout, layer, render };
}

function visible(pixels: Buffer): number {
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) count += Number(pixels[index]! > 0);
  return count;
}

describe("spectral flow light layer", () => {
  test("reconstructs bounded historical signals at their own absolute timestamps", () => {
    const audio = analysis(), subject = fixture();
    expect(subject.layer.samples(audio, 0).map(sample => sample.age)).toEqual([0]);
    expect(subject.layer.samples(audio, 0.32).map(sample => sample.age)).toEqual([0.32, 0]);
    for (const time of [0.001, 0.65, 1.4, 4.37, 11.9, 100]) {
      const history = subject.layer.samples(audio, time);
      expect(history.length).toBeLessThanOrEqual(5);
      expect(history.map(sample => sample.age)).toEqual(FLOW_AGES.filter(age => age <= time));
      for (const sample of history) {
        expect(sample.state.time).toBe(time - sample.age);
        expect(sample.state).toEqual(spectralFlowStateAt(audio, time - sample.age));
      }
    }
    for (const invalid of [-1, NaN, Infinity]) expect(subject.layer.samples(audio, invalid)).toEqual([]);
    const history = subject.layer.samples(audio, 4.37);
    expect(history[0]!.state.waveform).not.toEqual(history.at(-1)!.state.waveform);
    expect(history[0]!.state.spectrum).not.toEqual(history.at(-1)!.state.spectrum);
  });

  test("replays identical pixels after seeks, changed analysis and a fresh renderer", () => {
    const audio = analysis(), subject = fixture();
    const expected = subject.render(audio, 4.37);
    expect(visible(expected)).toBeGreaterThan(300);
    for (const time of [10.7, 0, 2.1, 7.8, 11.3]) subject.render(audio, time);
    expect(subject.render(audio, 4.37)).toEqual(expected);
    expect(fixture().render(audio, 4.37)).toEqual(expected);
    const other = analysis(2);
    const changed = subject.render(other, 4.37);
    expect(changed).not.toEqual(expected);
    expect(changed).toEqual(fixture().render(other, 4.37));
    expect(subject.render(audio, 4.37)).toEqual(expected);
    expect(visible(subject.render(analysis(0, true), 4.37))).toBe(0);
    expect(subject.render(audio, 4.37)).toEqual(expected);
    expect(visible(subject.render(audio, 4.37, 0))).toBe(0);
  });

  test("keeps monochrome and single-family artwork light within the source palette", () => {
    const audio = analysis();
    for (const [width, height] of [[320, 180], [180, 320]] as const) {
      const gray = fixture(width, height).render(audio, 4.37);
      const colored = fixture(width, height, green).render(audio, 4.37);
      let chromatic = 0;
      expect(visible(gray)).toBeGreaterThan(250);
      for (let index = 0; index < gray.length; index += 4) {
        if (gray[index + 3]! > 8) {
          expect(Math.max(gray[index]!, gray[index + 1]!, gray[index + 2]!)
            - Math.min(gray[index]!, gray[index + 1]!, gray[index + 2]!)).toBeLessThanOrEqual(2);
        }
        if (colored[index + 3]! > 8) {
          expect(Math.abs(colored[index]! - colored[index + 2]!)).toBeLessThanOrEqual(2);
          expect(colored[index + 1]!).toBeGreaterThanOrEqual(colored[index]!);
          chromatic += Number(colored[index + 1]! > colored[index]! + 8);
        }
      }
      expect(chromatic).toBeGreaterThan(100);
    }
    const a = fixture(320, 180, randomPalette("flow-a")).render(audio, 4.37);
    const b = fixture(320, 180, randomPalette("flow-b")).render(audio, 4.37);
    expect(a).not.toEqual(b);
    expect(a).toEqual(fixture(320, 180, randomPalette("flow-a")).render(audio, 4.37));
  });

  test("leaves credits and lower readouts byte-identical after blur and upscaling", () => {
    const audio = analysis();
    for (const [width, height] of [[640, 360], [360, 640], [360, 360]] as const) {
      const subject = fixture(width, height, green);
      const { context, layout, layer } = subject;
      for (let y = 0; y < height; y++) {
        context.fillStyle = `rgb(${10 + y % 45},${15 + y % 37},${20 + y % 53})`;
        context.fillRect(0, y, width, 1);
      }
      const before = Buffer.from(context.getImageData(0, 0, width, height).data);
      layer.draw(context, audio, 4.37, 4);
      const after = Buffer.from(context.getImageData(0, 0, width, height).data);
      const topEnd = Math.floor(layout.graphTop) * width * 4;
      const bottomStart = Math.ceil(layout.graphBottom) * width * 4;
      expect(after.subarray(0, topEnd)).toEqual(before.subarray(0, topEnd));
      expect(after.subarray(bottomStart)).toEqual(before.subarray(bottomStart));
      expect(after.subarray(topEnd, bottomStart)).not.toEqual(before.subarray(topEnd, bottomStart));
    }
  });

  test("attenuates light for lowFlash and restores the caller's drawing state", () => {
    const audio = analysis();
    const full = fixture().render(audio, 4.37);
    const soft = fixture(320, 180, neutral, true).render(audio, 4.37);
    const alphaSum = (pixels: Buffer) => pixels.reduce((sum, value, index) => sum + (index % 4 === 3 ? value : 0), 0);
    expect(alphaSum(soft)).toBeGreaterThan(alphaSum(full) * 0.5);
    expect(alphaSum(soft)).toBeLessThan(alphaSum(full) * 0.95);
    const subject = fixture();
    subject.context.globalAlpha = 0.63;
    subject.context.globalCompositeOperation = "multiply";
    subject.context.filter = "blur(1.2px)";
    subject.context.lineWidth = 7;
    subject.context.setTransform(1.2, 0.1, 0.03, 0.7, 17, 9);
    const alpha = subject.context.globalAlpha, transform = subject.context.getTransform();
    subject.layer.draw(subject.context, audio, 4.37);
    expect(subject.context.globalAlpha).toBe(alpha);
    expect(subject.context.globalCompositeOperation).toBe("multiply");
    expect(subject.context.filter).toBe("blur(1.2px)");
    expect(subject.context.lineWidth).toBe(7);
    expect(subject.context.getTransform()).toEqual(transform);
  });
});
