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
import { createSafeLayout, type SafeLayout } from "./layout.js";

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
  hue: number;
}

interface FogField {
  x: number;
  y: number;
  radius: number;
  phase: number;
  speed: number;
  opacity: number;
  hue: number;
}

function rgba(level: number, alpha = 1): string {
  const channel = Math.round(clamp(level, 0, 255));
  return `rgba(${channel}, ${channel}, ${channel}, ${clamp(alpha)})`;
}

function hsla(hue: number, saturation: number, lightness: number, alpha = 1): string {
  const normalizedHue = ((hue % 360) + 360) % 360;
  return `hsla(${normalizedHue}, ${clamp(saturation, 0, 100)}%, ${clamp(lightness, 0, 100)}%, ${clamp(alpha)})`;
}

function wrap(value: number): number {
  return ((value % 1) + 1) % 1;
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
  private readonly palettePhase: number;
  private readonly layout: SafeLayout;

  constructor(
    config: ProjectConfig,
    seed: string,
    renderSize: { width: number; height: number } = {
      width: config.output.width,
      height: config.output.height,
    },
  ) {
    this.config = config;
    this.seed = seed;
    this.width = renderSize.width;
    this.height = renderSize.height;
    this.backgroundWidth = Math.max(64, Math.round(this.width / 4));
    this.backgroundHeight = Math.max(40, Math.round(this.height / 4));
    this.palettePhase = createRandom(deriveSeed(this.seed, "palette"))() * 360;
    this.layout = createSafeLayout(this.width, this.height);
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
      hue: randomBetween(random, 0, 360),
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
      hue: randomBetween(random, 0, 360),
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
    this.drawWaveform(previousB, time, -40, 0.08, 2.5);
    this.drawWaveform(previousA, time, -18, 0.16, 1.8);
    this.drawWaveform(current, time, 0, 0.68 + current.onset * 0.22, 1);
    this.drawPostEffects(current, Math.round(time * this.config.output.fps), time);
    this.drawTypography(analysis, time);
    context.restore();

    const image = context.getImageData(0, 0, this.width, this.height);
    return Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  }

  private rainbowGradient(
    context: SKRSContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    time: number,
    alpha: number,
    hueShift = 0,
    lightness = 64,
  ) {
    const gradient = context.createLinearGradient(x0, y0, x1, y1);
    for (let stop = 0; stop <= 8; stop += 1) {
      const progress = stop / 8;
      const hue = this.palettePhase + time * 5 + hueShift + progress * 360;
      gradient.addColorStop(progress, hsla(hue, 96, lightness, alpha));
    }
    return gradient;
  }

  private drawBackground(frame: AnalysisFrame, time: number): void {
    const context = this.backgroundContext;
    const width = this.backgroundWidth;
    const height = this.backgroundHeight;
    const intensity = this.config.visual.intensity;
    const baseHue = this.palettePhase + time * 1.8;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, hsla(baseHue + 210, 78, 3 + frame.mid * 5 * intensity));
    gradient.addColorStop(0.45, hsla(baseHue + 285, 72, 2.5 + frame.rms * 4 * intensity));
    gradient.addColorStop(1, hsla(baseHue + 350, 82, 4 + frame.bass * 7 * intensity));
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.globalCompositeOperation = "screen";
    for (const field of this.fogFields) {
      const angle = field.phase + time * field.speed;
      const x = (field.x + Math.sin(angle * 0.77) * 0.11) * width;
      const y = (field.y + Math.cos(angle) * 0.09) * height;
      const radius = field.radius * Math.max(width, height) * (1 + frame.bass * 0.18);
      const fog = context.createRadialGradient(x, y, 0, x, y, radius);
      const hue = baseHue + field.hue + frame.centroid * 120;
      const lightness = 48 + frame.mid * 22 + frame.rms * 8;
      fog.addColorStop(0, hsla(hue, 88, lightness, field.opacity * 1.45 * intensity));
      fog.addColorStop(
        0.42,
        hsla(hue + 38, 92, lightness * 0.68, field.opacity * 0.54 * intensity),
      );
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
      const opacity = particle.opacity * (0.62 + frame.rms * 0.5) * intensity;
      const frequencyHue =
        (particle.spectrumIndex / Math.max(1, this.config.visual.spectrumBands - 1)) * 300;
      const hue = baseHue + particle.hue + frequencyHue;
      const lightness = 58 + spectrum * 18 + frame.rms * 7;
      bokeh.addColorStop(0, hsla(hue, 98, lightness, opacity * 1.4));
      bokeh.addColorStop(0.2, hsla(hue + 24, 96, lightness * 0.88, opacity));
      bokeh.addColorStop(0.72, hsla(hue + 55, 92, lightness * 0.56, opacity * 0.2));
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
  }

  private drawAtmosphere(frame: AnalysisFrame, time: number): void {
    const context = this.context;
    const glowX = this.layout.centerX + Math.sin(time * 0.031) * this.layout.width * 0.09;
    const glowY = this.layout.horizon + Math.cos(time * 0.024) * this.layout.height * 0.05;
    const radius = Math.max(this.width, this.height) * (0.2 + frame.bass * 0.04);
    const glow = context.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius);
    const glowHue = this.palettePhase + time * 3 + frame.centroid * 220;
    glow.addColorStop(0, hsla(glowHue, 96, 64, 0.07 + frame.rms * 0.09));
    glow.addColorStop(0.42, hsla(glowHue + 60, 94, 42, 0.025 + frame.mid * 0.03));
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, this.width, this.height);

    const horizon = this.layout.horizon;
    const line = this.rainbowGradient(
      context,
      this.layout.left,
      0,
      this.layout.right,
      0,
      time,
      0.09 + frame.rms * 0.09,
      -30,
      70,
    );
    context.fillStyle = line;
    context.fillRect(this.layout.left, horizon - 1, this.layout.width, 2);
  }

  private drawSpectrum(frame: AnalysisFrame, time: number): void {
    const context = this.context;
    const margin = this.layout.left;
    const usableWidth = this.layout.width;
    const horizon = this.layout.horizon;
    const maxHeight = horizon - this.layout.graphTop;
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
      const y =
        horizon -
        clamp(energy + ripple) * maxHeight * (0.72 + frame.rms * 0.28);
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
    const fill = this.rainbowGradient(
      context,
      margin,
      horizon,
      margin + usableWidth,
      horizon,
      time,
      0.13 + pulse * 0.16,
      0,
      62,
    );
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = this.rainbowGradient(
      context,
      margin,
      horizon,
      margin + usableWidth,
      horizon,
      time,
      0.32 + frame.rms * 0.24 + pulse * 0.18,
      18,
      70,
    );
    context.lineWidth = Math.max(1, this.width / 1200);
    context.stroke();

    const barWidth = usableWidth / bands;
    context.lineWidth = Math.max(0.5, this.width / 2200);
    for (let index = 0; index < bands; index += 1) {
      const energy = frame.spectrum[index] ?? 0;
      const x = margin + (index + 0.5) * barWidth;
      const height = energy * (this.layout.graphBottom - horizon) * 0.58;
      const hue = this.palettePhase + time * 5 + (index / Math.max(1, bands - 1)) * 320;
      context.strokeStyle = hsla(hue, 96, 68, 0.08 + energy * 0.22);
      context.beginPath();
      context.moveTo(x, this.layout.graphBottom);
      context.lineTo(x, this.layout.graphBottom - height);
      context.stroke();
    }
    context.restore();
  }

  private drawWaveform(
    frame: AnalysisFrame,
    time: number,
    hueShift: number,
    alpha: number,
    widthScale: number,
  ): void {
    const context = this.context;
    const margin = this.layout.left;
    const usableWidth = this.layout.width;
    const horizon = this.layout.horizon;
    const amplitude =
      (horizon - this.layout.graphTop) * (0.46 + frame.rms * 0.38);
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
    context.strokeStyle = this.rainbowGradient(
      context,
      margin,
      horizon,
      margin + usableWidth,
      horizon,
      time,
      clamp(alpha + onset * 0.24),
      hueShift,
      72,
    );
    context.lineWidth = Math.max(0.8, (this.width / 960) * widthScale);
    context.shadowColor = hsla(
      this.palettePhase + time * 5 + 180 + hueShift,
      100,
      72,
      alpha * 0.85,
    );
    context.shadowBlur = this.width * 0.006 * alpha;
    context.stroke();
    context.restore();
  }

  private drawTypography(analysis: AudioAnalysis, time: number): void {
    const title = this.config.text.title.normalize("NFC").replace(/\s+/g, " ").trim();
    const artist = this.config.text.artist.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!title && !artist) return;
    const context = this.context;
    const safeY = this.layout.titleY;
    const endReveal = smoothstep(analysis.duration - 7, analysis.duration - 3.5, time);
    const entrance = smoothstep(0.15, 1.8, time);
    const settle = 1 - smoothstep(5.5, 9, time) * 0.72;
    const alpha = clamp(entrance * settle + endReveal * 0.74);
    const blur = lerp(this.width * 0.008, 0, smoothstep(0.2, 1.4, time));

    context.save();
    context.beginPath();
    context.rect(
      this.layout.left,
      this.layout.top,
      this.layout.width,
      this.layout.graphTop - this.layout.top,
    );
    context.clip();
    const scrim = context.createRadialGradient(
      this.layout.centerX,
      safeY,
      0,
      this.layout.centerX,
      safeY,
      Math.max(this.layout.width * 0.58, this.layout.height * 0.34),
    );
    scrim.addColorStop(0, "rgba(0,0,0,0.52)");
    scrim.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = scrim;
    context.fillRect(
      this.layout.left,
      this.layout.top,
      this.layout.width,
      this.layout.graphTop - this.layout.top,
    );
    context.globalAlpha = alpha;
    context.filter = blur > 0.2 ? `blur(${blur}px)` : "none";
    context.shadowColor = "rgba(0,0,0,0.7)";
    context.shadowBlur = this.width * 0.012;
    context.fillStyle = rgba(245, 0.94);
    context.textBaseline = "top";
    const textBoxHeight = this.layout.graphTop - safeY;
    const baseTitleSize = Math.min(
      this.width * 0.038,
      this.height * 0.07,
      textBoxHeight / (title && artist ? 2.05 : 1.15),
    );
    const titleSize = this.drawFittedText(
      context,
      title.toUpperCase(),
      "600",
      "sans-serif",
      baseTitleSize,
      baseTitleSize * 0.105,
      safeY,
    );

    if (artist) {
      context.filter = "none";
      context.fillStyle = rgba(218, 0.66);
      const artistY = title ? safeY + titleSize * 1.58 : safeY;
      this.drawFittedText(
        context,
        artist.toUpperCase(),
        "400",
        "monospace",
        baseTitleSize * 0.34,
        baseTitleSize * 0.061,
        artistY,
      );
    }
    context.restore();
  }

  private drawFittedText(
    context: SKRSContext2D,
    text: string,
    weight: string,
    family: string,
    baseSize: number,
    baseSpacing: number,
    y: number,
  ): number {
    if (!text) return 0;
    let size = Math.max(0.1, baseSize);
    let spacing = baseSpacing;
    context.font = `${weight} ${size}px ${family}`;
    context.letterSpacing = `${spacing}px`;
    const initialWidth = context.measureText(text).width;
    const scale = Math.min(1, (this.layout.width * 0.92) / Math.max(1, initialWidth));
    size = Math.max(0.1, size * scale);
    spacing *= scale;
    context.font = `${weight} ${size}px ${family}`;
    context.letterSpacing = `${spacing}px`;
    context.textAlign = "center";
    context.fillText(text, this.layout.centerX, y);
    return size;
  }

  private drawPostEffects(frame: AnalysisFrame, frameIndex: number, time: number): void {
    const context = this.context;
    const flash = this.config.visual.lowFlash ? Math.min(frame.onset, 0.28) : frame.onset;
    if (flash > 0.01) {
      let dominantBand = 0;
      for (let index = 1; index < frame.spectrum.length; index += 1) {
        if ((frame.spectrum[index] ?? 0) > (frame.spectrum[dominantBand] ?? 0)) dominantBand = index;
      }
      const hue =
        this.palettePhase +
        time * 5 +
        (dominantBand / Math.max(1, frame.spectrum.length - 1)) * 320;
      const bloom = context.createRadialGradient(
        this.layout.centerX,
        this.layout.horizon,
        0,
        this.layout.centerX,
        this.layout.horizon,
        Math.max(this.width, this.height) * 0.55,
      );
      bloom.addColorStop(
        0,
        hsla(hue, 100, 72, flash * 0.18 * this.config.visual.intensity),
      );
      bloom.addColorStop(
        0.38,
        hsla(hue + 50, 98, 58, flash * 0.07 * this.config.visual.intensity),
      );
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = bloom;
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
