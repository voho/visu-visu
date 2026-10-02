import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { createSafeLayout, signalBand } from "../src/render/layout.js";
import { randomPalette } from "../src/render/palette.js";
import {
  drawSignalBand,
  normalizedBandsAt,
  oscilloscopePath,
  signalBandAt,
  spectrumStripGeometry,
  type SignalStripStyle,
} from "../src/render/signal-strip.js";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";

function source(sample: (time: number) => { rms?: number; spectrum?: Float32Array; waveform?: Float32Array }, fps = 60, seconds = 8): AudioAnalysis {
  return { version: ANALYSIS_VERSION, sampleRate: 24000, fps, duration: seconds, spectrumBands: 64, waveformPoints: 32,
    sourceHash: "signal-strip", sourceFileHash: "signal-strip-file",
    frames: Array.from({ length: fps * seconds }, (_, index): AnalysisFrame => {
      const value = sample(index / fps);
      const rms = value.rms ?? 0.3;
      return { rms, peak: rms, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset: 0,
        spectrum: value.spectrum ?? new Float32Array(64), waveform: value.waveform ?? new Float32Array(32) };
    }) };
}
const style: SignalStripStyle = {
  palette: randomPalette("signal-strip"),
  warm: { phase: 0, direction: 1 },
  cool: { phase: 180, direction: -1 },
};
const drive = { kick: 0.5, section: 0.7, treblePulse: 0.3 };
const sizes = [[1920, 1080], [1080, 1920], [1080, 1080]] as const;

