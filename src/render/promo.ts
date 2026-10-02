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
  group: { x: number; y: number; width: number; height: number };
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

const PHI = (1 + Math.sqrt(5)) / 2;
const ARTIST_FONT_RATIO = 1 / PHI;

/** Airy golden columns, centered as a group after the credits' ink is measured. */
export function createPromoLayout(width: number, height: number,
  credits?: { height: number; fontSize: number }): PromoLayout {
  const landscape = width / height >= 1.2;
  const columnRatio = (1 + 1 / PHI ** 2) * (1 + PHI);
  const size = Math.min(height * 0.40, width * 0.84 / columnRatio);
  const coverGap = size / PHI ** 2;
  const textWidth = (size + coverGap) * PHI;
  const groupWidth = size + coverGap + textWidth;
  const x = (width - groupWidth) / 2;
  const textX = x + size + coverGap;
  const fontSize = credits?.fontSize ?? Math.min(height * 0.105, width * (landscape ? 0.062 : 0.070));
  const artistSize = fontSize * ARTIST_FONT_RATIO;
  const creditHeight = credits?.height ?? (fontSize + artistSize) * 0.9 + fontSize / PHI ** 2;
  const scopeGap = fontSize / PHI ** 4;
  const scopeHeight = size * 0.68;
  const groupHeight = Math.max(size, creditHeight + scopeGap + scopeHeight);
  const top = (height - groupHeight) / 2;
  const scopeY = top + creditHeight + scopeGap + scopeHeight / 2;
  const spectrumBaseline = height * 0.94;
  return {
    group: { x, y: top, width: groupWidth, height: groupHeight },
    cover: { x, y: top, size },
    text: { x: textX, width: textWidth, centerY: top + creditHeight / 2,
      top, bottom: top + creditHeight, titleSize: fontSize, artistSize },
    scopeX: textX, scopeY, scopeWidth: textWidth, scopeHeight,
    spectrumX: width * 0.08, spectrumWidth: width * 0.84,
    spectrumTop: Math.max(top + groupHeight + scopeGap, spectrumBaseline - height * 0.3),
    spectrumBaseline,
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

interface TextLine { value: string; left: number; right: number; ascent: number; descent: number }
interface TextBlock {
  lines: TextLine[]; size: number; lineHeight: number; font: string; spacing: number;
  top: number; height: number; width: number;
}

function textBlock(context: SKRSContext2D, text: string, width: number, size: number,
  family: string, weight: number, spacing: number): TextBlock {
  const words = text.normalize("NFC").replace(/\s+/g, " ").trim().split(" ");
  context.textAlign = "left"; context.textBaseline = "alphabetic";
  for (;;) {
    context.font = `${weight} ${size}px "${family}"`;
    context.letterSpacing = `${size * spacing}px`;
    const measure = (value: string): TextLine => {
      const ink = context.measureText(value);
      // The pinned Canvas runtime includes tracking in its reported left
      // bearing even though fillText does not paint it before the first glyph.
      return { value, left: ink.actualBoundingBoxLeft - size * spacing, right: ink.actualBoundingBoxRight,
        ascent: ink.actualBoundingBoxAscent, descent: ink.actualBoundingBoxDescent };
    };
    const lines: TextLine[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      const ink = measure(next);
      if (line && ink.left + ink.right > width) { lines.push(measure(line)); line = word; }
      else line = next;
    }
    if (line) lines.push(measure(line));
    const inkWidth = Math.max(...lines.map(ink => ink.left + ink.right));
    if ((lines.length <= 2 && inkWidth <= width) || size <= 1) {
      const lineHeight = Math.max(size * 1.08, ...lines.map(ink => (ink.ascent + ink.descent) * 1.08));
      const top = Math.min(...lines.map((ink, index) => index * lineHeight - ink.ascent));
      const bottom = Math.max(...lines.map((ink, index) => index * lineHeight + ink.descent));
      return { lines, size, lineHeight, font: context.font, spacing: size * spacing,
        top, height: bottom - top, width: inkWidth };
    }
    size *= 0.94;
  }
}

function fitCredits(context: SKRSContext2D, text: ProjectConfig["text"], width: number, height: number) {
  const initial = createPromoLayout(width, height);
  let fontSize = initial.text.titleSize;
  for (;;) {
    const title = textBlock(context, text.title, initial.text.width, fontSize, "Promo Serif", 600, 0);
    const artistSize = fontSize * ARTIST_FONT_RATIO;
    const artist = textBlock(context, text.artist, initial.text.width, artistSize, "Promo Sans", 500, 0.09);
    const fitScale = Math.min(title.size / fontSize, artist.size / artistSize);
    if (fitScale < 1) { fontSize *= fitScale; continue; }
    const gap = fontSize / PHI ** 2;
    const layout = createPromoLayout(width, height, { height: title.height + gap + artist.height, fontSize });
    // Reserve at least 12% for the analyzer beneath the centered group. Wrapped
    // credits shrink together; the cover and the scope retain their sizes.
    if ((layout.spectrumBaseline - layout.spectrumTop >= height * 0.12
      && layout.group.y >= height * 0.06) || fontSize <= 1) return { title, artist, gap, layout };
    fontSize *= 0.94;
  }
}

export interface PromoSignalFrame {
  bars: Array<{ x: number; y: number; width: number; height: number; peakY: number; peakLevel: number; level: number }>;
  /** Left then right; both share the single maximum peak row in bars. */
  spectra: [PromoSignalFrame["bars"], PromoSignalFrame["bars"]];
  traces: Array<Array<{ x: number; y: number }>>;
}

/** Seek-independent envelopes retain the analyser's smooth attacks and falling peaks. */
export function promoSignalsAt(analysis: AudioAnalysis, time: number, width: number, height: number,
  layout = createPromoLayout(width, height)): PromoSignalFrame {
  const left = spectrumReadoutAt(analysis, time, "promo", "left");
  const right = spectrumReadoutAt(analysis, time, "promo", "right");
  const levels = Float32Array.from(left.levels, (value, band) => Math.max(value, right.levels[band]!));
  const peaks = Float32Array.from(left.peaks, (value, band) => Math.max(value, right.peaks[band]!));
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
  const spectra = [left, right].map((channel, side) => bars.map((bar, index) => {
    const weight = 1 - index / (SPECTRUM_STRIP_BANDS - 1) * 0.25;
    const height = channel.levels[index]! * weight * (maxHeight - cap);
    return { ...bar, x: bar.x + (side ? 1 : -1) * pitch * 0.10,
      y: layout.spectrumBaseline - height, height, level: channel.levels[index]! };
  })) as PromoSignalFrame["spectra"];
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
  return { bars, spectra, traces };
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
    this.palette = artwork.palette;
    this.scopePhase = accentSwatches(this.palette).cool / this.palette.colors.length * 360;
    this.lockup = createCanvas(size.width, size.height);
    const credits = fitCredits(this.lockup.getContext("2d"), config.text, size.width, size.height);
    this.layout = credits.layout;
    this.creditBounds = this.paintLockup(credits, artwork.thumbnail);
  }

  private paintLockup(credits: ReturnType<typeof fitCredits>, thumbnail: Canvas): PromoRenderer["creditBounds"] {
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

    const { title, artist, gap } = credits;
    const draw = (block: TextBlock, top: number, color: string) => {
      context.font = block.font; context.letterSpacing = `${block.spacing}px`;
      context.textAlign = "left"; context.textBaseline = "alphabetic";
      context.fillStyle = color; context.shadowColor = "rgba(0,0,0,0.95)";
      context.shadowBlur = 24 * scale; context.shadowOffsetY = 4 * scale;
      // Center each line's visible ink on the scope axis, including its bearing;
      // baseline offsets align the visible title top with the cover top.
      block.lines.forEach((line, index) => context.fillText(line.value,
        text.x + (text.width - line.left - line.right) / 2 + line.left,
        top - block.top + index * block.lineHeight));
    };
    draw(title, text.top, "#fafafa");
    draw(artist, text.top + title.height + gap, "#e8e8e8");
    const width = Math.max(title.width, artist.width);
    return { x: text.x + (text.width - width) / 2, y: text.top, width, height: text.bottom - text.top };
  }

  render(analysis: AudioAnalysis, time: number, background: Canvas): Buffer {
    const context = this.context, { width, height } = this.canvas;
    context.clearRect(0, 0, width, height);
    context.drawImage(background, 0, 0, width, height);
    // Darken only the animated room; the cover retains its original exposure.
    context.fillStyle = "rgba(0,0,0,0.28)";
    context.fillRect(0, 0, width, height);
    const signals = promoSignalsAt(analysis, time, width, height, this.layout);
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
    for (let side = 0; side < signals.spectra.length; side++) {
      context.save(); context.globalAlpha = 0.5;
      const bars = signals.spectra[side]!;
      for (let index = 0; index < bars.length; index++) {
        const bar = bars[index]!;
        const color = liftSwatch(paletteRgb(this.palette, index / bars.length * 270 + side * 180), 0.38, 0.03);
        if (bar.height > 0) {
          const gradient = context.createLinearGradient(0, spectrumBaseline, 0, bar.y);
          gradient.addColorStop(0, rgbCss(color, 0.12));
          gradient.addColorStop(0.60, rgbCss(color, 0.48));
          gradient.addColorStop(1, rgbCss(color, 0.88));
          context.fillStyle = gradient;
          context.beginPath(); context.roundRect(bar.x, bar.y, bar.width, bar.height + 4 * scale, 3 * scale); context.fill();
        }
      }
      context.restore();
    }
    // One cap per band: the higher held peak from either channel.
    for (let index = 0; index < signals.bars.length; index++) {
      const bar = signals.bars[index]!;
      const color = liftSwatch(paletteRgb(this.palette, index / signals.bars.length * 270), 0.38, 0.03);
      const visibility = clamp(bar.peakLevel / 0.04);
      context.fillStyle = rgbCss(liftSwatch(color, 0.48, 0.1), visibility * 0.80);
      context.fillRect(bar.x, bar.peakY, bar.width, Math.max(0.7, 2 * scale));
    }
    context.restore();
  }
}
