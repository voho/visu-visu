import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { resolve } from "node:path";
import { frameAt } from "../audio/analyze.js";
import { clamp } from "../math/random.js";
import type { AudioAnalysis, ProjectConfig } from "../types.js";
import type { PreparedArtwork } from "./artwork.js";
import { audioFieldAt } from "./audio-field.js";
import { smoothSample } from "./audio-field-geometry.js";
import { accentSwatches, liftSwatch, paletteRgb, rgbCss, type ScenePalette } from "./palette.js";
import { spectrumReadoutAt, SPECTRUM_STRIP_BANDS } from "./spectrum-readout.js";

export interface PromoLayout {
  cover: { x: number; y: number; size: number };
  text: { x: number; width: number; centerY: number; titleSize: number; artistSize: number };
  scopeY: number;
  spectrumTop: number;
  spectrumBaseline: number;
}

/** The record is the hero; the bottom 30% belongs exclusively to the spectrum. */
export function createPromoLayout(width: number, height: number): PromoLayout {
  const landscape = width / height >= 1.2;
  const size = Math.min(width * (landscape ? 0.28 : 0.36), height * 0.40);
  const x = width * 0.08;
  const textX = x + size + width * 0.055;
  return {
    cover: { x, y: (height - size) / 2, size },
    text: { x: textX, width: width * 0.92 - textX, centerY: height * 0.5,
      titleSize: Math.min(height * 0.105, width * (landscape ? 0.062 : 0.070)),
      artistSize: Math.min(height * 0.046, width * (landscape ? 0.030 : 0.045)) },
    scopeY: height * 0.5, spectrumTop: height * 0.7, spectrumBaseline: height,
  };
}

let fontsReady = false;
function registerFonts(): void {
  if (fontsReady) return;
  for (const [file, family] of [["CormorantGaramond.ttf", "Promo Serif"], ["Manrope.ttf", "Promo Sans"]]) {
    if (!GlobalFonts.registerFromPath(resolve(import.meta.dir, "../../assets/fonts", file!), family!)) {
      throw new Error(`Could not load bundled promo font: ${file}`);
    }
  }
  fontsReady = true;
}

interface TextBlock { lines: string[]; size: number; lineHeight: number; font: string; spacing: number }
function textBlock(context: SKRSContext2D, text: string, width: number, size: number, family: string, weight: number, spacing: number): TextBlock {
  const clean = text.normalize("NFC").replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  for (;;) {
    context.font = `${weight} ${size}px "${family}"`;
    context.letterSpacing = `${size * spacing}px`;
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > width) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
    if ((lines.length <= 2 && lines.every(value => context.measureText(value).width <= width)) || size <= 1) {
      return { lines, size, lineHeight: size * 1.02, font: context.font, spacing: size * spacing };
    }
    size *= 0.94;
  }
}

export interface PromoSignalFrame {
  bars: Array<{ x: number; y: number; width: number; height: number; peakY: number; peakLevel: number; level: number }>;
  traces: Array<Array<{ x: number; y: number }>>;
}

/** Seek-independent envelopes retain the analyser's smooth attacks and falling peaks. */
export function promoSignalsAt(analysis: AudioAnalysis, time: number, width: number, height: number): PromoSignalFrame {
  const { levels, peaks } = spectrumReadoutAt(analysis, time);
  const pitch = width / SPECTRUM_STRIP_BANDS;
  const barWidth = pitch * 0.68;
  const maxHeight = height * 0.3;
  const cap = Math.max(0.7, height / 1080 * 2);
  const bars = Array.from(levels, (level, index) => {
    const weight = 1 - index / (SPECTRUM_STRIP_BANDS - 1) * 0.25;
    const barHeight = level * weight * (maxHeight - cap);
    return { x: pitch * index + (pitch - barWidth) / 2, y: height - barHeight,
      width: barWidth, height: barHeight, peakY: Math.max(height * 0.7, height - peaks[index]! * weight * (maxHeight - cap) - cap),
      peakLevel: peaks[index]!, level };
  });
  const field = audioFieldAt(analysis, time);
  const amplitude = height * Math.min(0.060, Math.sqrt(Math.max(0, field.fast)) * 0.095);
  const traces = [0, 1, 2].map(age => {
    const waveform = frameAt(analysis, Math.max(0, time - age / analysis.fps)).waveform;
    let peak = 0.035;
    for (const sample of waveform) if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
    return Array.from({ length: 385 }, (_, index) => {
      const p = index / 384;
      return { x: p * width, y: height * 0.5 - smoothSample(waveform, p) / peak * amplitude * Math.sin(p * Math.PI) ** 0.6 };
    });
  });
  return { bars, traces };
}

/** A deliberately independent composition: no sculpture or standard credit strip. */
export class PromoRenderer {
  readonly canvas: Canvas;
  readonly layout: PromoLayout;
  private readonly context: SKRSContext2D;
  private readonly lockup: Canvas;
  private readonly palette: ScenePalette;
  private readonly scopePhase: number;

  constructor(config: ProjectConfig, size: { width: number; height: number }, artwork: PreparedArtwork) {
    if (!artwork.thumbnail || !config.text.title.trim() || !config.text.artist.trim()) {
      throw new Error("Promo mode requires cover image, song title and artist.");
    }
    registerFonts();
    this.canvas = createCanvas(size.width, size.height);
    this.context = this.canvas.getContext("2d");
    this.layout = createPromoLayout(size.width, size.height);
    this.palette = artwork.palette;
    this.scopePhase = accentSwatches(this.palette).cool / this.palette.colors.length * 360;
    this.lockup = createCanvas(size.width, size.height);
    this.paintLockup(config, artwork.thumbnail);
  }