describe("signal band: spectrum strip and floor oscilloscope", () => {
  test("is a pure function of absolute time regardless of earlier seeks", () => {
    const analysis = source(time => ({ rms: 0.2 + 0.5 * Math.abs(Math.sin(time * 3)),
      spectrum: Float32Array.from({ length: 64 }, (_, band) => 0.5 + 0.5 * Math.sin(time * (band + 1))),
      waveform: Float32Array.from({ length: 32 }, (_, i) => Math.sin(time * 7 + i)) }));
    const layout = createSafeLayout(1920, 1080);
    const expected = signalBandAt(analysis, 3.37, layout, 1080, drive);
    const fresh = source(time => ({ rms: 0.2 + 0.5 * Math.abs(Math.sin(time * 3)),
      spectrum: Float32Array.from({ length: 64 }, (_, band) => 0.5 + 0.5 * Math.sin(time * (band + 1))),
      waveform: Float32Array.from({ length: 32 }, (_, i) => Math.sin(time * 7 + i)) }));
    for (const seek of [7.9, 0, 5.21, 3.36, 0.4]) signalBandAt(fresh, seek, layout, 1080, drive);
    expect(signalBandAt(fresh, 3.37, layout, 1080, drive)).toEqual(expected);
    expect(signalBandAt(analysis, 3.37, layout, 1080, drive)).toEqual(expected);
  });

  test("normalises every band to its own track ceiling so a quiet band still fills its bar", () => {
    const bassOnly = source(time => ({
      spectrum: Float32Array.from({ length: 64 }, (_, band) => band === 0 && time >= 1 ? 0.9 : 0) }));
    const layout = createSafeLayout(1920, 1080);
    const bars = spectrumStripGeometry(layout, 1080, normalizedBandsAt(bassOnly, 1.4), 1);
    expect(bars[0]!.height).toBeGreaterThan(bars[63]!.height * 4);
    // Band 63 never exceeds 0.3, which is therefore its own p98: full scale.
    const quietHat = source(() => ({ spectrum: Float32Array.from({ length: 64 }, (_, band) => band === 63 ? 0.3 : 0) }));
    expect(normalizedBandsAt(quietHat, 2)[63]!).toBeGreaterThanOrEqual(0.8);
    // A kick reaches the lowest bars before the envelope does, never the rest.
    const silent = source(() => ({}));
    const kicked = normalizedBandsAt(silent, 2, 1);
    expect(kicked[0]!).toBeCloseTo(0.2, 6);
    expect(kicked[9]!).toBeCloseTo(0.2, 6);
    expect(kicked[10]!).toBe(0);
  });

  test("keeps every bar and scope point inside the band below the graph in every orientation", () => {
    const loud = source(() => ({ rms: 1, spectrum: new Float32Array(64).fill(1),
      waveform: Float32Array.from({ length: 32 }, (_, i) => i % 2 ? 1 : -1) }));
    for (const [width, height] of sizes) {
      const layout = createSafeLayout(width, height);
      const band = signalBand(layout, height);
      const frame = signalBandAt(loud, 4, layout, height, { kick: 1, section: 1, treblePulse: 1 });
      const floor = layout.graphBottom + height * 0.01, ceiling = height * 0.80;
      for (const bar of frame.bars) {
        expect(bar.x).toBeGreaterThanOrEqual(layout.left);
        expect(bar.x + bar.width).toBeLessThanOrEqual(layout.right + 1e-9);
        expect(bar.y).toBeGreaterThanOrEqual(floor);
        expect(bar.y + bar.height).toBeLessThanOrEqual(ceiling);
        expect(bar.height).toBeLessThanOrEqual(band.barMax + 1e-9);
      }
      expect(Math.max(...frame.bars.map(bar => bar.height))).toBeGreaterThan(band.barMax * 0.85);
      expect(frame.bars).toHaveLength(64);
      expect(frame.peaks).toHaveLength(64);
      for (const peak of frame.peaks) {
        expect(peak.y).toBeGreaterThanOrEqual(floor);
        expect(peak.y + peak.height).toBeLessThanOrEqual(ceiling);
      }
      expect(frame.traces).toHaveLength(3);
      for (const trace of frame.traces) for (const point of trace.points) {
        expect(point.x).toBeGreaterThanOrEqual(layout.left);
        expect(point.x).toBeLessThanOrEqual(layout.right + 1e-9);
        expect(point.y).toBeGreaterThanOrEqual(floor);
        expect(point.y).toBeLessThanOrEqual(ceiling);
      }
      // Even the four-times-wider bloom stroke stays clear of the full-scale caps.
      const strokeBottom = Math.max(...frame.traces[0]!.points.map(point => point.y)) + frame.traces[0]!.lineWidth * 2;
      expect(strokeBottom).toBeLessThan(Math.min(...frame.peaks.map(peak => peak.y)));
      const swing = frame.traces[0]!.points.map(point => point.y);
      expect(Math.max(...swing) - Math.min(...swing)).toBeGreaterThan(height * 0.006);
    }
  });

  test("survives NaN, empty and missing signals with minimum heights and a flat trace", () => {
    const layout = createSafeLayout(1920, 1080);
    const bars = spectrumStripGeometry(layout, 1080, [Number.NaN, Infinity], Number.NaN);
    expect(bars).toHaveLength(64);
    for (const bar of bars) expect(bar.height).toBeCloseTo(1080 * 0.008 * signalBand(layout, 1080).geometryScale, 9);
    const flat = oscilloscopePath(layout, 1080, [], Number.NaN);
    for (const point of flat) expect(point.y).toBe(signalBand(layout, 1080).scopeY);
    const broken: AudioAnalysis = { ...source(() => ({})), frames: [] };
    expect(() => normalizedBandsAt(broken, 1)).not.toThrow();
    expect(Array.from(normalizedBandsAt(broken, 1))).toEqual(new Array(64).fill(0));
  });

  test("paints only below the graph and restores Canvas state", () => {
    const loud = source(() => ({ rms: 1, spectrum: new Float32Array(64).fill(1),
      waveform: Float32Array.from({ length: 32 }, (_, i) => Math.sin(i)) }));
    for (const [width, height] of [[640, 360], [360, 640]] as const) {
      const layout = createSafeLayout(width, height);
      const canvas = createCanvas(width, height), context = canvas.getContext("2d");
      context.globalAlpha = 0.8;
      context.lineWidth = 7;
      context.globalCompositeOperation = "multiply";
      const frame = signalBandAt(loud, 4, layout, height, { kick: 1, section: 1, treblePulse: 1 });
      for (const emission of [false, true]) drawSignalBand(context, frame, style, emission);
      expect(context.globalAlpha).toBe(0.8);
      expect(context.lineWidth).toBe(7);
      expect(context.globalCompositeOperation).toBe("multiply");
      const pixels = context.getImageData(0, 0, width, height).data;
      const graphEnd = Math.floor(layout.graphBottom) * width * 4;
      for (let i = 3; i < graphEnd; i += 4) expect(pixels[i]).toBe(0);
      let lit = 0;
      for (let i = graphEnd + 3; i < pixels.length; i += 4) lit += Number(pixels[i]! > 0);
      expect(lit).toBeGreaterThan(width * 4);
    }
  });
});
