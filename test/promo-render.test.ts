import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { parseProjectConfig } from "../src/config.js";
import type { PreparedArtwork } from "../src/render/artwork.js";
import { extractPalette } from "../src/render/palette.js";
import { createPromoLayout, PromoRenderer, promoSignalsAt } from "../src/render/promo.js";
import { ANALYSIS_VERSION, type AudioAnalysis } from "../src/types.js";

function track(sample: (index: number, band: number) => number, waveform = false): AudioAnalysis {
  const fps = 60, duration = 6;
  return {
    version: ANALYSIS_VERSION, sampleRate: 24_000, fps, duration,
    spectrumBands: 64, waveformPoints: 64, sourceHash: "promo-render", sourceFileHash: "promo-render-file",
    frames: Array.from({ length: fps * duration }, (_, index) => ({
      rms: waveform && index >= fps ? 0.5 : 0, peak: 0.8, bass: 0.1, mid: 0.1, treble: 0.1,
      centroid: 0.4, flux: 0, onset: 0,
      spectrum: Float32Array.from({ length: 64 }, (_, band) => sample(index, band)),
      waveform: Float32Array.from({ length: 64 }, (_, point) => waveform && index >= fps
        ? Math.sin(point * 0.5 + index * 0.04) * 0.8 : 0),
    })),
  };
}

function artwork(): PreparedArtwork {
  const canvas = createCanvas(256, 256), context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, "#282828"); gradient.addColorStop(1, "#e0e0e0");
  context.fillStyle = gradient; context.fillRect(0, 0, 256, 256);
  context.fillStyle = "#808080"; context.fillRect(40, 40, 80, 140);
  return { canvas, thumbnail: canvas, width: 640, height: 360, accentHue: 0, secondaryHue: 0,
    palette: extractPalette(context.getImageData(0, 0, 256, 256).data) };
}

function composition(width = 640, height = 360) {
  const config = parseProjectConfig({ output: { width, height }, visual: { mode: "promo", imagePath: "fixture.png" },
    text: { title: "Night Signal", artist: "voho" } });
  const background = createCanvas(width, height), context = background.getContext("2d");
  context.fillStyle = "#363636"; context.fillRect(0, 0, width, height);
  return { renderer: new PromoRenderer(config, { width, height }, artwork()), background };
}