  private paintLockup(config: ProjectConfig, thumbnail: Canvas): void {
    const context = this.lockup.getContext("2d"), { cover, text } = this.layout;
    const scale = Math.min(this.canvas.width, this.canvas.height) / 1080;
    const radius = cover.size * 0.022;
    context.save();
    context.shadowColor = "rgba(0,0,0,0.85)";
    context.shadowBlur = 55 * scale;
    context.shadowOffsetY = 18 * scale;
    context.fillStyle = "#080808";
    context.beginPath(); context.roundRect(cover.x, cover.y, cover.size, cover.size, radius); context.fill();
    context.restore();
    context.save();
    context.beginPath(); context.roundRect(cover.x, cover.y, cover.size, cover.size, radius); context.clip();
    context.drawImage(thumbnail, cover.x, cover.y, cover.size, cover.size);
    context.restore();
    context.strokeStyle = "rgba(255,255,255,0.15)";
    context.lineWidth = Math.max(0.5, scale);
    context.beginPath(); context.roundRect(cover.x, cover.y, cover.size, cover.size, radius); context.stroke();

    const title = textBlock(context, config.text.title, text.width, text.titleSize, "Promo Serif", 600, 0);
    const artist = textBlock(context, config.text.artist, text.width, text.artistSize, "Promo Sans", 500, 0.09);
    const gap = Math.min(this.canvas.height * 0.033, text.titleSize * 0.38);
    // Actual ink metrics center both lines as a group, not their font em boxes.
    const metrics = (block: TextBlock) => {
      context.font = block.font; context.letterSpacing = `${block.spacing}px`;
      const measured = block.lines.map(line => context.measureText(line));
      const ascent = Math.max(...measured.map(value => value.actualBoundingBoxAscent));
      const descent = Math.max(...measured.map(value => value.actualBoundingBoxDescent));
      return { ascent, height: ascent + descent + (block.lines.length - 1) * block.lineHeight };
    };
    const titleMetrics = metrics(title), artistMetrics = metrics(artist);
    const top = text.centerY - (titleMetrics.height + gap + artistMetrics.height) / 2;
    const draw = (block: TextBlock, baseline: number, color: string) => {
      context.font = block.font; context.letterSpacing = `${block.spacing}px`;
      context.textAlign = "left"; context.textBaseline = "alphabetic";
      context.fillStyle = color; context.shadowColor = "rgba(0,0,0,0.95)";
      context.shadowBlur = 24 * scale; context.shadowOffsetY = 4 * scale;
      block.lines.forEach((line, index) => context.fillText(line, text.x, baseline + index * block.lineHeight));
    };
    draw(title, top + titleMetrics.ascent, "#fafafa");
    draw(artist, top + titleMetrics.height + gap + artistMetrics.ascent, "#e8e8e8");
  }

  render(analysis: AudioAnalysis, time: number, background: Canvas): Buffer {
    const context = this.context, { width, height } = this.canvas;
    context.clearRect(0, 0, width, height);
    context.drawImage(background, 0, 0, width, height);
    // Darken only the animated room; the cover retains its original exposure.
    context.fillStyle = "rgba(0,0,0,0.28)";
    context.fillRect(0, 0, width, height);
    const signals = promoSignalsAt(analysis, time, width, height);
    this.drawScope(signals);
    this.drawSpectrum(signals);
    context.drawImage(this.lockup, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  }

  private drawScope(signals: PromoSignalFrame): void {
    const context = this.context, scale = this.canvas.height / 1080;
    const color = liftSwatch(paletteRgb(this.palette, this.scopePhase), 0.48, 0.08);
    context.save();
    context.lineCap = "round"; context.lineJoin = "round";
    for (let age = signals.traces.length - 1; age >= 0; age--) {
      context.lineWidth = (age ? 1.6 : 2.6) * scale;
      context.strokeStyle = rgbCss(color, age ? 0.14 / age : 0.40);
      context.shadowColor = rgbCss(color, 0.45);
      context.shadowBlur = age ? 0 : 12 * scale;
      context.beginPath();
      signals.traces[age]!.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.stroke();
    }
    context.restore();
  }

  private drawSpectrum(signals: PromoSignalFrame): void {
    const context = this.context, height = this.canvas.height, scale = height / 1080;
    context.save();
    context.beginPath(); context.rect(0, this.layout.spectrumTop, this.canvas.width, height * 0.3); context.clip();
    for (let index = 0; index < signals.bars.length; index++) {
      const bar = signals.bars[index]!;
      const color = liftSwatch(paletteRgb(this.palette, index / signals.bars.length * 270), 0.38, 0.03);
      if (bar.height > 0) {
        const gradient = context.createLinearGradient(0, height, 0, bar.y);
        gradient.addColorStop(0, rgbCss(color, 0.12));
        gradient.addColorStop(0.60, rgbCss(color, 0.48));
        gradient.addColorStop(1, rgbCss(color, 0.88));
        context.fillStyle = gradient;
        context.beginPath(); context.roundRect(bar.x, bar.y, bar.width, bar.height + 4 * scale, 3 * scale); context.fill();
      }
      const visibility = clamp(bar.peakLevel / 0.04);
      context.fillStyle = rgbCss(liftSwatch(color, 0.48, 0.1), visibility * 0.80);
      context.fillRect(bar.x, bar.peakY, bar.width, Math.max(0.7, 2 * scale));
    }
    context.restore();
  }
}
