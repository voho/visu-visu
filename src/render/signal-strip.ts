import type { SKRSContext2D } from "@napi-rs/canvas";
import { frameAt } from "../audio/analyze.js";
import { clamp, lerp, smoothstep } from "../math/random.js";
import type { AudioAnalysis } from "../types.js";
import { AUDIO_FIELD_BANDS, audioFieldAt } from "./audio-field.js";
import { smoothSample } from "./audio-field-geometry.js";
import { signalBand, type SafeLayout } from "./layout.js";
import type { Rgb } from "./lighting.js";
import { liftSwatch, paletteRgb, rgbCss, type ScenePalette } from "./palette.js";
import { surfaceFeatureSamples } from "./surface-signal.js";

/** Track-relative ceiling per band: a hat that never exceeds 0.1 still fills its bar. */
const bandCeilings = new WeakMap<AudioAnalysis, Float64Array>();
/**
 * Near the band's own maximum rather than its p90: at this song's drop 21 of
 * 32 bars clipped against p90 and the strip read as a flat wall.
 */
const CEILING_PERCENTILE = 0.98;
/** Below this the band is silence in any master; dividing by less would amplify noise. */
const CEILING_FLOOR = 0.12;
/** A frame's waveform is shown at unit shape; quieter blocks than this stay small. */
const WAVEFORM_FLOOR = 0.05;
/** Points along the floor oscilloscope. */
const SCOPE_POINTS = 257;

