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
  text: { x: number; width: number; centerY: number; top: number; bottom: number; titleSize: number; artistSize: number };
  scopeX: number;
  scopeY: number;
  scopeWidth: number;
  scopeHeight: number;
  spectrumX: number;
  spectrumWidth: number;
  spectrumTop: number;
  spectrumBaseline: number;
}

/** Golden gallery: a centered cover, separate credits/waveform, and player-safe spectrum. */
export function createPromoLayout(width: number, height: number): PromoLayout {
  const phi = (1 + Math.sqrt(5)) / 2;
  const landscape = width / height >= 1.2;
  const size = Math.min(width * (landscape ? 0.28 : 0.36), height * 0.40);
  const x = width * 0.08;
  // The golden column needs a cover-width fallback on portrait and square frames.
  const textX = Math.max(width / phi ** 2, x + size + width * 0.055);
  const textWidth = width * 0.92 - textX;
  const safeTop = height * 0.06, safeBottom = height * 0.94;
  const safeHeight = safeBottom - safeTop;
  const scopeY = safeTop + safeHeight / phi;
  const scopeHeight = size * 0.68;
  const gap = height * 0.022;
  const titleSize = Math.min(height * 0.105, width * (landscape ? 0.062 : 0.070));
  return {
    cover: { x, y: (height - size) / 2, size },
    text: { x: textX, width: textWidth, centerY: safeTop + safeHeight / phi ** 2,
      top: safeTop, bottom: scopeY - scopeHeight / 2 - gap, titleSize, artistSize: titleSize },
    scopeX: textX, scopeY, scopeWidth: textWidth, scopeHeight,
    spectrumX: x, spectrumWidth: width - x * 2,
    spectrumTop: Math.max(scopeY + scopeHeight / 2 + gap, safeBottom - height * 0.3),
    spectrumBaseline: safeBottom,
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
  const layout = createPromoLayout(width, height);
  const { levels, peaks } = spectrumReadoutAt(analysis, time, "promo");
  const pitch = layout.spectrumWidth / SPECTRUM_STRIP_BANDS;
  const barWidth = pitch * 0.68;
  const maxHeight = layout.spectrumBaseline - layout.spectrumTop;
  const cap = Math.max(0.7, height / 1080 * 2);
  const bars = Array.from(levels, (level, index) => {
    const weight = 1 - index / (SPECTRUM_STRIP_BANDS - 1) * 0.25;
    const barHeight = level * weight * (maxHeight - cap);
    return { x: layout.spectrumX + pitch * index + (pitch - barWidth) / 2, y: layout.spectrumBaseline - barHeight,
      width: barWidth, height: barHeight,
      peakY: Math.max(layout.spectrumTop, layout.spectrumBaseline - peaks[index]! * weight * (maxHeight - cap) - cap),
      peakLevel: peaks[index]!, level };
  });
  const field = audioFieldAt(analysis, time);
  const amplitude = layout.scopeHeight / 2 * Math.min(1, Math.sqrt(Math.max(0, field.fast)) * (0.095 / 0.060));
  const traces = [0, 1, 2].map(age => {
    const waveform = frameAt(analysis, Math.max(0, time - age / analysis.fps)).waveform;
    let peak = 0.035;
    for (const sample of waveform) if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
    return Array.from({ length: 385 }, (_, index) => {
      const p = index / 384;
      return { x: layout.scopeX + p * layout.scopeWidth,
        y: layout.scopeY - smoothSample(waveform, p) / peak * amplitude * Math.sin(p * Math.PI) ** 0.6 };
    });
  });
  return { bars, traces };
}

/** A deliberately independent composition: no sculpture or standard credit strip. */
export class PromoRenderer {
  readonly canvas: Canvas;
  readonly layout: PromoLayout;
  /** Fitted ink bounds also place the MilkDrop background's quiet region. */
  readonly creditBounds: { x: number; y: number; width: number; height: number };
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
    this.creditBounds = this.paintLockup(config, artwork.thumbnail);
  }

  private paintLockup(config: ProjectConfig, thumbnail: Canvas): PromoRenderer["creditBounds"] {
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

    // Actual ink metrics center both lines as a group, not their font em boxes.
    const metrics = (block: TextBlock) => {
      context.font = block.font; context.letterSpacing = `${block.spacing}px`;
      const measured = block.lines.map(line => context.measureText(line));
      const ascent = Math.max(...measured.map(value => value.actualBoundingBoxAscent));
      const descent = Math.max(...measured.map(value => value.actualBoundingBoxDescent));
      return { ascent, height: ascent + descent + (block.lines.length - 1) * block.lineHeight,
        width: Math.max(...measured.map(value => value.width)) };
    };
    let fontSize = text.titleSize;
    let title: TextBlock, artist: TextBlock, gap: number;
    for (;;) {
      title = textBlock(context, config.text.title, text.width, fontSize, "Promo Serif", 600, 0);
      artist = textBlock(context, config.text.artist, text.width, fontSize, "Promo Sans", 500, 0.09);
      const commonSize = Math.min(title.size, artist.size);
      if (commonSize < fontSize) { fontSize = commonSize; continue; }
      gap = Math.min(this.canvas.height * 0.033, fontSize * 0.38);
      if (metrics(title).height + gap + metrics(artist).height <= text.bottom - text.top || fontSize <= 1) break;
      fontSize *= 0.94;
    }
    const titleMetrics = metrics(title), artistMetrics = metrics(artist);
    const creditHeight = titleMetrics.height + gap + artistMetrics.height;
    // A larger byline or wrapped title can extend past the golden anchor. Lift
    // that group just enough to preserve the waveform's full dynamic range.
    const top = Math.max(text.top, Math.min(text.centerY - creditHeight / 2, text.bottom - creditHeight));
    const draw = (block: TextBlock, baseline: number, color: string) => {
      context.font = block.font; context.letterSpacing = `${block.spacing}px`;
      context.textAlign = "left"; context.textBaseline = "alphabetic";
      context.fillStyle = color; context.shadowColor = "rgba(0,0,0,0.95)";
      context.shadowBlur = 24 * scale; context.shadowOffsetY = 4 * scale;
      block.lines.forEach((line, index) => context.fillText(line, text.x, baseline + index * block.lineHeight));
    };
    draw(title, top + titleMetrics.ascent, "#fafafa");
    draw(artist, top + titleMetrics.height + gap + artistMetrics.ascent, "#e8e8e8");
    return { x: text.x, y: top, width: Math.max(titleMetrics.width, artistMetrics.width), height: creditHeight };
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
    const { spectrumX, spectrumWidth, spectrumTop, spectrumBaseline } = this.layout;
    context.save();
    context.beginPath(); context.rect(spectrumX, spectrumTop, spectrumWidth, spectrumBaseline - spectrumTop); context.clip();
    for (let index = 0; index < signals.bars.length; index++) {
      const bar = signals.bars[index]!;
      const color = liftSwatch(paletteRgb(this.palette, index / signals.bars.length * 270), 0.38, 0.03);
      if (bar.height > 0) {
        const gradient = context.createLinearGradient(0, spectrumBaseline, 0, bar.y);
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
