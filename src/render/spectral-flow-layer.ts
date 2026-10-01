import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { frameAt } from "../audio/analyze.js";
import type { AudioAnalysis } from "../types.js";
import { audioFieldAt } from "./audio-field.js";
import { presenceAt } from "./conductor.js";
import type { SafeLayout } from "./layout.js";
import { deriveMusicMotion } from "./music-motion.js";
import { paletteRgb, rgbCss, type ScenePalette } from "./palette.js";
import { deriveSceneDynamics } from "./scene-dynamics.js";
import { surfaceFeatureSamples } from "./surface-signal.js";
import { FLOW_AGES, spectralFlowPaths, type SpectralFlowSample, type SpectralFlowState } from "./spectral-flow.js";

export function spectralFlowStateAt(analysis: AudioAnalysis, time: number): SpectralFlowState {
  const motion = deriveMusicMotion(analysis, time);
  const dynamics = deriveSceneDynamics(analysis, time);
  const field = audioFieldAt(analysis, time);
  const waveform = surfaceFeatureSamples(frameAt(analysis, time)).subarray(32, 64);
  return { time,
    bass: dynamics.body.energy * (0.30 + 0.70 * motion.bassEnergy),
    mid: dynamics.detail.energy * (0.5 + 0.5 * motion.midEnergy),
    treble: dynamics.spark.energy * (0.5 + 0.5 * motion.trebleEnergy),
    impact: dynamics.impact.energy, slow: dynamics.drift.clock, fast: dynamics.detail.clock,
    energy: motion.sustain, presence: presenceAt(time, analysis.duration), spectrum: field.spectrum, waveform };
}

/** Musical light only: the room, sharp sculpture and typography never enter this history. */
export class SpectralFlowLayer {
  private readonly canvas;
  private readonly context;
  private readonly mask;
  private readonly core;
  private readonly halo;
  private readonly scale: number;
  private readonly offsetX: number;
  private readonly offsetY: number;

  constructor(width: number, height: number, private readonly layout: SafeLayout,
    private readonly palette: ScenePalette, private readonly seed: string, private readonly lowFlash: boolean) {
    // Native-size curve coordinates on a light surface capped at 480 pixels.
    this.scale = Math.min(0.5, 480 / Math.max(width, height));
    // Crop transparent room/credit pixels out of every filter and final blend.
    // Padding retains the softest trail's blur before the protected-area mask.
    const padding = Math.ceil((layout.graphBottom - layout.graphTop) * this.scale * 0.045) + 2;
    this.offsetX = Math.floor(layout.left * this.scale) - padding;
    this.offsetY = Math.floor(layout.graphTop * this.scale) - padding;
    this.canvas = createCanvas(Math.max(1, Math.ceil(layout.right * this.scale) + padding - this.offsetX),
      Math.max(1, Math.ceil(layout.graphBottom * this.scale) + padding - this.offsetY));
    this.context = this.canvas.getContext("2d");
    this.core = createCanvas(this.canvas.width, this.canvas.height);
    this.halo = createCanvas(this.canvas.width, this.canvas.height);
    this.mask = createCanvas(this.canvas.width, this.canvas.height);
    const mask = this.mask.getContext("2d");
    const top = layout.graphTop * this.scale - this.offsetY, bottom = layout.graphBottom * this.scale - this.offsetY;
    const feather = Math.min((bottom - top) * 0.16, 28 * this.scale);
    const gradient = mask.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(feather / (bottom - top), "white");
    gradient.addColorStop(1 - feather / (bottom - top), "white");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    mask.fillStyle = gradient;
    mask.fillRect(layout.left * this.scale - this.offsetX, top, layout.width * this.scale, bottom - top);
  }

  samples(analysis: AudioAnalysis, time: number): SpectralFlowSample[] {
    if (!Number.isFinite(time) || time < 0) return [];
    return FLOW_AGES.filter(age => age <= time).map(age => ({ age, state: spectralFlowStateAt(analysis, time - age) }));
  }

  draw(output: SKRSContext2D, analysis: AudioAnalysis, time: number, intensity = 1): void {
    if (!(intensity > 0)) return;
    const samples = this.samples(analysis, time);
    const paths = spectralFlowPaths(samples, this.seed);
    if (!paths.length) return;
    const context = this.context;
    context.resetTransform(); context.globalAlpha = 1; context.filter = "none";
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const rx = this.layout.width * 0.47, ry = Math.min(this.layout.horizon - this.layout.graphTop,
      this.layout.graphBottom - this.layout.horizon) * 0.93;
    const radius = Math.min(rx, ry), scale = this.scale;
    // Current light stays defined; older traces soften as their field advects.
    // Light has a bounded additive budget, avoiding white screen-blend haze.
    // All six ribbons at one age have the same optical blur. Rasterize them
    // together and blur the two age surfaces once, instead of sixty separate
    // filtered strokes per frame. Scratch storage is fixed and always cleared.
    const core = this.core.getContext("2d"), halo = this.halo.getContext("2d");
    for (const age of FLOW_AGES) {
      const group = paths.filter(path => path.age === age);
      if (!group.length) continue;
      for (const target of [core, halo]) {
        target.clearRect(0, 0, this.canvas.width, this.canvas.height);
        target.lineCap = "round"; target.lineJoin = "round";
      }
      for (const path of group) {
        const color = rgbCss(paletteRgb(this.palette, path.color * 360, 100, 50));
        const alpha = Math.min(1, path.alpha * intensity * (this.lowFlash ? 0.80 : 1));
        for (const target of [core, halo]) {
          target.strokeStyle = color;
          target.beginPath();
          for (let index = 0; index < path.points.length; index++) {
            const point = path.points[index]!;
            const x = (this.layout.centerX + point.x * rx) * scale - this.offsetX;
            const y = (this.layout.horizon + point.y * ry) * scale - this.offsetY;
            if (index === 0) target.moveTo(x, y); else target.lineTo(x, y);
          }
          target.closePath();
        }
        halo.globalAlpha = alpha * 0.28;
        halo.lineWidth = radius * (path.width + 0.014) * scale;
        halo.stroke();
        core.globalAlpha = alpha;
        core.lineWidth = Math.max(0.4, radius * path.width * scale);
        core.stroke();
      }
      context.filter = `blur(${Math.max(0.4, radius * (group[0]!.blur + 0.014) * scale)}px)`;
      context.drawImage(this.halo, 0, 0);
      context.filter = age > 0 ? `blur(${radius * group[0]!.blur * scale}px)` : "none";
      context.drawImage(this.core, 0, 0);
    }
    context.filter = "none"; context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-in";
    context.drawImage(this.mask, 0, 0);
    output.save();
    output.resetTransform();
    // Protection is applied after blur and again after upscaling, so no light
    // enters the title lockup or the separate scope/spectrum readout band.
    output.beginPath(); output.rect(this.layout.left, this.layout.graphTop,
      this.layout.width, this.layout.graphBottom - this.layout.graphTop); output.clip();
    output.globalCompositeOperation = "lighter"; output.globalAlpha = 0.90;
    output.filter = "none";
    output.drawImage(this.canvas, this.offsetX / scale, this.offsetY / scale,
      this.canvas.width / scale, this.canvas.height / scale);
    output.restore();
  }
}
