import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { frameAt } from "../audio/analyze.js";
import {
  clamp,
  createRandom,
  deriveSeed,
  lerp,
  randomBetween,
  smoothstep,
} from "../math/random.js";
import type { AnalysisFrame, AudioAnalysis, ProjectConfig } from "../types.js";

interface BokehParticle {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  phase: number;
  speed: number;
  sway: number;
  depth: number;
  spectrumIndex: number;
}

interface FogField {
  x: number;
  y: number;
  radius: number;
  phase: number;
  speed: number;
  opacity: number;
}

function rgba(level: number, alpha = 1): string {
  const channel = Math.round(clamp(level, 0, 255));
  return `rgba(${channel}, ${channel}, ${channel}, ${clamp(alpha)})`;
}

function wrap(value: number): number {
  return ((value % 1) + 1) % 1;
}

function drawSpacedText(
  context: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
): void {
  let cursor = x;
  for (const character of text) {
    context.fillText(character, cursor, y);
    cursor += context.measureText(character).width + spacing;
  }
}

export class VisualizerRenderer {
  readonly canvas: Canvas;
  private readonly context: SKRSContext2D;
  private readonly backgroundCanvas: Canvas;
  private readonly backgroundContext: SKRSContext2D;
  private readonly grainCanvases: Canvas[];
  private readonly particles: BokehParticle[];
  private readonly fogFields: FogField[];
  private readonly width: number;
  private readonly height: number;
  private readonly backgroundWidth: number;
  private readonly backgroundHeight: number;
  private readonly config: ProjectConfig;
  private readonly seed: string;

  constructor(config: ProjectConfig, seed: string) {
    this.config = config;
    this.seed = seed;
    this.width = config.output.width;
    this.height = config.output.height;
    this.backgroundWidth = Math.max(160, Math.round(this.width / 4));
    this.backgroundHeight = Math.max(100, Math.round(this.height / 4));
    this.canvas = createCanvas(this.width, this.height);
    this.context = this.canvas.getContext("2d");
    this.backgroundCanvas = createCanvas(this.backgroundWidth, this.backgroundHeight);
    this.backgroundContext = this.backgroundCanvas.getContext("2d");
    this.particles = this.createParticles();
    this.fogFields = this.createFogFields();
    this.grainCanvases = this.createGrainCanvases();
  }

  private createParticles(): BokehParticle[] {
    const random = createRandom(deriveSeed(this.seed, "bokeh"));
    return Array.from({ length: this.config.visual.bokehCount }, (_, index) => ({
      x: random(),
      y: randomBetween(random, -0.1, 1.1),
      radius: randomBetween(random, 0.018, 0.11),
      opacity: randomBetween(random, 0.025, 0.16),
      phase: randomBetween(random, 0, Math.PI * 2),
      speed: randomBetween(random, 0.002, 0.014),
      sway: randomBetween(random, 0.008, 0.05),
      depth: randomBetween(random, 0.35, 1),
      spectrumIndex: index % this.config.visual.spectrumBands,
    }));
  }

  private createFogFields(): FogField[] {
    const random = createRandom(deriveSeed(this.seed, "fog"));
    return Array.from({ length: 9 }, () => ({
      x: randomBetween(random, -0.1, 1.1),
      y: randomBetween(random, -0.15, 1.15),
      radius: randomBetween(random, 0.18, 0.52),
      phase: randomBetween(random, 0, Math.PI * 2),
      speed: randomBetween(random, 0.006, 0.022),
      opacity: randomBetween(random, 0.04, 0.13),
    }));
  }

  private createGrainCanvases(): Canvas[] {
    const random = createRandom(deriveSeed(this.seed, "grain"));
    const grainWidth = 192;
    const grainHeight = Math.max(96, Math.round(grainWidth * (this.height / this.width)));

    return Array.from({ length: 12 }, () => {
      const canvas = createCanvas(grainWidth, grainHeight);
      const context = canvas.getContext("2d");
      const image = context.createImageData(grainWidth, grainHeight);
      for (let index = 0; index < image.data.length; index += 4) {
        const level = random() > 0.5 ? 235 : 20;
        image.data[index] = level;
        image.data[index + 1] = level;
        image.data[index + 2] = level;
        image.data[index + 3] = Math.round(randomBetween(random, 50, 180));
      }
      context.putImageData(image, 0, 0);
      return canvas;
    });
  }

