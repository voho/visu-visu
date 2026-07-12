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
import { createSafeLayout, safeGraphRadius, type SafeLayout } from "./layout.js";

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

interface Sparkle {
  x: number;
  y: number;
  size: number;
  phase: number;
  speed: number;
  drift: number;
  spectrumIndex: number;
  hue: number;
}

interface AuroraRibbon {
  phase: number;
  speed: number;
  frequency: number;
  vertical: number;
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
  private readonly sparkles: Sparkle[];
  private readonly auroras: AuroraRibbon[];
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
    this.sparkles = this.createSparkles();
    this.auroras = this.createAuroras();
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

  private createSparkles(): Sparkle[] {
    const random = createRandom(deriveSeed(this.seed, "sparkles"));
    const count = Math.max(24, Math.round(this.config.visual.bokehCount * 0.8));
    return Array.from({ length: count }, (_, index) => ({
      x: random(),
      y: random(),
      size: randomBetween(random, 0.7, 2.4),
      phase: randomBetween(random, 0, Math.PI * 2),
      speed: randomBetween(random, 0.25, 1.1),
      drift: randomBetween(random, 0.006, 0.026),
      spectrumIndex:
        Math.floor(this.config.visual.spectrumBands * 0.62) +
        (index % Math.max(1, Math.ceil(this.config.visual.spectrumBands * 0.38))),
      hue: randomBetween(random, 0, 360),
    }));
  }