export interface StripBar {
  band: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScopeTrace {
  points: Array<{ x: number; y: number }>;
  alpha: number;
  lineWidth: number;
}
export interface SignalBandFrame {
  bars: StripBar[];
  /** The per-band levels behind the bars, on the track's own scale; the embers pulse with them. */
  levels: Float32Array;
  barAlpha: number;
  /** Newest trace first; the older ones are the phosphor persistence. */
  traces: ScopeTrace[];
  /** Extra white in the trace from the raw treble pulse. */
  scopeGlow: number;
  /** Output scale relative to 1080p, for stroke widths and corner radii. */
  scale: number;
}
export interface SignalTint { phase: number; direction: 1 | -1 }
export interface SignalStripStyle {
  palette: ScenePalette;
  /** Palette-relative accent phases (what paletteRgb expects). */
  warm: SignalTint;
  cool: SignalTint;
}
export interface SignalDrive {
  /** Raw bass pulse: lifts the lowest bars within one frame. */
  kick: number;
  /** Surrounding loudness (deriveSectionLevel): keeps the breakdown calmer. */
  section: number;
  /** Raw treble pulse: brightens the trace. */
  treblePulse: number;
}

const unit = (value: number): number => Number.isFinite(value) ? clamp(value) : 0;

function ceilingsFor(analysis: AudioAnalysis): Float64Array {
  const cached = bandCeilings.get(analysis);
  if (cached) return cached;
  const ceilings = new Float64Array(AUDIO_FIELD_BANDS).fill(CEILING_FLOOR);
  const count = analysis.frames.length;
  if (count > 0) {
    const column = new Float64Array(count);
    for (let band = 0; band < AUDIO_FIELD_BANDS; band++) {
      for (let index = 0; index < count; index++) column[index] = unit(surfaceFeatureSamples(analysis.frames[index]!)[band]!);
      column.sort();
      ceilings[band] = Math.max(CEILING_FLOOR, column[Math.min(count - 1, Math.floor(count * CEILING_PERCENTILE))]!);
    }
  }
  bandCeilings.set(analysis, ceilings);
  return ceilings;
}

/**
 * Band levels on the track's own scale: each causal envelope divided by that
 * band's own ceiling over the whole song, so quiet hats and loud kicks both
 * reach the top of their bars. The kick reaches the bottom bars a frame
 * before the FFT envelope does.
 */
export function normalizedBandsAt(analysis: AudioAnalysis, time: number, kick = 0): Float32Array {
  const ceilings = ceilingsFor(analysis);
  const { spectrum } = audioFieldAt(analysis, time);
  const levels = new Float32Array(AUDIO_FIELD_BANDS);
  for (let band = 0; band < AUDIO_FIELD_BANDS; band++) {
    const level = unit(spectrum[band]! / ceilings[band]!) ** 0.8;
    levels[band] = unit(level + (band < 5 ? unit(kick) * 0.2 : 0));
  }
  return levels;
}

/** 32 rounded bars growing up from the band's baseline, warm bass on the left. */
export function spectrumStripGeometry(layout: SafeLayout, height: number, levels: ArrayLike<number>, sectionGain: number): StripBar[] {
  const band = signalBand(layout, height);
  const pitch = layout.width / AUDIO_FIELD_BANDS;
  const width = pitch * 0.62;
  const gain = Number.isFinite(sectionGain) ? clamp(sectionGain, 0.1, 1) : 1;
  return Array.from({ length: AUDIO_FIELD_BANDS }, (_, index) => {
    const level = unit(levels[index] ?? 0);
    const barHeight = height * (0.008 + 0.074 * level) * gain;
    return { band: index, x: layout.left + pitch * index + (pitch - width) / 2,
      y: band.barBaseline - barHeight, width, height: barHeight };
  });
}

/**
 * The signed waveform laid along the floor, tapered to rest at both ends.
 * The block is shown at its own shape and `amplitude` (px) sets the swing,
 * so the trace follows the loudness envelope once rather than squared: raw
 * samples of a quiet breakdown are a hundredth of the drop's and would
 * flatten the line for a minute at a time.
 */
export function oscilloscopePath(layout: SafeLayout, height: number, waveform: ArrayLike<number>, amplitude: number): Array<{ x: number; y: number }> {
  const band = signalBand(layout, height);
  let peak = WAVEFORM_FLOOR;
  for (let index = 0; index < waveform.length; index++) {
    const sample = Math.abs(waveform[index]!);
    if (Number.isFinite(sample)) peak = Math.max(peak, Math.min(1, sample));
  }
  const swing = (Number.isFinite(amplitude) ? Math.max(0, amplitude) : 0) / peak;
  return Array.from({ length: SCOPE_POINTS }, (_, index) => {
    const position = index / (SCOPE_POINTS - 1);
    const taper = Math.sin(position * Math.PI) ** 1.2;
    return { x: lerp(layout.left, layout.right, position),
      y: band.scopeY - smoothSample(waveform, position) * swing * taper };
  });
}

/**
 * Everything the band needs for one frame, as a pure function of absolute
 * time: the trailing traces are re-read from the analysis instead of kept
 * from the previously rendered frame, so seeking never changes them.
 */
export function signalBandAt(analysis: AudioAnalysis, time: number, layout: SafeLayout, height: number, drive: SignalDrive): SignalBandFrame {
  const scale = height / 1080;
  const sectionGain = 0.6 + 0.4 * unit(drive.section);
  const field = audioFieldAt(analysis, time);
  const levels = normalizedBandsAt(analysis, time, drive.kick);
  const bars = spectrumStripGeometry(layout, height, levels, sectionGain);
  const amplitude = (2.5 + field.fast * 20) * scale * sectionGain;
  const lineWidth = (2.4 + field.fast * 1.2) * scale;
  const alpha = 0.55 + field.fast * 0.45;
  const fps = Number.isFinite(analysis.fps) && analysis.fps > 0 ? analysis.fps : 30;
  const traces = [1, 0.45, 0.2].map((fade, age): ScopeTrace => ({
    points: oscilloscopePath(layout, height, frameAt(analysis, Math.max(0, time - age / fps)).waveform, amplitude),
    alpha: alpha * fade,
    lineWidth: age === 0 ? lineWidth : lineWidth * 0.8,
  }));
  return { bars, levels, barAlpha: 0.55 + field.slow * 0.35, traces, scopeGlow: unit(drive.treblePulse) * 0.2, scale };
}

/**
 * Bar pigment: bass bars in the warm family, treble bars in the cool one,
 * each spread a little way along its own side of the ring. The families
 * cross over the few middle bars only, since a straight walk around the
 * ring (or an RGB mix) passes through grey between two pigments.
 */
function barColor(style: SignalStripStyle, band: number, floor: number, extra: number): Rgb {
  const position = band / (AUDIO_FIELD_BANDS - 1);
  const warm = liftSwatch(paletteRgb(style.palette, style.warm.phase + style.warm.direction * 36 * position), floor, extra);
  const cool = liftSwatch(paletteRgb(style.palette, style.cool.phase + style.cool.direction * 36 * (1 - position)), floor, extra);
  const mix = smoothstep(0.42, 0.58, position);
  return [lerp(warm[0], cool[0], mix), lerp(warm[1], cool[1], mix), lerp(warm[2], cool[2], mix)];
}

/**
 * Paints the band on the main canvas (source-over pigment) or its copy into
 * the emission field (flat, wider strokes for the bloom to spread). Nothing
 * here touches the graph region above the band; the caller keeps the graph
 * camera off this layer.
 */
export function drawSignalBand(context: SKRSContext2D, frame: SignalBandFrame, style: SignalStripStyle, emission: boolean): void {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.lineCap = "round";
  context.lineJoin = "round";
  const radius = 4 * frame.scale;
  for (const bar of frame.bars) {
    if (emission) {
      context.fillStyle = rgbCss(barColor(style, bar.band, 0.40, 0.08), 0.6);
    } else {
      const gradient = context.createLinearGradient(0, bar.y + bar.height, 0, bar.y);
      gradient.addColorStop(0, rgbCss(barColor(style, bar.band, 0.40, 0), frame.barAlpha));
      gradient.addColorStop(1, rgbCss(barColor(style, bar.band, 0.40, 0.12), frame.barAlpha));
      context.fillStyle = gradient;
    }
    context.beginPath();
    context.roundRect(bar.x, bar.y, bar.width, bar.height, radius);
    context.fill();
  }
  const traces = emission ? frame.traces.slice(0, 1) : frame.traces;
  const scopeColor = liftSwatch(paletteRgb(style.palette, style.cool.phase), 0.52, frame.scopeGlow);
  // Older traces first so the live trace stays on top of its own afterglow.
  for (let index = traces.length - 1; index >= 0; index--) {
    const trace = traces[index]!;
    context.lineWidth = emission ? trace.lineWidth * 4 : trace.lineWidth;
    context.strokeStyle = rgbCss(scopeColor, emission ? 0.35 : trace.alpha);
    context.beginPath();
    trace.points.forEach((point, at) => at === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
    context.stroke();
  }
  context.restore();
}