  render(analysis: AudioAnalysis, time: number): Buffer {
    const current = frameAt(analysis, time);
    const previousA = frameAt(analysis, Math.max(0, time - 0.055));
    const previousB = frameAt(analysis, Math.max(0, time - 0.12));
    const context = this.context;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    context.clearRect(0, 0, this.width, this.height);
    this.drawBackground(current, time);
    this.drawAtmosphere(current, time);
    this.drawSpectrum(current, time);
    this.drawWaveform(previousB, 0.07, 2.5);
    this.drawWaveform(previousA, 0.13, 1.8);
    this.drawWaveform(current, 0.62 + current.onset * 0.22, 1);
    this.drawTypography(analysis, time, current);
    this.drawPostEffects(current, Math.round(time * this.config.output.fps));
    context.restore();

    const image = context.getImageData(0, 0, this.width, this.height);
    return Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  }

  private drawBackground(frame: AnalysisFrame, time: number): void {
    const context = this.backgroundContext;
    const width = this.backgroundWidth;
    const height = this.backgroundHeight;
    const intensity = this.config.visual.intensity;
    const baseLevel = 5 + frame.rms * 7 * intensity;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, rgba(baseLevel + frame.mid * 8));
    gradient.addColorStop(0.45, rgba(baseLevel));
    gradient.addColorStop(1, rgba(baseLevel + frame.bass * 10));
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.globalCompositeOperation = "screen";
    for (const field of this.fogFields) {
      const angle = field.phase + time * field.speed;
      const x = (field.x + Math.sin(angle * 0.77) * 0.11) * width;
      const y = (field.y + Math.cos(angle) * 0.09) * height;
      const radius = field.radius * Math.max(width, height) * (1 + frame.bass * 0.18);
      const fog = context.createRadialGradient(x, y, 0, x, y, radius);
      const level = 85 + frame.mid * 95 + frame.rms * 35;
      fog.addColorStop(0, rgba(level, field.opacity * intensity));
      fog.addColorStop(0.42, rgba(level * 0.62, field.opacity * 0.42 * intensity));
      fog.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = fog;
      context.fillRect(0, 0, width, height);
    }

    for (const particle of this.particles) {
      const spectrum = frame.spectrum[particle.spectrumIndex] ?? 0;
      const phase = particle.phase + time * particle.speed * Math.PI * 2;
      const x = wrap(particle.x + time * particle.speed + Math.sin(phase) * particle.sway) * width;
      const y = wrap(particle.y - time * particle.speed * 0.31 + Math.cos(phase * 0.72) * particle.sway) * height;
      const radius =
        particle.radius *
        Math.max(width, height) *
        (0.82 + frame.bass * 0.42 + spectrum * 0.18) *
        particle.depth;
      const bokeh = context.createRadialGradient(x, y, radius * 0.08, x, y, radius);
      const level = 115 + spectrum * 95 + frame.rms * 35;
      const opacity = particle.opacity * (0.62 + frame.rms * 0.5) * intensity;
      bokeh.addColorStop(0, rgba(level, opacity));
      bokeh.addColorStop(0.2, rgba(level, opacity * 0.72));
      bokeh.addColorStop(0.72, rgba(level * 0.5, opacity * 0.14));
      bokeh.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = bokeh;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    context.globalCompositeOperation = "source-over";

    const output = this.context;
    const breathing = 1.025 + frame.rms * 0.022;
    const rotation = Math.sin(time * 0.023) * 0.004;
    output.save();
    output.translate(this.width / 2, this.height / 2);
    output.rotate(rotation);
    output.scale(breathing, breathing);
    output.filter = `blur(${Math.max(8, Math.round(this.width * 0.008))}px)`;
    output.imageSmoothingEnabled = true;
    output.imageSmoothingQuality = "high";
    output.drawImage(
      this.backgroundCanvas,
      -this.width / 2 - this.width * 0.03,
      -this.height / 2 - this.height * 0.03,
      this.width * 1.06,
      this.height * 1.06,
    );
    output.restore();
    output.filter = "none";
  }