  private createAuroras(): AuroraRibbon[] {
    const random = createRandom(deriveSeed(this.seed, "aurora"));
    return Array.from({ length: 4 }, (_, index) => ({
      phase: randomBetween(random, 0, Math.PI * 2),
      speed: randomBetween(random, 0.012, 0.032),
      frequency: randomBetween(random, 1.05, 1.8),
      vertical: 0.17 + index * 0.2 + randomBetween(random, -0.025, 0.025),
      hue: randomBetween(random, 0, 160) + index * 38,
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
    const previousC = frameAt(analysis, Math.max(0, time - 0.2));
    const previousD = frameAt(analysis, Math.max(0, time - 0.32));
    const context = this.context;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    context.clearRect(0, 0, this.width, this.height);
    this.drawBackground(current, time);
    this.drawAtmosphere(current, time);
    this.drawSparkles(current, time);
    context.save();
    context.beginPath();
    context.rect(
      this.layout.left,
      this.layout.graphTop,
      this.layout.width,
      this.layout.graphBottom - this.layout.graphTop,
    );
    context.clip();
    this.drawBeatEchoes(analysis, time);
    this.drawSpectralHalo(current, previousB, time);
    this.drawSpectrumTunnel(analysis, current, time);
    this.drawSpectrum(current, time);
    this.drawWaveform(previousD, time, -72, 0.025, 3.8);
    this.drawWaveform(previousC, time, -54, 0.045, 3.2);
    this.drawWaveform(previousB, time, -40, 0.08, 2.5);
    this.drawWaveform(previousA, time, -18, 0.16, 1.8);
    this.drawWaveform(current, time, 0, 0.68 + current.onset * 0.22, 1);
    context.restore();
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

    this.drawAuroraBackground(frame, time);

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

  private drawAuroraBackground(frame: AnalysisFrame, time: number): void {
    const context = this.backgroundContext;
    const width = this.backgroundWidth;
    const height = this.backgroundHeight;
    const samples = 48;

    context.save();
    context.globalCompositeOperation = "screen";
    for (const ribbon of this.auroras) {
      const points: Array<{ x: number; y: number; thickness: number }> = [];
      for (let sample = 0; sample <= samples; sample += 1) {
        const progress = sample / samples;
        const spectrumIndex = Math.min(
          frame.spectrum.length - 1,
          Math.floor(progress * frame.spectrum.length),
        );
        const energy = (frame.spectrum[spectrumIndex] ?? 0) ** 0.8;
        const slowWave =
          Math.sin(
            Math.PI * 2 *
              (progress * ribbon.frequency + time * ribbon.speed) +
              ribbon.phase,
          ) *
          height *
          (0.025 + frame.mid * 0.04);
        const fineWave =
          Math.sin(progress * Math.PI * 22 + time * 1.1 + ribbon.phase) *
          height *
          0.008 *
          frame.treble;
        points.push({
          x: progress * width,
          y:
            height * ribbon.vertical +
            slowWave +
            fineWave +
            (energy - 0.35) * height * 0.055,
          thickness: height * (0.025 + frame.bass * 0.05 + energy * 0.025),
        });
      }

      context.beginPath();
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        if (!point) continue;
        if (index === 0) context.moveTo(point.x, point.y - point.thickness);
        else context.lineTo(point.x, point.y - point.thickness);
      }
      for (let index = points.length - 1; index >= 0; index -= 1) {
        const point = points[index];
        if (point) context.lineTo(point.x, point.y + point.thickness);
      }
      context.closePath();
      const alpha = 0.025 + frame.rms * 0.04 + frame.onset * 0.025;
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(
        0,
        hsla(this.palettePhase + ribbon.hue + time * 2, 88, 48, alpha * 0.45),
      );
      gradient.addColorStop(
        0.5,
        hsla(this.palettePhase + ribbon.hue + 110 + time * 2, 96, 62, alpha),
      );
      gradient.addColorStop(
        1,
        hsla(this.palettePhase + ribbon.hue + 220 + time * 2, 88, 48, alpha * 0.45),
      );
      context.fillStyle = gradient;
      context.fill();
    }
    context.restore();
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

  private drawSparkles(frame: AnalysisFrame, time: number): void {
    const context = this.context;
    const scale = Math.max(0.5, this.width / 1920);
    const onset = this.config.visual.lowFlash ? Math.min(frame.onset, 0.35) : frame.onset;

    context.save();
    context.globalCompositeOperation = "screen";
    for (const sparkle of this.sparkles) {
      const energy = frame.spectrum[sparkle.spectrumIndex] ?? 0;
      const twinkle = (0.5 + Math.sin(time * sparkle.speed * 5 + sparkle.phase) * 0.5) ** 4;
      const alpha =
        (0.015 + frame.treble * energy * 0.42 + onset * 0.12) *
        twinkle *
        this.config.visual.intensity;
      if (alpha < 0.012) continue;
      const x =
        wrap(
          sparkle.x +
            time * sparkle.drift * 0.08 +
            Math.sin(time * sparkle.speed * 0.27 + sparkle.phase) * sparkle.drift,
        ) * this.width;
      const y =
        wrap(
          sparkle.y -
            time * sparkle.drift * 0.035 +
            Math.cos(time * sparkle.speed * 0.22 + sparkle.phase) * sparkle.drift,
        ) * this.height;
      const size = sparkle.size * scale * (0.75 + energy * 1.8 + onset * 0.8);
      const hue = this.palettePhase + sparkle.hue + time * 4 + energy * 90;
      context.strokeStyle = hsla(hue, 96, 78, alpha);
      context.fillStyle = hsla(hue + 30, 98, 88, alpha * 1.25);
      context.lineWidth = Math.max(0.5, size * 0.35);
      context.beginPath();
      context.moveTo(x - size * 2.4, y);
      context.lineTo(x + size * 2.4, y);
      context.moveTo(x, y - size * 2.4);
      context.lineTo(x, y + size * 2.4);
      context.stroke();
      context.beginPath();
      context.arc(x, y, Math.max(0.5, size * 0.72), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  private drawBeatEchoes(analysis: AudioAnalysis, time: number): void {
    const context = this.context;
    const lifetime = 0.72;
    const currentIndex = Math.min(
      analysis.frames.length - 1,
      Math.max(0, Math.floor(time * analysis.fps)),
    );
    const startIndex = Math.max(1, currentIndex - Math.ceil(lifetime * analysis.fps));
    const events: number[] = [];

    for (let index = startIndex; index <= currentIndex; index += 1) {
      const strength = analysis.frames[index]?.onset ?? 0;
      const previous = analysis.frames[index - 1]?.onset ?? 0;
      const next = analysis.frames[index + 1]?.onset ?? 0;
      if (strength >= 0.12 && strength >= previous && strength > next) events.push(index);
    }

    const maximumRadius = safeGraphRadius(this.layout);
    context.save();
    context.globalCompositeOperation = "screen";
    for (const eventIndex of events.slice(-3)) {
      const eventFrame = analysis.frames[eventIndex];
      if (!eventFrame) continue;
      const age = Math.max(0, time - eventIndex / analysis.fps);
      const progress = clamp(age / lifetime);
      const eased = 1 - (1 - progress) ** 3;
      const strength = eventFrame.onset * Math.exp(-age / 0.3);
      const radius = maximumRadius * (0.18 + eased * 0.78);
      let dominantBand = 0;
      for (let index = 1; index < eventFrame.spectrum.length; index += 1) {
        if ((eventFrame.spectrum[index] ?? 0) > (eventFrame.spectrum[dominantBand] ?? 0)) {
          dominantBand = index;
        }
      }
      const hue =
        this.palettePhase +
        (dominantBand / Math.max(1, eventFrame.spectrum.length - 1)) * 320 +
        age * 24;
      const alpha =
        strength *
        (1 - progress) *
        (this.config.visual.lowFlash ? 0.22 : 0.34) *
        this.config.visual.intensity;
      context.strokeStyle = hsla(hue, 100, 72, alpha);
      context.lineWidth = Math.max(0.7, this.width * 0.0018 * (1 - progress));
      context.beginPath();
      context.ellipse(
        this.layout.centerX,
        this.layout.horizon,
        radius,
        radius * (0.42 + eventFrame.mid * 0.1),
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
    }
    context.restore();
  }

  private drawSpectralHalo(
    frame: AnalysisFrame,
    previous: AnalysisFrame,
    time: number,
  ): void {
    const context = this.context;
    const maximumRadius = safeGraphRadius(this.layout);
    const baseRadius = maximumRadius * (0.5 + frame.bass * 0.1);
    const rotation = time * (0.018 + frame.mid * 0.035);

    context.save();
    context.globalCompositeOperation = "screen";
    const contours = [
      { values: previous.spectrum, alpha: 0.045, scale: 0.94, hue: -28 },
      { values: frame.spectrum, alpha: 0.11 + frame.rms * 0.06, scale: 1, hue: 0 },
    ];
    for (const contour of contours) {
      context.beginPath();
      for (let index = 0; index <= contour.values.length; index += 1) {
        const spectrumIndex = index % contour.values.length;
        const energy = (contour.values[spectrumIndex] ?? 0) ** 0.72;
        const angle =
          (spectrumIndex / contour.values.length) * Math.PI * 2 - Math.PI / 2 + rotation;
        const radius =
          baseRadius * contour.scale +
          energy * maximumRadius * 0.2 +
          Math.sin(angle * 3 + time * 0.25) * maximumRadius * 0.018 * frame.mid;
        const x = this.layout.centerX + Math.cos(angle) * radius;
        const y = this.layout.horizon + Math.sin(angle) * radius;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.strokeStyle = this.rainbowGradient(
        context,
        this.layout.centerX - maximumRadius,
        this.layout.horizon,
        this.layout.centerX + maximumRadius,
        this.layout.horizon,
        time,
        contour.alpha,
        contour.hue,
        68,
      );
      context.lineWidth = Math.max(0.7, this.width / 1700);
      context.stroke();
    }

    for (let index = 0; index < frame.spectrum.length; index += 2) {
      const energy = frame.spectrum[index] ?? 0;
      if (energy < 0.08) continue;
      const angle = (index / frame.spectrum.length) * Math.PI * 2 - Math.PI / 2 + rotation;
      const innerRadius = baseRadius * 0.86;
      const outerRadius = baseRadius + energy * maximumRadius * 0.22;
      const hue = this.palettePhase + time * 5 + (index / frame.spectrum.length) * 320;
      context.strokeStyle = hsla(hue, 98, 72, 0.035 + energy * 0.13);
      context.lineWidth = Math.max(0.5, this.width / 2600);
      context.beginPath();
      context.moveTo(
        this.layout.centerX + Math.cos(angle) * innerRadius,
        this.layout.horizon + Math.sin(angle) * innerRadius,
      );
      context.lineTo(
        this.layout.centerX + Math.cos(angle) * outerRadius,
        this.layout.horizon + Math.sin(angle) * outerRadius,
      );
      context.stroke();
    }
    context.restore();
  }

  private drawSpectrumTunnel(
    analysis: AudioAnalysis,
    frame: AnalysisFrame,
    time: number,
  ): void {
    const context = this.context;
    const bands = frame.spectrum.length;
    const maxHeight = this.layout.horizon - this.layout.graphTop;

    context.save();
    context.globalCompositeOperation = "screen";
    for (let depth = 5; depth >= 1; depth -= 1) {
      const historical = frameAt(analysis, Math.max(0, time - depth * 0.065));
      const scale = 1 + depth * 0.025 + frame.onset * 0.05;
      const alpha = (1 - depth / 6) ** 2 * (0.025 + frame.rms * 0.07);
      context.beginPath();
      for (let point = 0; point <= bands * 2; point += 1) {
        const progress = point / (bands * 2);
        const mirrored = Math.abs(progress * 2 - 1);
        const spectrumIndex = Math.min(bands - 1, Math.floor(mirrored * bands));
        const energy = historical.spectrum[spectrumIndex] ?? 0;
        const baseX = this.layout.left + this.layout.width * progress;
        const x = this.layout.centerX + (baseX - this.layout.centerX) * scale;
        const y =
          this.layout.horizon -
          energy * maxHeight * (0.38 + depth * 0.035) +
          Math.sin(time * 0.35 + depth * 1.1) * this.layout.height * 0.004 * frame.mid;
        if (point === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      for (let point = bands * 2; point >= 0; point -= 1) {
        const progress = point / (bands * 2);
        const mirrored = Math.abs(progress * 2 - 1);
        const spectrumIndex = Math.min(bands - 1, Math.floor(mirrored * bands));
        const energy = historical.spectrum[spectrumIndex] ?? 0;
        const baseX = this.layout.left + this.layout.width * progress;
        const x = this.layout.centerX + (baseX - this.layout.centerX) * scale;
        const y = this.layout.horizon + energy * maxHeight * (0.3 + depth * 0.025);
        context.lineTo(x, y);
      }
      context.closePath();
      context.fillStyle = this.rainbowGradient(
        context,
        this.layout.left,
        this.layout.horizon,
        this.layout.right,
        this.layout.horizon,
        time,
        alpha,
        -depth * 18,
        58,
      );
      context.fill();
    }
    context.restore();
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
    context.lineWidth = Math.max(
      0.8,
      (this.width / 960) * widthScale * (1 + frame.rms * 0.42 + onset * 1.5),
    );
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