describe("promo composition", () => {
  test("keeps gallery elements separate with a 68% waveform and player-safe spectrum", () => {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080], [640, 360], [160, 640], [640, 160]]) {
      const layout = createPromoLayout(width!, height!);
      expect(layout.cover.y + layout.cover.size / 2).toBeCloseTo(height! / 2, 7);
      expect(layout.text.centerY).toBeLessThan(height! / 2);
      expect(layout.text.artistSize).toBe(layout.text.titleSize);
      expect(layout.text.x).toBeGreaterThan(layout.cover.x + layout.cover.size);
      expect(layout.text.x + layout.text.width).toBeLessThan(width!);
      expect(layout.text.width).toBeGreaterThan(0);
      expect(layout.cover.y + layout.cover.size).toBeLessThanOrEqual(height! * 0.7 + 1e-8);
      expect(layout.scopeX).toBe(layout.text.x);
      expect(layout.scopeWidth).toBe(layout.text.width);
      expect(layout.scopeHeight).toBeCloseTo(layout.cover.size * 0.68, 7);
      expect(layout.text.bottom).toBeLessThan(layout.scopeY - layout.scopeHeight / 2);
      expect(layout.spectrumTop).toBeGreaterThan(layout.scopeY + layout.scopeHeight / 2);
      expect(layout.spectrumBaseline - layout.spectrumTop).toBeLessThanOrEqual(height! * 0.3 + 1e-8);
      expect(layout.spectrumBaseline).toBe(height! * 0.94);
      const signals = promoSignalsAt(track(() => 1), 2, width!, height!);
      expect(signals.bars).toHaveLength(64);
      for (const bar of signals.bars) {
        expect(bar.x).toBeGreaterThanOrEqual(width! * 0.08);
        expect(bar.x + bar.width).toBeLessThanOrEqual(width! * 0.92 + 1e-8);
        expect(bar.y).toBeGreaterThanOrEqual(layout.spectrumTop);
        expect(bar.y + bar.height).toBeCloseTo(layout.spectrumBaseline, 6);
        expect(bar.peakY).toBeGreaterThanOrEqual(layout.spectrumTop);
        expect(bar.peakY).toBeLessThanOrEqual(layout.spectrumBaseline);
      }
    }
  });

  test("keeps silent readouts flat and waits for an onset before easing into movement", () => {
    const silence = track(() => 0), hit = track(index => index >= 60 && index < 66 ? 0.8 : 0, true);
    const { scopeX, scopeY, scopeWidth, scopeHeight } = createPromoLayout(640, 360);
    for (const time of [0, 1.37, 5.9]) {
      const signals = promoSignalsAt(silence, time, 640, 360);
      expect(signals.bars.every(bar => bar.height === 0 && bar.level === 0)).toBe(true);
      expect(signals.traces.every(trace => trace.every(point => point.y === scopeY))).toBe(true);
    }
    for (const time of [0, 0.99, 1]) {
      const signals = promoSignalsAt(hit, time, 640, 360);
      expect(signals.bars.every(bar => bar.height === 0)).toBe(true);
      expect(signals.traces.every(trace => trace.every(point => point.y === scopeY))).toBe(true);
    }
    const early = promoSignalsAt(hit, 1.001, 640, 360), later = promoSignalsAt(hit, 1.06, 640, 360);
    expect(early.bars[0]!.height).toBeGreaterThan(0);
    expect(later.bars[0]!.height).toBeGreaterThan(early.bars[0]!.height);
    expect(later.traces[0]!.some(point => Math.abs(point.y - scopeY) > 1)).toBe(true);
    for (const trace of later.traces) for (const point of trace) {
      expect(point.x).toBeGreaterThanOrEqual(scopeX);
      expect(point.x).toBeLessThanOrEqual(scopeX + scopeWidth + 1e-8);
      expect(point.y).toBeGreaterThanOrEqual(scopeY - scopeHeight / 2 - 1e-8);
      expect(point.y).toBeLessThanOrEqual(scopeY + scopeHeight / 2 + 1e-8);
    }
  });

  test("does not paint phantom peak caps at the bottom edge during silence", () => {
    const { renderer, background } = composition();
    const pixels = renderer.render(track(() => 0), 2, background);
    const base = pixels[0]!;
    let maximumDifference = 0;
    for (let x = 0; x < 640; x++) {
      maximumDifference = Math.max(maximumDifference, Math.abs(pixels[((360 - 1) * 640 + x) * 4]! - base));
    }
    expect(maximumDifference).toBeLessThanOrEqual(1);
  });

  test("fits enlarged and wrapped credits above the waveform on landscape and portrait frames", () => {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [640, 360]]) {
      for (const text of [
        { title: "Event Horizon", artist: "voho" },
        { title: "A Quiet Journey Beyond the Event Horizon", artist: "The Midnight Orchestra" },
      ]) {
        const config = parseProjectConfig({ output: { width, height },
          visual: { mode: "promo", imagePath: "fixture.png" }, text });
        const renderer = new PromoRenderer(config, { width: width!, height: height! }, artwork());
        const { creditBounds: bounds, layout } = renderer;
        expect(bounds.x).toBeGreaterThan(layout.cover.x + layout.cover.size);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width! * 0.92 + 1e-5);
        expect(bounds.y).toBeGreaterThanOrEqual(layout.text.top);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(layout.text.bottom + 1e-5);
        expect(bounds.y + bounds.height).toBeLessThan(layout.scopeY - layout.scopeHeight / 2);
      }
    }
  });

  test("holds peaks above releasing bars, falls smoothly and reproduces arbitrary seeks", () => {
    const source = track((index, band) => index === 60 && band === 17 ? 0.12 : 0);
    const capAt = (time: number) => promoSignalsAt(source, time, 640, 360).bars[17]!.peakY;
    expect(capAt(1.05)).toBeCloseTo(capAt(1.299), 7);
    expect(capAt(1.4)).toBeGreaterThan(capAt(1.3));
    expect(capAt(2.1)).toBeGreaterThan(capAt(1.4) + 8);
    expect(capAt(2.1)).toBeLessThan(capAt(1.4) + 10);
    const release = promoSignalsAt(source, 2.1, 640, 360).bars[17]!;
    expect(release.peakY).toBeLessThan(release.y);
    expect(Math.abs(capAt(2 + 1e-6) - capAt(2 - 1e-6))).toBeLessThan(0.001);
    const expected = promoSignalsAt(source, 2.317, 640, 360);
    for (const time of [5.9, 0, 1.5, 4, 1]) promoSignalsAt(source, time, 640, 360);
    expect(promoSignalsAt(source, 2.317, 640, 360)).toEqual(expected);
  });

  test("clips bar and cap pixels to the reserved strip and leaves player margins untouched", () => {
    const { renderer, background } = composition();
    const source = track(index => index >= 60 ? 0.8 : 0);
    const silent = Buffer.from(renderer.render(source, 0.5, background));
    const active = renderer.render(source, 1.4, background);
    const boundary = Math.floor(renderer.layout.spectrumTop) * 640 * 4;
    expect(active.subarray(0, boundary)).toEqual(silent.subarray(0, boundary));
    const afterBaseline = Math.ceil(renderer.layout.spectrumBaseline) * 640 * 4;
    expect(active.subarray(afterBaseline)).toEqual(silent.subarray(afterBaseline));
    let changed = 0;
    for (let index = boundary; index < active.length; index += 4) {
      if (Math.abs(active[index]! - silent[index]!) > 10) changed++;
    }
    expect(changed).toBeGreaterThan(640 * 360 * 0.03);
  });

  test("keeps a grayscale cover and completed frame grayscale and stable after seeks", () => {
    const { renderer, background } = composition();
    const source = track((index, band) => index >= 60 ? 0.2 + band / 128 : 0, true);
    const expected = Buffer.from(renderer.render(source, 2.31, background));
    let maxChroma = 0;
    for (let index = 0; index < expected.length; index += 4) {
      maxChroma = Math.max(maxChroma, Math.max(expected[index]!, expected[index + 1]!, expected[index + 2]!)
        - Math.min(expected[index]!, expected[index + 1]!, expected[index + 2]!));
    }
    expect(maxChroma).toBeLessThanOrEqual(1);
    for (const time of [5.9, 0, 3.17]) renderer.render(source, time, background);
    expect(renderer.render(source, 2.31, background)).toEqual(expected);
  });
});