  private drawAtmosphere(frame: AnalysisFrame, time: number): void {
    const context = this.context;
    const glowX = this.width * (0.52 + Math.sin(time * 0.031) * 0.09);
    const glowY = this.height * (0.57 + Math.cos(time * 0.024) * 0.06);
    const radius = Math.max(this.width, this.height) * (0.2 + frame.bass * 0.04);
    const glow = context.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius);
    glow.addColorStop(0, rgba(180, 0.035 + frame.rms * 0.05));
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, this.width, this.height);

    const horizon = this.height * 0.61;
    const line = context.createLinearGradient(this.width * 0.08, 0, this.width * 0.92, 0);
    line.addColorStop(0, "rgba(255,255,255,0)");
    line.addColorStop(0.5, rgba(220, 0.08 + frame.rms * 0.08));
    line.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = line;
    context.fillRect(this.width * 0.08, horizon - 1, this.width * 0.84, 2);
  }

  private drawSpectrum(frame: AnalysisFrame, time: number): void {
    const context = this.context;
    const margin = this.width * 0.08;
    const usableWidth = this.width - margin * 2;
    const horizon = this.height * 0.61;
    const maxHeight = this.height * (0.105 + frame.rms * 0.035);
    const bands = frame.spectrum.length;
    const pulse = this.config.visual.lowFlash ? Math.min(frame.onset, 0.32) : frame.onset;

    context.save();
    context.globalCompositeOperation = "screen";
    context.beginPath();
    context.moveTo(margin, horizon);
    for (let point = 0; point <= bands * 2; point += 1) {
      const progress = point / (bands * 2);
      const mirrored = Math.abs(progress * 2 - 1);
      const spectrumIndex = Math.min(bands - 1, Math.floor(mirrored * bands));
      const energy = frame.spectrum[spectrumIndex] ?? 0;
      const ripple = Math.sin(time * 0.8 + progress * Math.PI * 10) * frame.treble * 0.04;
      const x = margin + usableWidth * progress;
      const y = horizon - (energy + ripple) * maxHeight * (0.72 + frame.rms * 0.45);
      context.lineTo(x, y);
    }
    for (let point = bands * 2; point >= 0; point -= 1) {
      const progress = point / (bands * 2);
      const mirrored = Math.abs(progress * 2 - 1);
      const spectrumIndex = Math.min(bands - 1, Math.floor(mirrored * bands));
      const energy = frame.spectrum[spectrumIndex] ?? 0;
      const x = margin + usableWidth * progress;
      const y = horizon + energy * maxHeight * 0.78;
      context.lineTo(x, y);
    }
    context.closePath();
    const fill = context.createLinearGradient(0, horizon - maxHeight, 0, horizon + maxHeight);
    fill.addColorStop(0, rgba(230, 0.1 + pulse * 0.12));
    fill.addColorStop(0.5, rgba(160, 0.015));
    fill.addColorStop(1, rgba(210, 0.05 + pulse * 0.05));
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = rgba(230, 0.2 + frame.rms * 0.18 + pulse * 0.15);
    context.lineWidth = Math.max(1, this.width / 1200);
    context.stroke();

    const barWidth = usableWidth / bands;
    context.lineWidth = Math.max(0.5, this.width / 2200);
    for (let index = 0; index < bands; index += 1) {
      const energy = frame.spectrum[index] ?? 0;
      const x = margin + (index + 0.5) * barWidth;
      const height = energy * this.height * 0.07;
      context.strokeStyle = rgba(220, 0.04 + energy * 0.12);
      context.beginPath();
      context.moveTo(x, horizon + this.height * 0.17);
      context.lineTo(x, horizon + this.height * 0.17 - height);
      context.stroke();
    }
    context.restore();
  }

  private drawWaveform(frame: AnalysisFrame, alpha: number, widthScale: number): void {
    const context = this.context;
    const margin = this.width * 0.08;
    const usableWidth = this.width - margin * 2;
    const horizon = this.height * 0.61;
    const amplitude = this.height * (0.055 + frame.rms * 0.045);
    const onset = this.config.visual.lowFlash ? Math.min(frame.onset, 0.32) : frame.onset;

    context.save();
    context.globalCompositeOperation = "screen";
    context.beginPath();
    for (let index = 0; index < frame.waveform.length; index += 1) {
      const progress = index / Math.max(1, frame.waveform.length - 1);
      const edgeEnvelope = Math.sin(progress * Math.PI) ** 0.35;
      const x = margin + usableWidth * progress;
      const y = horizon + (frame.waveform[index] ?? 0) * amplitude * edgeEnvelope;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = rgba(242, clamp(alpha + onset * 0.22));
    context.lineWidth = Math.max(0.8, (this.width / 960) * widthScale);
    context.shadowColor = rgba(255, alpha * 0.8);
    context.shadowBlur = this.width * 0.006 * alpha;
    context.stroke();
    context.restore();
  }

  private drawTypography(analysis: AudioAnalysis, time: number, frame: AnalysisFrame): void {
    const title = this.config.text.title;
    const artist = this.config.text.artist;
    if (!title && !artist) return;
    const context = this.context;
    const safeX = this.width * 0.065;
    const safeY = this.height * 0.095;
    const endReveal = smoothstep(analysis.duration - 7, analysis.duration - 3.5, time);
    const entrance = smoothstep(0.15, 1.8, time);
    const settle = 1 - smoothstep(5.5, 9, time) * 0.72;
    const alpha = clamp(entrance * settle + endReveal * 0.74);
    const blur = lerp(this.width * 0.008, 0, smoothstep(0.2, 1.4, time));

    context.save();
    context.globalAlpha = alpha;
    context.filter = blur > 0.2 ? `blur(${blur}px)` : "none";
    context.shadowColor = "rgba(0,0,0,0.7)";
    context.shadowBlur = this.width * 0.012;
    context.fillStyle = rgba(245, 0.94);
    context.font = `600 ${Math.round(this.width * 0.038)}px sans-serif`;
    context.textBaseline = "top";
    drawSpacedText(context, title.toUpperCase(), safeX, safeY, this.width * 0.004);

    if (artist) {
      context.filter = "none";
      context.fillStyle = rgba(218, 0.66);
      context.font = `400 ${Math.round(this.width * 0.012)}px monospace`;
      drawSpacedText(context, artist.toUpperCase(), safeX + this.width * 0.002, safeY + this.width * 0.062, this.width * 0.0022);
    }
    context.restore();

    context.save();
    context.globalAlpha = 0.18 + frame.rms * 0.13;
    context.fillStyle = rgba(225, 1);
    context.font = `400 ${Math.round(this.width * 0.0075)}px monospace`;
    context.textBaseline = "bottom";
    drawSpacedText(
      context,
      `${this.seed.slice(0, 8).toUpperCase()}  /  ${Math.floor(time / 60)
        .toString()
        .padStart(2, "0")}:${Math.floor(time % 60).toString().padStart(2, "0")}`,
      safeX,
      this.height * 0.925,
      this.width * 0.0008,
    );
    context.restore();
  }

  private drawPostEffects(frame: AnalysisFrame, frameIndex: number): void {
    const context = this.context;
    const flash = this.config.visual.lowFlash ? Math.min(frame.onset, 0.28) : frame.onset;
    if (flash > 0.01) {
      context.fillStyle = rgba(255, flash * 0.065 * this.config.visual.intensity);
      context.fillRect(0, 0, this.width, this.height);
    }

    if (this.config.visual.vignette > 0) {
      const vignette = context.createRadialGradient(
        this.width / 2,
        this.height / 2,
        Math.min(this.width, this.height) * 0.18,
        this.width / 2,
        this.height / 2,
        Math.max(this.width, this.height) * 0.72,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(0.62, "rgba(0,0,0,0.03)");
      vignette.addColorStop(1, `rgba(0,0,0,${this.config.visual.vignette})`);
      context.fillStyle = vignette;
      context.fillRect(0, 0, this.width, this.height);
    }

    if (this.config.visual.grain > 0) {
      const grain = this.grainCanvases[frameIndex % this.grainCanvases.length];
      if (grain) {
        context.save();
        context.globalAlpha = this.config.visual.grain * (0.72 + frame.treble * 0.5);
        context.globalCompositeOperation = "overlay";
        context.imageSmoothingEnabled = false;
        context.drawImage(grain, 0, 0, this.width, this.height);
        context.restore();
      }
    }
  }
}
