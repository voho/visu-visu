import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { frameAt } from "../audio/analyze.js";
import { onsetEventsBetween } from "../audio/onsets.js";
import { deriveMusicMotion, type MusicMotion } from "./music-motion.js";
import { novaEventsAt, type SupernovaEvent } from "./supernova.js";
import { FrozenCloudLayer } from "./frozen-cloud-layer.js";
import { drawArtwork, deriveArtworkMotion, type PreparedArtwork } from "./artwork.js";
import { ArtworkInfluence } from "./artwork-influence.js";
import { createArtworkWarpField } from "./artwork-warp.js";
import { createMaterial, recolorMaterial, type MaterialMap, type MaterialSample } from "./material.js";
import { lightingAt, shadeSurface, type Rgb } from "./lighting.js";
import { paletteCss, paletteRgb, randomPalette, type ScenePalette } from "./palette.js";
import { MaterialLightLayer } from "./material-layer.js";
import { sampleResonanceMaterial } from "./surface-material.js";
import { drawMaterialSurface } from "./surface-mesh.js";
import { deriveSceneDynamics, type SceneDynamics } from "./scene-dynamics.js";
import { SceneAtmosphere } from "./scene-atmosphere.js";
import { drawAtmosphericBloom, inertialMusicMotion, sceneCameraMatrix } from "./scene-optics.js";
import { audioFieldAt, audioFieldGeometry, drawAudioField } from "./audio-field.js";
import { deriveMusicEffects, type MusicEffects, frequencyResponse } from "./music-effects.js";
import {
  clamp,
  createRandom,
  deriveSeed,
  lerp,
  randomBetween,
  smoothstep,
} from "../math/random.js";
import type { AnalysisFrame, AudioAnalysis, ProjectConfig } from "../types.js";
import {
  deriveChoreography,
  deriveVisualState,
  type Choreography,
  type VisualState,
} from "./conductor.js";
import {
  createSafeLayout,
  safeGraphRadii,
  type SafeLayout,
} from "./layout.js";
import {
  createResonancePlan,
  createResonanceFilaments,
  type ResonancePlan,
  type ResonanceFilament,
} from "./resonance.js";
import {
  createDepthGlints,
  createRibbonPlan,
  createSpectralRibbonPoints,
  createVortexPlan,
  createVortexRings,
  depthGlintPose,
  deriveDynamicGrade,
  visualTransient,
  type DepthGlint,
  type DynamicGrade,
  type RibbonPlan,
  type RibbonPoint,
  type VortexPlan,
  type VortexRingPose,
} from "./reactive-effects.js";

interface NebulaLobe {
  angle: number;
  orbitX: number;
  orbitY: number;
  radius: number;
  stretchX: number;
  stretchY: number;
  rotation: number;
  phase: number;
  speed: number;
  opacity: number;
  hueOffset: number;
}

interface DreamOrb {
  angle: number;
  radius: number;
  depth: number;
  size: number;
  opacity: number;
  phase: number;
  speed: number;
  hueOffset: number;
  spectrumIndex: number;
}

interface OnsetEvent {
  index: number;
  age: number;
  strength: number;
  dominantRatio: number;
}

interface Stardust {
  x: number;
  y: number;
  depth: number;
  size: number;
  phase: number;
  band: number;
}

function resetContext(
  context: SKRSContext2D,
  width: number,
  height: number,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.filter = "none";
  context.shadowBlur = 0;
  context.shadowColor = "rgba(0,0,0,0)";
  context.clearRect(0, 0, width, height);
}

export class VisualizerRenderer {
  readonly canvas: Canvas;

  private readonly context: SKRSContext2D;
  private readonly backgroundCanvas: Canvas;
  private readonly backgroundContext: SKRSContext2D;
  private readonly slowBackgroundCanvas: Canvas;
  private readonly slowBackgroundContext: SKRSContext2D;
  private readonly emissionCanvas: Canvas;
  private readonly emissionContext: SKRSContext2D;
  private readonly grainCanvases: Canvas[];
  private readonly nebulaLobes: NebulaLobe[];
  private readonly dreamOrbs: DreamOrb[];
  private readonly glints: DepthGlint[];
  private readonly ribbonPlan: RibbonPlan;
  private readonly vortexPlan: VortexPlan;
  private readonly resonancePlan: ResonancePlan;
  private readonly echoPlan: ResonancePlan;
  private readonly stardust: Stardust[];
  private readonly width: number;
  private readonly height: number;
  private readonly backgroundWidth: number;
  private readonly backgroundHeight: number;
  private readonly config: ProjectConfig;
  private readonly seed: string;
  private readonly palettePhase: number;
  private readonly palette: ScenePalette;
  private readonly layout: SafeLayout;
  private readonly frozenClouds: FrozenCloudLayer;
  private readonly material: MaterialMap;
  private readonly materialLight: MaterialLightLayer;
  private readonly artworkLight: MaterialLightLayer | undefined;
  private readonly sceneAtmosphere: SceneAtmosphere;
  private readonly artworkInfluence = new ArtworkInfluence();
  private backgroundCacheKey = "";
  private backgroundCacheAnalysis: AudioAnalysis | undefined;

  /** Existing musical color phases select image swatches instead of rotating through unrelated hues. */
  private color(phase: number, saturation: number, lightness: number, alpha = 1): string {
    return paletteCss(this.palette, phase - this.palettePhase, saturation, lightness, alpha);
  }

  constructor(
    config: ProjectConfig,
    seed: string,
    renderSize: { width: number; height: number } = {
      width: config.output.width,
      height: config.output.height,
    },
    private readonly artwork?: PreparedArtwork,
  ) {
    this.config = config;
    this.seed = seed;
    this.width = renderSize.width;
    this.height = renderSize.height;
    this.backgroundWidth = Math.max(64, Math.round(this.width / 4));
    this.backgroundHeight = Math.max(40, Math.round(this.height / 4));
    this.palette = artwork?.palette ?? randomPalette(seed);
    this.palettePhase = this.palette.anchorHue;
    this.layout = createSafeLayout(this.width, this.height);
    this.frozenClouds = new FrozenCloudLayer(this.width, this.height, this.layout, this.seed);
    const atmosphereMaterial = recolorMaterial(createMaterial(seed), this.palette);
    this.material = artwork?.objectMaterial ?? atmosphereMaterial;
    this.materialLight = new MaterialLightLayer(this.width, this.height, atmosphereMaterial, this.layout);
    this.sceneAtmosphere = new SceneAtmosphere(this.width, this.height, this.layout, seed, config.visual.lowFlash);
    this.artworkLight = artwork?.material
      ? new MaterialLightLayer(this.width, this.height, artwork.material, this.layout, true)
      : undefined;

    this.canvas = createCanvas(this.width, this.height);
    this.context = this.canvas.getContext("2d");
    this.backgroundCanvas = createCanvas(this.backgroundWidth, this.backgroundHeight);
    this.backgroundContext = this.backgroundCanvas.getContext("2d");
    this.slowBackgroundCanvas = createCanvas(
      this.backgroundWidth,
      this.backgroundHeight,
    );
    this.slowBackgroundContext = this.slowBackgroundCanvas.getContext("2d");
    this.emissionCanvas = createCanvas(this.backgroundWidth, this.backgroundHeight);
    this.emissionContext = this.emissionCanvas.getContext("2d");

    this.nebulaLobes = this.createNebulaLobes();
    this.dreamOrbs = this.createDreamOrbs();
    this.glints = createDepthGlints(
      this.seed,
      Math.max(72, Math.round(this.config.visual.bokehCount * 1.6)),
      this.config.visual.spectrumBands,
    );
    this.ribbonPlan = createRibbonPlan(this.seed);
    this.vortexPlan = createVortexPlan(this.seed, 7);
    this.resonancePlan = createResonancePlan(this.seed);
    this.echoPlan = { ...this.resonancePlan, filaments: this.resonancePlan.filaments.filter((_, index) => index % 4 === 0) };
    const dustRandom = createRandom(deriveSeed(this.seed, "stardust"));
    this.stardust = Array.from({ length: 640 }, () => ({
      x: dustRandom(),
      y: dustRandom(),
      depth: dustRandom(),
      size: randomBetween(dustRandom, 0.22, 1.15),
      phase: dustRandom() * Math.PI * 2,
      band: Math.floor(dustRandom() * this.config.visual.spectrumBands),
    }));
    this.grainCanvases = this.createGrainCanvases();
  }

  private createNebulaLobes(): NebulaLobe[] {
    const random = createRandom(deriveSeed(this.seed, "radial-nebula"));
    return Array.from({ length: 7 }, (_, index) => ({
      angle: randomBetween(random, 0, Math.PI * 2),
      orbitX: randomBetween(random, 0.06, 0.34),
      orbitY: randomBetween(random, 0.04, 0.26),
      radius: randomBetween(random, 0.22, 0.48),
      stretchX: randomBetween(random, 0.82, 1.7),
      stretchY: randomBetween(random, 0.48, 1.05),
      rotation: randomBetween(random, -0.8, 0.8),
      phase: randomBetween(random, 0, Math.PI * 2),
      speed: randomBetween(random, 0.007, 0.022) * (index % 2 === 0 ? 1 : -1),
      opacity: randomBetween(random, 0.075, 0.17),
      hueOffset: index % 2 === 0
        ? randomBetween(random, -18, 28)
        : randomBetween(random, 72, 118),
    }));
  }

  private createDreamOrbs(): DreamOrb[] {
    const random = createRandom(deriveSeed(this.seed, "dream-orbs"));
    return Array.from(
      { length: Math.max(16, Math.round(this.config.visual.bokehCount * 0.58)) },
      (_, index) => ({
        angle: randomBetween(random, 0, Math.PI * 2),
        radius: Math.sqrt(randomBetween(random, 0.04, 1)),
        depth: randomBetween(random, 0.25, 1),
        size: randomBetween(random, 0.018, 0.072),
        opacity: randomBetween(random, 0.028, 0.11),
        phase: randomBetween(random, 0, Math.PI * 2),
        speed: randomBetween(random, 0.003, 0.012) * (index % 2 === 0 ? 1 : -1),
        hueOffset: index % 3 === 0
          ? randomBetween(random, 80, 125)
          : randomBetween(random, -24, 28),
        spectrumIndex: index % this.config.visual.spectrumBands,
      }),
    );
  }

  private createGrainCanvases(): Canvas[] {
    const random = createRandom(deriveSeed(this.seed, "grain"));
    const grainWidth = 192;
    const grainHeight = Math.max(
      96,
      Math.round(grainWidth * (this.height / this.width)),
    );

    return Array.from({ length: 29 }, () => {
      const canvas = createCanvas(grainWidth, grainHeight);
      const context = canvas.getContext("2d");
      const image = context.createImageData(grainWidth, grainHeight);
      for (let index = 0; index < image.data.length; index += 4) {
        const level = random() > 0.5 ? 232 : 18;
        image.data[index] = level;
        image.data[index + 1] = level;
        image.data[index + 2] = level;
        image.data[index + 3] = Math.round(randomBetween(random, 42, 150));
      }
      context.putImageData(image, 0, 0);
      return canvas;
    });
  }

  render(analysis: AudioAnalysis, time: number): Buffer {
    const frame = frameAt(analysis, time);
    const dynamics = deriveSceneDynamics(analysis, time);
    const motion = inertialMusicMotion(deriveMusicMotion(analysis, time), dynamics);
    const effects = deriveMusicEffects(motion, this.config.visual.lowFlash, dynamics);
    const visual = deriveVisualState(analysis, time);
    const choreography = deriveChoreography(
      visual,
      frame.onset,
      this.config.visual.lowFlash,
    );
    const grade = deriveDynamicGrade(
      frame,
      visual,
      time,
      this.config.visual.lowFlash,
    );
    const ribbon = createSpectralRibbonPoints(
      frame,
      visual,
      this.layout,
      time,
      this.ribbonPlan,
      {
        lowFlash: this.config.visual.lowFlash,
        samples: Math.max(144, this.config.visual.spectrumBands * 2),
        waveformScale: choreography.layers.waveform,
      },
    );
    const rings = createVortexRings(
      this.vortexPlan,
      frame,
      visual,
      this.layout,
      motion.fastTime * 0.65,
      this.config.visual.lowFlash,
    );
    const filaments = createResonanceFilaments(
      this.resonancePlan, frame, visual, this.layout, time,
      this.config.visual.lowFlash,
      motion,
    );

    const novas = novaEventsAt(analysis, time, this.seed, this.config.visual.lowFlash);

    resetContext(this.context, this.width, this.height);
    this.drawCinematicBackground(
      analysis,
      frame,
      time,
      visual,
      choreography,
      grade,
      ribbon,
      rings,
      filaments,
      motion,
      effects,
      novas,
    );
    const signal = audioFieldAt(analysis, time);
    const audioField = audioFieldGeometry(signal.spectrum, frame.waveform, signal.fast, signal.slow, dynamics.drift.clock);
    this.drawStardust(frame, visual, dynamics.cloud.clock);
    this.drawDepthGlints(frame, dynamics.detail.clock * 2.4, visual, choreography);

    const context = this.context;
    context.save();
    context.beginPath();
    context.rect(
      this.layout.left,
      this.layout.graphTop,
      this.layout.width,
      this.layout.graphBottom - this.layout.graphTop,
    );
    context.clip();
    this.applyGraphCamera(context, dynamics);
    drawAudioField(context, this.layout, audioField, this.palette, false, this.config.visual.lowFlash);
    drawMaterialSurface(context, filaments, frame, motion, this.material,
      lightingAt(motion, time, this.seed, this.palettePhase + effects.hueShift, this.config.visual.lowFlash, frame.spectrum, this.palette),
      this.config.visual.lighting ?? 0.65, this.config.visual.lowFlash);
    this.drawResonance(context, filaments, frame, visual, time, false, "back", motion, effects);
    context.save();
    context.globalAlpha = 0.09;
    this.drawVortexRings(context, rings, visual, choreography, false);
    this.drawRibbonMesh(context, ribbon, visual, choreography, time, "back");
    context.restore();
    this.drawResonance(context, filaments, frame, visual, time, false, "front", motion, effects);
    drawAudioField(context, this.layout, audioField, this.palette, true, this.config.visual.lowFlash);
    this.drawFastOrbiters(frame, { ...motion, fastTime: dynamics.spark.clock }, effects);
    context.save();
    context.globalAlpha = 0.055;
    this.drawRibbonMesh(context, ribbon, visual, choreography, time, "front");
    this.drawRibbonDetails(ribbon, frame, visual, choreography, time);
    this.drawSpectralFlares(ribbon, visual, choreography, time);
    context.restore();
    this.drawOnsetShockwaves(analysis, time, false);
    this.drawOnsetSparks(analysis, visual, time);
    context.restore();

    context.save();
    this.applyGraphCamera(context, dynamics);
    this.drawSupernovas(context, novas, effects, false);
    context.restore();

    this.sceneAtmosphere.drawForeground(context, dynamics,
      lightingAt(motion, time, this.seed, this.palettePhase + effects.hueShift,
        this.config.visual.lowFlash, frame.spectrum, this.palette));

    this.drawPostEffects(
      Math.round(time * this.config.output.fps),
      grade,
      visual,
    );
    this.drawTypography(time, grade);

    const image = context.getImageData(0, 0, this.width, this.height);
    return Buffer.from(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength,
    );
  }

  private drawCinematicBackground(
    analysis: AudioAnalysis,
    frame: AnalysisFrame,
    time: number,
    visual: VisualState,
    choreography: Choreography,
    grade: DynamicGrade,
    ribbon: RibbonPoint[],
    rings: VortexRingPose[],
    filaments: ResonanceFilament[],
    motion: MusicMotion,
    effects: MusicEffects,
    novas: SupernovaEvent[],
  ): void {
    const cadence = Math.max(1, Math.round(this.config.output.fps / 10));
    const frameIndex = Math.floor(
      Math.max(0, time) * this.config.output.fps + 1e-9,
    );
    const bucket = Math.floor(frameIndex / cadence);
    const cacheKey =
      analysis.sourceHash +
      ":" +
      analysis.sourceFileHash +
      ":" +
      analysis.frames.length +
      ":" +
      bucket;

    if (analysis !== this.backgroundCacheAnalysis || cacheKey !== this.backgroundCacheKey) {
      const cachedTime = (bucket * cadence) / this.config.output.fps;
      this.renderSlowBackground(analysis, cachedTime);
      this.backgroundCacheKey = cacheKey;
      this.backgroundCacheAnalysis = analysis;
    }

    const background = this.backgroundContext;
    resetContext(background, this.backgroundWidth, this.backgroundHeight);

    this.renderEmission(
      analysis,
      frame,
      time,
      visual,
      choreography,
      grade,
      ribbon,
      rings,
      filaments,
      motion,
      effects,
      novas,
    );
    const dynamics = deriveSceneDynamics(analysis, time);
    drawAtmosphericBloom(background, this.emissionCanvas, this.layout, this.width, this.height,
      dynamics, (0.42 + effects.glow * 0.36 + dynamics.cloud.energy * 0.12) * this.config.visual.intensity,
      effects.saturation, this.config.visual.lowFlash);

    const output = this.context;
    const camera = choreography.layers.camera;
    const breathing =
      1.035 +
      motion.bassEnergy * 0.045 + motion.bassPulse * 0.03 +
      choreography.impact * 0.009 +
      visual.peak * 0.006;
    const rotation =
      Math.sin(time * 0.027 + this.palettePhase * 0.01) *
        (0.002 + camera * 0.002) +
      visual.trend * 0.0015;
    const driftX =
      Math.sin(time * 0.061 + this.palettePhase) *
      this.width *
      (0.004 + camera * 0.004);
    const driftY =
      Math.cos(time * 0.049 + this.palettePhase) *
      this.height *
      (0.003 + camera * 0.003);

    output.save();
    output.translate(this.width / 2 + driftX, this.height / 2 + driftY);
    output.rotate(rotation);
    output.scale(breathing, breathing);
    output.imageSmoothingEnabled = true;
    // The source is already diffuse; cubic resampling adds cost without detail.
    output.imageSmoothingQuality = "medium";
    output.drawImage(
      this.slowBackgroundCanvas,
      -this.width / 2 - this.width * 0.035,
      -this.height / 2 - this.height * 0.035,
      this.width * 1.07,
      this.height * 1.07,
    );
    output.restore();
    // Emission already uses the hero camera. Keep bloom registered to its
    // source geometry instead of applying the atmosphere's separate drift.
    const artworkWarp = this.artwork ? this.artworkInfluence.at(analysis, time, (captureTime) => {
      const captureFrame = frameAt(analysis, captureTime);
      const captureDynamics = deriveSceneDynamics(analysis, captureTime);
      const captureMotion = inertialMusicMotion(deriveMusicMotion(analysis, captureTime), captureDynamics);
      const shape = createResonanceFilaments(this.resonancePlan, captureFrame,
        deriveVisualState(analysis, captureTime), this.layout, captureTime, this.config.visual.lowFlash, captureMotion);
      return createArtworkWarpField(shape, this.width, this.height, this.layout,
        sceneCameraMatrix(this.layout, captureDynamics, this.palettePhase * 0.01, this.ribbonPlan.direction),
        0.35 + captureDynamics.cloud.energy * 0.45 + captureDynamics.body.energy * 0.20);
    }) : undefined;
    if (this.artwork) drawArtwork(output, this.artwork, time, motion, artworkWarp);
    const lightingStrength = this.config.visual.lighting ?? 0.65;
    const lights = lightingAt(motion, time, this.seed, this.palettePhase + effects.hueShift, this.config.visual.lowFlash, frame.spectrum, this.palette);
    this.sceneAtmosphere.draw(output, dynamics, lights);
    if (lightingStrength > 0) {
      this.materialLight.draw(output, lights, lightingStrength);
      this.artworkLight?.draw(output, lights, lightingStrength, deriveArtworkMotion(time, motion).zoom, artworkWarp);
    }
    this.frozenClouds.draw(output, analysis, time, (context, captureTime) => {
      const frozenFrame = frameAt(analysis, captureTime);
      const frozenVisual = deriveVisualState(analysis, captureTime);
      const frozenDynamics = deriveSceneDynamics(analysis, captureTime);
      const frozenMotion = inertialMusicMotion(deriveMusicMotion(analysis, captureTime), frozenDynamics);
      const frozenEffects = deriveMusicEffects(frozenMotion, this.config.visual.lowFlash, frozenDynamics);
      const frozenFilaments = createResonanceFilaments(this.resonancePlan, frozenFrame, frozenVisual,
        this.layout, captureTime, this.config.visual.lowFlash, frozenMotion);
      context.save();
      this.applyGraphCamera(context, frozenDynamics);
      drawMaterialSurface(context, frozenFilaments, frozenFrame, frozenMotion, this.material,
        lightingAt(frozenMotion, captureTime, this.seed, this.palettePhase + frozenEffects.hueShift,
          this.config.visual.lowFlash, frozenFrame.spectrum, this.palette), this.config.visual.lighting ?? 0.65, this.config.visual.lowFlash);
      this.drawResonance(context, frozenFilaments, frozenFrame, frozenVisual, captureTime,
        true, "back", frozenMotion, frozenEffects);
      this.drawResonance(context, frozenFilaments, frozenFrame, frozenVisual, captureTime,
        true, "front", frozenMotion, frozenEffects);
      context.restore();
    });
    output.save();
    output.globalCompositeOperation = "screen";
    output.drawImage(this.backgroundCanvas, 0, 0, this.width, this.height);
    output.restore();
  }

  private renderSlowBackground(
    analysis: AudioAnalysis,
    time: number,
  ): void {
    const frame = frameAt(analysis, time);
    const visual = deriveVisualState(analysis, time);
    const grade = deriveDynamicGrade(
      frame,
      visual,
      time,
      this.config.visual.lowFlash,
    );
    const choreography = deriveChoreography(
      visual,
      frame.onset,
      this.config.visual.lowFlash,
    );
    const atmosphere = 0.34 + choreography.layers.aurora * 0.66;
    const context = this.slowBackgroundContext;
    const width = this.backgroundWidth;
    const height = this.backgroundHeight;
    const effects = deriveMusicEffects(deriveMusicMotion(analysis, time), this.config.visual.lowFlash, deriveSceneDynamics(analysis, time));
    const baseHue = this.palettePhase + effects.hueShift * 0.5 + grade.hueShift * 0.15;
    const peakShade = 1 - visual.peak * 0.28;

    resetContext(context, width, height);
    const base = context.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, this.color(228, 64, 3.5 * peakShade));
    base.addColorStop(0.48, this.color(240, 58, 2.4 * peakShade));
    base.addColorStop(1, this.color(252, 58, 5.5 * peakShade));
    context.fillStyle = base;
    context.fillRect(0, 0, width, height);

    const focalX = (this.layout.centerX / this.width) * width;
    const focalY = (this.layout.horizon / this.height) * height;
    const centralField = context.createRadialGradient(
      focalX,
      focalY,
      0,
      focalX,
      focalY,
      Math.max(width, height) * 0.68,
    );
    centralField.addColorStop(
      0,
      this.color(
        baseHue + 18,
        88,
        36,
        (0.1 + visual.ambient * 0.045) * peakShade * atmosphere,
      ),
    );
    centralField.addColorStop(
      0.42,
      this.color(baseHue + 94, 90, 24, 0.055 * peakShade * atmosphere),
    );
    centralField.addColorStop(1, "rgba(0,0,0,0)");
    context.save();
    context.globalCompositeOperation = "screen";
    context.fillStyle = centralField;
    context.fillRect(0, 0, width, height);
    context.restore();

    context.save();
    context.globalCompositeOperation = "screen";
    for (const lobe of this.nebulaLobes) {
      const orbit = lobe.angle + time * lobe.speed;
      const x =
        focalX +
        Math.cos(orbit) * width * lobe.orbitX +
        Math.sin(time * 0.018 + lobe.phase) * width * 0.035;
      const y =
        focalY +
        Math.sin(orbit) * height * lobe.orbitY +
        Math.cos(time * 0.014 + lobe.phase) * height * 0.028;
      const radius = lobe.radius * Math.max(width, height);
      const energy = 0.72 + frame.rms * 0.2 + frame.bass * 0.12;
      const hue = baseHue + lobe.hueOffset;

      context.save();
      context.translate(x, y);
      context.rotate(lobe.rotation + Math.sin(time * 0.011 + lobe.phase) * 0.08);
      context.scale(lobe.stretchX, lobe.stretchY);
      const cloud = context.createRadialGradient(0, 0, 0, 0, 0, radius);
      cloud.addColorStop(
        0,
        this.color(
          hue,
          92,
          54 + frame.mid * 14,
          lobe.opacity *
            energy *
            peakShade *
            atmosphere *
            this.config.visual.intensity,
        ),
      );
      cloud.addColorStop(
        0.38,
        this.color(
          hue + 24,
          90,
          32,
          lobe.opacity *
            0.48 *
            peakShade *
            atmosphere *
            this.config.visual.intensity,
        ),
      );
      cloud.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = cloud;
      context.beginPath();
      context.arc(0, 0, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }

    context.filter = "blur(5px)";
    for (let index = 0; index < 4; index += 1) {
      const radiusX = width * (0.18 + index * 0.105);
      const radiusY = height * (0.11 + index * 0.065);
      context.strokeStyle = this.color(
        baseHue + (index % 2 === 0 ? 12 : 96),
        88,
        52,
        (0.028 + visual.ambient * 0.02) * peakShade * atmosphere,
      );
      context.lineWidth = Math.max(2, height * (0.025 - index * 0.003));
      context.beginPath();
      context.ellipse(
        focalX + Math.sin(time * 0.018 + index) * width * 0.015,
        focalY + Math.cos(time * 0.014 + index) * height * 0.012,
        radiusX,
        radiusY,
        Math.sin(time * 0.01 + index) * 0.18,
        -Math.PI * 0.78,
        Math.PI * 0.72,
      );
      context.stroke();
    }
    context.filter = "none";

    for (const orb of this.dreamOrbs) {
      const angle = orb.angle + time * orb.speed;
      const spectrum = frame.spectrum[orb.spectrumIndex] ?? 0;
      const radius = orb.radius * (0.22 + orb.depth * 0.74);
      const x = focalX + Math.cos(angle) * radius * width * 0.62;
      const y = focalY + Math.sin(angle) * radius * height * 0.58;
      const orbRadius =
        orb.size *
        Math.max(width, height) *
        (0.68 + orb.depth * 0.5 + spectrum * 0.18);
      const alpha =
        orb.opacity *
        (0.7 + frame.rms * 0.24) *
        peakShade *
        atmosphere *
        this.config.visual.intensity;
      const glow = context.createRadialGradient(
        x,
        y,
        0,
        x,
        y,
        orbRadius,
      );
      glow.addColorStop(
        0,
        this.color(baseHue + orb.hueOffset, 94, 72, alpha),
      );
      glow.addColorStop(
        0.35,
        this.color(baseHue + orb.hueOffset + 22, 92, 48, alpha * 0.34),
      );
      glow.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = glow;
      context.fillRect(
        x - orbRadius,
        y - orbRadius,
        orbRadius * 2,
        orbRadius * 2,
      );
    }
    context.restore();

    context.save();
    context.globalCompositeOperation = "soft-light";
    const wash = context.createLinearGradient(0, height, width, 0);
    const washAlpha =
      grade.washAlpha * (0.36 + choreography.layers.grade * 0.64);
    wash.addColorStop(0, this.color(baseHue, 88, 42, washAlpha));
    wash.addColorStop(
      0.55,
      this.color(baseHue + 54, 86, 54, washAlpha * 0.35),
    );
    wash.addColorStop(1, this.color(baseHue + 104, 90, 44, washAlpha));
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);
    context.restore();
  }

  private renderEmission(
    analysis: AudioAnalysis,
    frame: AnalysisFrame,
    time: number,
    visual: VisualState,
    choreography: Choreography,
    grade: DynamicGrade,
    ribbon: RibbonPoint[],
    rings: VortexRingPose[],
    filaments: ResonanceFilament[],
    motion: MusicMotion,
    effects: MusicEffects,
    novas: SupernovaEvent[],
  ): void {
    const context = this.emissionContext;
    resetContext(context, this.backgroundWidth, this.backgroundHeight);
    const scaleX = this.backgroundWidth / this.width;
    const scaleY = this.backgroundHeight / this.height;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    context.save();
    this.applyGraphCamera(context, deriveSceneDynamics(analysis, time));
    this.drawSupernovas(context, novas, effects, true);
    context.restore();

    this.drawOnsetBeams(context, analysis, time, visual, choreography);
    const coreRadius =
      Math.max(this.width, this.height) *
      (0.105 + frame.bass * 0.025 + visual.peak * 0.02);
    const coreGlow = context.createRadialGradient(
      this.layout.centerX,
      this.layout.horizon,
      0,
      this.layout.centerX,
      this.layout.horizon,
      coreRadius,
    );
    const coreHue =
      this.palettePhase + effects.hueShift;
    coreGlow.addColorStop(
      0,
      this.color(
        coreHue,
        100,
        72,
        (0.12 + choreography.layers.spiral * 0.2 + grade.bloom * 0.5) *
          this.config.visual.intensity,
      ),
    );
    coreGlow.addColorStop(
      0.28,
      this.color(coreHue + 54, 100, 52, 0.08 + visual.peak * 0.08),
    );
    coreGlow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = coreGlow;
    context.fillRect(0, 0, this.width, this.height);

    context.save();
    context.beginPath();
    context.rect(
      this.layout.left,
      this.layout.graphTop,
      this.layout.width,
      this.layout.graphBottom - this.layout.graphTop,
    );
    context.clip();
    this.applyGraphCamera(context, deriveSceneDynamics(analysis, time));
    if (time >= 0.18) {
      const echoTime = time - 0.18;
      const echoFrame = frameAt(analysis, echoTime);
      const echoVisual = deriveVisualState(analysis, echoTime);
      const echoDynamics = deriveSceneDynamics(analysis, echoTime);
      const echoMotion = inertialMusicMotion(deriveMusicMotion(analysis, echoTime), echoDynamics);
      const echoEffects = deriveMusicEffects(echoMotion, this.config.visual.lowFlash, echoDynamics);
      const echo = createResonanceFilaments(this.echoPlan, echoFrame, echoVisual,
        this.layout, echoTime, this.config.visual.lowFlash, echoMotion);
      const opacity = smoothstep(0.18, 0.32, time) * (0.28 + effects.glow * 0.18);
      this.drawResonance(context, echo, echoFrame, echoVisual, echoTime, true, "back", echoMotion, echoEffects, opacity);
      this.drawResonance(context, echo, echoFrame, echoVisual, echoTime, true, "front", echoMotion, echoEffects, opacity);
    }
    this.drawResonance(context, filaments, frame, visual, time, true, "back", motion, effects);
    this.drawResonance(context, filaments, frame, visual, time, true, "front", motion, effects);
    context.save();
    context.globalAlpha = 0.12;
    this.drawVortexRings(context, rings, visual, choreography, true);
    this.drawRibbonEmission(context, ribbon, visual, choreography, time);
    context.restore();
    this.drawOnsetShockwaves(analysis, time, true, context);
    context.restore();
    context.setTransform(1, 0, 0, 1, 0, 0);
  }

  private applyGraphCamera(
    context: SKRSContext2D,
    dynamics: SceneDynamics,
  ): void {
    const matrix = sceneCameraMatrix(this.layout, dynamics, this.palettePhase * 0.01, this.ribbonPlan.direction);
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  }

  private drawResonance(
    context: SKRSContext2D,
    filaments: ResonanceFilament[],
    frame: AnalysisFrame,
    visual: VisualState,
    time: number,
    emission: boolean,
    pass: "back" | "front",
    motion: MusicMotion,
    effects: MusicEffects,
    opacity = 1,
  ): void {
    const radius = Math.min(
      this.layout.horizon - this.layout.graphTop,
      this.layout.graphBottom - this.layout.horizon,
      this.layout.width / 2,
    );
    const presence = (0.62 + frame.rms * 0.2 + visual.peak * 0.18) *
      this.config.visual.intensity;
    const hue = this.palettePhase + effects.hueShift + Math.sin(time * 0.045) * 14;
    const lightingStrength = this.config.visual.lighting ?? 0.65;
    const lights = lightingAt(motion, time, this.seed, this.palettePhase + effects.hueShift, this.config.visual.lowFlash, frame.spectrum, this.palette);
    const materialSample: MaterialSample = {r: 0, g: 0, b: 0, a: 1, nx: 0, ny: 0, nz: 1, roughness: 0.6, height: 0.5};
    const lightColor: Rgb = [0, 0, 0];
    const baseColor: Rgb = [0, 0, 0];
    const gradientStops = [
      [0, -35, 0.94, 0.7, 1], [0.3, -18, 0.98, 0.73, 1],
      [0.52, 28, 0.91, 0.7, 0.62], [0.76, 70, 0.96, 0.68, 1],
      [1, 110, 0.96, 0.76, 1],
    ] as const;
    const gradientColors: Rgb[] = gradientStops.map(() => [0, 0, 0]);
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    context.lineJoin = "round";
    for (let strand = 0; strand < filaments.length; strand += 1) {
      const filament = filaments[strand]!;
      const alpha = clamp(filament.alpha * presence * 2.3 * opacity);
      const offset = filament.hueOffset * 0.18;
      for (let stop = 0; stop < gradientStops.length; stop += 1) {
        const [, hueOffset, saturation, lightness] = gradientStops[stop]!;
        paletteRgb(this.palette, hue + hueOffset + offset - this.palettePhase, saturation * 100, lightness * 100, gradientColors[stop]!);
      }
      context.lineWidth = emission
        ? Math.max(1.8, radius * (0.014 + frame.mid * 0.005))
        : Math.max(0.45, radius * 0.0046) * (strand % 7 === 0 ? 1.7 : 0.85);
      // Short continuous runs allow depth and local spectrum to shade the
      // surface smoothly, including where strands cross the front/back plane.
      const runLength = 10;
      for (let start = 0; start < filament.points.length - 1; start += runLength) {
        const end = Math.min(start + runLength, filament.points.length - 1);
        const middle = filament.points[Math.floor((start + end) / 2)]!;
        // Project onto the original diagonal gradient, then interpolate its
        // actual RGB/alpha stops. Zero and positive lighting share this base.
        const gradientPosition = clamp(((middle.x - this.layout.centerX + radius) * 2
          + (middle.y - this.layout.horizon + radius * 0.7) * 1.55)
          / Math.max(1e-9, radius * (4 + 1.55 ** 2)));
        let lower = 0;
        while (lower < gradientStops.length - 2 && gradientPosition > gradientStops[lower + 1]![0]) lower += 1;
        const left = gradientStops[lower]!;
        const right = gradientStops[lower + 1]!;
        const amount = (gradientPosition - left[0]) / (right[0] - left[0]);
        for (let channel = 0; channel < 3; channel += 1) {
          baseColor[channel] = lerp(gradientColors[lower]![channel]!, gradientColors[lower + 1]![channel]!, amount);
        }
        let segmentAlpha = alpha * lerp(left[4], right[4], amount);
        if (lightingStrength > 0) {
          sampleResonanceMaterial(this.material, filaments, strand, Math.floor((start + end) / 2), materialSample);
          shadeSurface(lights, middle.surfaceX, middle.surfaceY, middle.surfaceZ, materialSample, lightColor);
          const lightness = lightColor[0] * 0.2126 + lightColor[1] * 0.7152 + lightColor[2] * 0.0722;
          const shade = lerp(1, 0.62 + lightness * 1.15, lightingStrength);
          baseColor[0] = clamp(baseColor[0] * shade + Math.sqrt(lightColor[0]) * lightingStrength * 0.13);
          baseColor[1] = clamp(baseColor[1] * shade + Math.sqrt(lightColor[1]) * lightingStrength * 0.13);
          baseColor[2] = clamp(baseColor[2] * shade + Math.sqrt(lightColor[2]) * lightingStrength * 0.13);
          segmentAlpha *= lerp(1, 0.82 + materialSample.height * 0.32, lightingStrength);
        }
        context.strokeStyle = `rgba(${Math.round(baseColor[0] * 255)},${Math.round(baseColor[1] * 255)},${Math.round(baseColor[2] * 255)},${clamp(segmentAlpha)})`;
        context.globalAlpha = (0.12 + smoothstep(0.18, 0.82, middle.depth) * 0.88) *
          (0.5 + middle.energy * 0.7);
        context.beginPath();
        let connected = false;
        for (let index = start; index < end; index += 1) {
          const point = filament.points[index]!;
          const next = filament.points[index + 1]!;
          const front = (point.depth + next.depth) * 0.5 >= 0.5;
          if (front !== (pass === "front")) {
            connected = false;
            continue;
          }
          if (!connected) context.moveTo(point.x, point.y);
          context.lineTo(next.x, next.y);
          connected = true;
        }
        context.stroke();
      }
      context.globalAlpha = 1;
      if (!emission && pass === "front" && strand % 3 === 0) {
        // Analytic tracers glide along the field; their brightness follows
        // local spectrum energy without depending on previously drawn frames.
        const count = filament.points.length - 1;
        const phase = ((motion.fastTime * 0.16 + strand * 0.137) % 1 + 1) % 1;
        const position = phase * count;
        const point = filament.points[Math.floor(position)]!;
        const next = filament.points[(Math.floor(position) + 1) % count]!;
        if (point.depth < 0.5) continue;
        const x = lerp(point.x, next.x, position % 1);
        const y = lerp(point.y, next.y, position % 1);
        context.fillStyle = this.color(hue + offset, 66, 91,
          (0.28 + point.energy * 0.65) * presence);
        context.beginPath();
        context.arc(x, y, Math.max(0.65, radius * 0.005), 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  private drawSupernovas(
    context: SKRSContext2D,
    events: SupernovaEvent[],
    effects: MusicEffects,
    emission: boolean,
  ): void {
    const radius = Math.min(this.layout.width * 0.4,
      this.layout.horizon - this.layout.graphTop,
      this.layout.graphBottom - this.layout.horizon);
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    for (const event of events) {
      const nova = event.kind === "nova";
      const strength = event.strength * this.config.visual.intensity;
      const hue = this.palettePhase + effects.hueShift + (event.hue - 180) * 0.16;
      const x = this.layout.centerX + event.originX * radius;
      const y = this.layout.horizon + event.originY * radius;
      const reach = radius * event.expansion;
      context.save();
      context.translate(x, y);

      if (emission) {
        // Expanding colored gas outlives the impact. It is rendered at quarter
        // resolution and passes through the same optical bloom as the sculpture.
        const glowRadius = radius * ((nova ? 0.3 : 0.16) + event.expansion * 1.15);
        const glow = context.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
        glow.addColorStop(0, this.color(hue + 70, 98, 75,
          strength * (event.flash * 0.8 + event.afterglow * 0.12)));
        glow.addColorStop(0.23, this.color(hue + 35, 100, 56, strength * event.afterglow * 0.22));
        glow.addColorStop(0.65, this.color(hue - 24, 100, 42, strength * event.afterglow * 0.09));
        glow.addColorStop(1, this.color(hue - 45, 100, 30, 0));
        context.fillStyle = glow;
        context.fillRect(-glowRadius, -glowRadius, glowRadius * 2, glowRadius * 2);

        // Long ejecta cones widen and cool as the flash decays; they have no
        // rectangular graph clip, so large kicks can spill into the atmosphere.
        for (let ray = 0; ray < (nova ? 16 : 7); ray += 1) {
          const angle = event.angle + ray * 2.399963;
          const length = radius * (0.6 + event.expansion * (1.1 + (ray % 3) * 0.24));
          const alpha = strength * event.flare * (ray % 3 === 0 ? 0.23 : 0.1);
          context.save();
          context.rotate(angle);
          const beam = context.createLinearGradient(0, 0, length, 0);
          beam.addColorStop(0, this.color(hue + 65, 86, 86, alpha));
          beam.addColorStop(0.28, this.color(hue + 32, 100, 65, alpha * 0.7));
          beam.addColorStop(1, this.color(hue - 20, 100, 50, 0));
          context.fillStyle = beam;
          context.beginPath();
          context.moveTo(0, 0);
          context.lineTo(length, -length * 0.013);
          context.lineTo(length, length * 0.013);
          context.closePath();
          context.fill();
          context.restore();
        }
      } else {
        // Bright, thin fronts separate from the core, slow down, and fade.
        // Their oblique planes make the event read as a 3D shockwave.
        context.save();
        context.rotate(Math.sin(event.angle) * 0.38);
        for (let shell = 0; shell < (nova ? 2 : 1); shell += 1) {
          const r = Math.max(0.01, reach * (shell ? 0.78 : 1));
          const alpha = strength * event.afterglow * (shell ? 0.16 : 0.42);
          const front = context.createLinearGradient(-r, 0, r, 0);
          front.addColorStop(0, this.color(hue - 20, 100, 70, alpha));
          front.addColorStop(0.35, this.color(hue + 45, 100, 86, alpha * 0.35));
          front.addColorStop(0.7, this.color(hue + 110, 100, 72, alpha));
          front.addColorStop(1, this.color(hue + 60, 100, 75, alpha * 0.2));
          context.strokeStyle = front;
          context.lineWidth = Math.max(0.65, radius * (0.004 + event.flash * 0.009));
          context.beginPath();
          context.ellipse(0, 0, r * 1.4, r * (shell ? 0.63 : 0.46), shell * 0.55, 0, Math.PI * 2);
          context.stroke();
        }
        context.restore();

        // Analytic particle trails: seeking directly to any frame produces
        // exactly the same streak positions and decay as sequential rendering.
        for (let particle = 0; particle < (nova ? 42 : 15); particle += 1) {
          const angle = event.angle + particle * 2.399963;
          const speed = 0.55 + ((particle * 17) % 31) / 31;
          const distance = radius * (0.1 + event.expansion * speed);
          const tail = radius * (0.018 + event.flare * 0.14) * speed;
          const px = Math.cos(angle) * distance * 1.55;
          const py = Math.sin(angle) * distance * 0.85;
          const textClearance = smoothstep(this.layout.graphTop - this.height * 0.035,
            this.layout.graphTop + this.height * 0.08, y + py);
          const alpha = event.afterglow * strength * textClearance * (0.4 + (particle % 4) * 0.15);
          context.strokeStyle = this.color(hue + 80 - event.age * 45 + particle % 3 * 20, 95, 77, alpha);
          context.lineWidth = Math.max(0.55, radius * (particle % 7 === 0 ? 0.008 : 0.0035));
          context.beginPath();
          context.moveTo(px, py);
          context.lineTo(px - Math.cos(angle) * tail * 1.55, py - Math.sin(angle) * tail * 0.85);
          context.stroke();
        }

        // Diffraction flare: narrow white-hot axis, saturated halo, and faint
        // lens ghosts. Light decays faster than the expanding shockfront.
        context.save();
        context.rotate(Math.sin(event.angle) * 0.07);
        const length = radius * (nova ? 2.8 : 1.1) * (0.65 + event.flare * 0.35);
        const flareAlpha = clamp(strength * event.flare * 1.45);
        const beam = context.createLinearGradient(-length, 0, length, 0);
        beam.addColorStop(0, this.color(hue, 100, 65, 0));
        beam.addColorStop(0.3, this.color(hue, 100, 65, flareAlpha * 0.16));
        beam.addColorStop(0.48, this.color(hue + 50, 100, 82, flareAlpha * 0.6));
        beam.addColorStop(0.5, this.color(hue + 50, 50, 98, flareAlpha));
        beam.addColorStop(0.52, this.color(hue + 80, 100, 82, flareAlpha * 0.6));
        beam.addColorStop(0.7, this.color(hue + 80, 100, 65, flareAlpha * 0.16));
        beam.addColorStop(1, this.color(hue + 80, 100, 65, 0));
        context.fillStyle = beam;
        const thickness = Math.max(0.85, radius * (0.005 + event.flash * 0.015));
        context.fillRect(-length, -thickness / 2, length * 2, thickness);
        context.globalAlpha = 0.22;
        context.fillRect(-length, -thickness * 2, length * 2, thickness * 4);
        context.globalAlpha = 1;
        for (let ghost = 1; ghost <= (nova ? 3 : 1); ghost += 1) {
          context.fillStyle = this.color(hue + ghost * 32, 100, 65, flareAlpha * 0.045);
          context.beginPath();
          context.arc(length * (ghost * 0.19 - 0.48), 0,
            radius * (0.035 + ghost * 0.028), 0, Math.PI * 2);
          context.fill();
        }
        context.restore();

        const coreRadius = radius * (0.055 + event.flash * (nova ? 0.26 : 0.12));
        const coreLight = clamp(strength * event.flash * 2.2);
        const core = context.createRadialGradient(0, 0, 0, 0, 0, coreRadius);
        core.addColorStop(0, this.color(hue + 65, 35, 98, coreLight));
        core.addColorStop(0.13, this.color(hue + 65, 75, 89, coreLight * 0.8));
        core.addColorStop(0.4, this.color(hue + 45, 100, 66, coreLight * 0.35));
        core.addColorStop(1, this.color(hue, 100, 50, 0));
        context.fillStyle = core;
        context.fillRect(-coreRadius, -coreRadius, coreRadius * 2, coreRadius * 2);
      }
      context.restore();
    }
    context.restore();
  }

  private drawFastOrbiters(frame: AnalysisFrame, motion: MusicMotion, effects: MusicEffects): void {
    const context = this.context;
    const radius = Math.min(this.layout.width * 0.42,
      this.layout.horizon - this.layout.graphTop,
      this.layout.graphBottom - this.layout.horizon) * 0.69;
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    if (motion.bassPulse > 0.06) {
      const expansion = 0.7 + (1 - motion.bassPulse) * 0.35;
      const alpha = motion.bassPulse * (this.config.visual.lowFlash ? 0.17 : 0.3) *
        this.config.visual.intensity;
      const gradient = context.createLinearGradient(
        this.layout.centerX - radius, this.layout.horizon,
        this.layout.centerX + radius, this.layout.horizon,
      );
      gradient.addColorStop(0, this.color(this.palettePhase + effects.hueShift - 20, 100, 78, alpha));
      gradient.addColorStop(0.5, this.color(this.palettePhase + effects.hueShift + 30, 100, 87, alpha * 0.4));
      gradient.addColorStop(1, this.color(this.palettePhase + effects.hueShift + 70, 100, 78, alpha));
      context.strokeStyle = gradient;
      context.lineWidth = Math.max(0.75, radius * (0.003 + motion.bassPulse * 0.005));
      context.beginPath();
      context.ellipse(this.layout.centerX, this.layout.horizon,
        radius * 1.78 * expansion, radius * 0.87 * expansion, 0, 0, Math.PI * 2);
      context.stroke();
    }
    for (let orbit = 0; orbit < 12; orbit += 1) {
      const bandPosition = orbit / 11;
      const band = Math.round(bandPosition * (frame.spectrum.length - 1));
      const response = frequencyResponse(frame.spectrum[band] ?? 0, bandPosition);
      const direction = orbit % 2 ? -1 : 1;
      const angle = this.ribbonPlan.phase + orbit * 2.39996 +
        motion.fastTime * (0.38 + bandPosition * 0.26) * direction;
      const reach = 0.72 + (orbit % 4) * 0.07 + response * 0.12;
      const alpha = (0.12 + motion.sustain * 0.24 + response * 0.4) *
        this.config.visual.intensity;
      const hue = this.palettePhase + effects.hueShift + bandPosition * 90;
      for (let tail = 0; tail < 12; tail += 1) {
        const u = angle - direction * tail * 0.019;
        const v = u - direction * 0.023;
        context.strokeStyle = this.color(hue, 94, 79, alpha * (1 - tail / 12) ** 1.7);
        context.lineWidth = Math.max(0.6, radius * (0.003 + response * 0.006));
        context.beginPath();
        context.moveTo(this.layout.centerX + Math.cos(u) * radius * reach * 1.62,
          this.layout.horizon + Math.sin(u) * radius * reach * 0.73);
        context.lineTo(this.layout.centerX + Math.cos(v) * radius * reach * 1.62,
          this.layout.horizon + Math.sin(v) * radius * reach * 0.73);
        context.stroke();
      }
      context.fillStyle = this.color(hue, 65, 93, alpha);
      context.beginPath();
      context.arc(this.layout.centerX + Math.cos(angle) * radius * reach * 1.62,
        this.layout.horizon + Math.sin(angle) * radius * reach * 0.73,
        Math.max(0.8, radius * (0.005 + response * 0.006)), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  private drawStardust(frame: AnalysisFrame, visual: VisualState, time: number): void {
    const context = this.context;
    const unit = Math.min(this.width, this.height) / 1080;
    context.save();
    context.globalCompositeOperation = "screen";
    for (const dust of this.stardust) {
      const depth = 0.2 + dust.depth * 0.8;
      const x = dust.x * this.width + Math.sin(time * 0.035 + dust.phase) *
        this.width * 0.012 * depth;
      const y = dust.y * this.height + Math.cos(time * 0.028 + dust.phase) *
        this.height * 0.018 * depth;
      const energy = frame.spectrum[dust.band] ?? 0;
      const twinkle = 0.7 + Math.sin(time * 0.65 + dust.phase) * 0.3;
      const alpha = (0.055 + depth ** 3 * 0.3) * twinkle *
        (0.7 + energy * 0.5) * this.config.visual.intensity;
      context.fillStyle = this.color(this.palettePhase + dust.phase * 12, 45, 82, alpha);
      const size = Math.max(0.35, dust.size * unit * (0.55 + depth));
      context.fillRect(x, y, size, size);
    }

    // Long, faint field lines carry the eye beyond the central sculpture.
    // Their transverse displacement responds to the sustained musical bed.
    for (let lane = 0; lane < 18; lane += 1) {
      const p = lane / 17;
      const drift = Math.sin(time * 0.06 + p * 2.3) * 0.045;
      const alpha = (0.012 + frame.mid * 0.012 + visual.drive * 0.012) *
        Math.sin(p * Math.PI) * this.config.visual.intensity;
      const gradient = context.createLinearGradient(0, this.height, this.width, 0);
      gradient.addColorStop(0, this.color(this.palettePhase, 88, 55, 0));
      gradient.addColorStop(0.35, this.color(this.palettePhase - 20, 90, 61, alpha));
      gradient.addColorStop(0.65, this.color(this.palettePhase + 65, 90, 63, alpha));
      gradient.addColorStop(1, this.color(this.palettePhase + 80, 90, 55, 0));
      context.strokeStyle = gradient;
      context.lineWidth = Math.max(0.5, unit * 1.2);
      context.beginPath();
      context.moveTo(-this.width * 0.1, this.height * (0.88 + p * 0.25));
      context.bezierCurveTo(
        this.width * 0.25, this.height * (0.18 + p * 0.35 + drift),
        this.width * 0.64, this.height * (1.05 - p * 0.32 - drift),
        this.width * 1.1, -this.height * (0.12 + p * 0.18),
      );
      context.stroke();
    }
    context.restore();
  }

  private drawDepthGlints(
    frame: AnalysisFrame,
    time: number,
    visual: VisualState,
    choreography: Choreography,
  ): void {
    const context = this.context;
    const presence = 0.42 + choreography.layers.stars * 0.58;
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";

    for (const glint of this.glints) {
      const pose = depthGlintPose(
        glint,
        frame,
        visual,
        time,
        this.width,
        this.height,
        this.layout,
        this.config.visual.lowFlash,
        this.config.visual.intensity * presence,
      );
      const alpha = clamp(
        pose.alpha * 1.72 + pose.depth ** 1.4 * presence * 0.011,
        0,
        0.68,
      );
      if (alpha < 0.006) continue;
      if (
        pose.x < -pose.size * 3 ||
        pose.x > this.width + pose.size * 3 ||
        pose.y < -pose.size * 3 ||
        pose.y > this.height + pose.size * 3
      ) {
        continue;
      }

      const hue = this.palettePhase + pose.hue + time * 0.45;
      if (pose.trail > 0.12) {
        context.strokeStyle = this.color(
          hue,
          94,
          74,
          alpha * pose.trail * 0.42,
        );
        context.lineWidth = Math.max(0.45, pose.size * 0.45);
        context.beginPath();
        context.moveTo(pose.trailX, pose.trailY);
        context.lineTo(pose.x, pose.y);
        context.stroke();
      }

      context.fillStyle = this.color(hue, 94, 84, alpha);
      context.beginPath();
      context.arc(
        pose.x,
        pose.y,
        Math.max(0.4, pose.size * 0.78),
        0,
        Math.PI * 2,
      );
      context.fill();

      const crossPresence =
        smoothstep(0.28, 0.52, pose.energy) *
        smoothstep(0.5, 0.7, pose.depth);
      if (crossPresence > 0.01) {
        const cross = pose.size * (1.8 + pose.energy);
        context.strokeStyle = this.color(
          hue + 18,
          100,
          88,
          alpha * 0.46 * crossPresence,
        );
        context.lineWidth = Math.max(0.35, pose.size * 0.22);
        context.beginPath();
        context.moveTo(pose.x - cross, pose.y);
        context.lineTo(pose.x + cross, pose.y);
        context.moveTo(pose.x, pose.y - cross * 0.64);
        context.lineTo(pose.x, pose.y + cross * 0.64);
        context.stroke();
      }
    }
    context.restore();
  }

  private drawVortexRings(
    context: SKRSContext2D,
    rings: VortexRingPose[],
    visual: VisualState,
    choreography: Choreography,
    emission: boolean,
  ): void {
    const presence =
      (0.2 + choreography.layers.tunnel * 0.8) *
      (0.78 + choreography.layers.spiral * 0.22) *
      (0.58 + choreography.layers.halo * 0.42);
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";

    for (const ring of rings) {
      const alpha =
        ring.alpha *
        presence *
        this.config.visual.intensity *
        (emission ? 1.45 : 0.96);
      if (alpha < 0.002) continue;
      const hue = this.palettePhase + ring.hue;
      context.lineWidth = ring.lineWidth * (emission ? 4.6 : 0.72);
      const breakMix = emission
        ? 0
        : smoothstep(0.26, 0.48, visual.peak) *
          smoothstep(0.36, 0.58, ring.depth);

      if (breakMix < 0.98) {
        context.strokeStyle = this.color(
          hue,
          96,
          emission ? 62 : 72,
          alpha * (1 - breakMix * 0.72),
        );
        context.beginPath();
        context.ellipse(
          ring.x,
          ring.y,
          ring.radiusX,
          ring.radiusY,
          Math.sin(ring.lane * 7) * 0.08,
          0,
          Math.PI * 2,
        );
        context.stroke();
      }

      if (breakMix > 0.01) {
        context.strokeStyle = this.color(hue + 18, 98, 76, alpha * breakMix);
        const phase = ring.lane * Math.PI * 2;
        for (let arc = 0; arc < 3; arc += 1) {
          const start = phase + arc * (Math.PI * 2 / 3) + 0.16;
          context.beginPath();
          context.ellipse(
            ring.x,
            ring.y,
            ring.radiusX,
            ring.radiusY,
            Math.sin(ring.lane * 7) * 0.08,
            start,
            start + Math.PI * 0.43,
          );
          context.stroke();
        }
      }
    }
    context.restore();
  }

  private drawRibbonEmission(
    context: SKRSContext2D,
    points: RibbonPoint[],
    visual: VisualState,
    choreography: Choreography,
    time: number,
  ): void {
    const presence = 0.22 + choreography.layers.spiral * 0.78;
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    context.lineJoin = "round";

    for (let index = 0; index < points.length - 1; index += 1) {
      const point = points[index];
      const next = points[index + 1];
      if (!point || !next) continue;
      const alpha =
        (0.08 + point.emission * 0.19 + visual.peak * 0.08) *
        presence *
        this.config.visual.intensity;
      context.strokeStyle = this.color(
        this.palettePhase + point.hue + time * 0.42,
        100,
        62,
        alpha,
      );
      context.lineWidth = Math.max(
        2,
        (point.halfWidth + next.halfWidth) * (3.1 + visual.peak * 0.8),
      );
      context.beginPath();
      context.moveTo(point.x, point.y);
      context.lineTo(next.x, next.y);
      context.stroke();
    }
    context.restore();
  }

  private drawRibbonMesh(
    context: SKRSContext2D,
    points: RibbonPoint[],
    visual: VisualState,
    choreography: Choreography,
    time: number,
    pass: "back" | "front",
  ): void {
    const presence = 0.22 + choreography.layers.spiral * 0.78;
    context.save();
    context.globalCompositeOperation = pass === "front" ? "screen" : "source-over";
    context.lineJoin = "round";

    for (let index = 0; index < points.length - 1; index += 1) {
      const point = points[index];
      const next = points[index + 1];
      if (!point || !next) continue;
      const front = point.front || next.front;
      if ((pass === "front") !== front) continue;

      const depth = (point.depth + next.depth) * 0.5;
      const energy = (point.energy + next.energy) * 0.5;
      const alpha =
        pass === "front"
          ? (0.26 + energy * 0.5 + visual.peak * 0.12) * presence
          : (0.08 + energy * 0.18) * presence;
      const lightness =
        pass === "front"
          ? 48 + depth * 27 + energy * 9
          : 24 + depth * 22 + energy * 7;
      const hue =
        this.palettePhase +
        (point.hue + next.hue) * 0.5 +
        time * 0.42;

      context.fillStyle = this.color(
        hue,
        pass === "front" ? 98 : 86,
        lightness,
        alpha * this.config.visual.intensity,
      );
      context.beginPath();
      context.moveTo(point.leftX, point.leftY);
      context.lineTo(next.leftX, next.leftY);
      context.lineTo(next.rightX, next.rightY);
      context.lineTo(point.rightX, point.rightY);
      context.closePath();
      context.fill();

      if (pass === "front") {
        context.strokeStyle = this.color(
          hue + 18,
          100,
          83,
          (0.18 + energy * 0.36) * presence,
        );
        context.lineWidth = Math.max(0.5, this.width / 2600);
        context.beginPath();
        context.moveTo(point.leftX, point.leftY);
        context.lineTo(next.leftX, next.leftY);
        context.stroke();
      }
    }
    context.restore();
  }

  private drawRibbonDetails(
    points: RibbonPoint[],
    frame: AnalysisFrame,
    visual: VisualState,
    choreography: Choreography,
    time: number,
  ): void {
    const context = this.context;
    const presence = 0.22 + choreography.layers.spiral * 0.78;
    const detailPresence = 0.38 + choreography.layers.waveform * 0.62;
    const first = points[0];
    if (!first) return;

    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      if (point) context.lineTo(point.x, point.y);
    }
    const gradient = context.createLinearGradient(
      this.layout.left,
      this.layout.horizon,
      this.layout.right,
      this.layout.horizon,
    );
    const spread = lerp(54, 276, visual.peak);
    for (let stop = 0; stop <= 8; stop += 1) {
      const progress = stop / 8;
      gradient.addColorStop(
        progress,
        this.color(
          this.palettePhase +
            this.ribbonPlan.hue +
            (progress - 0.5) * spread +
            time * 0.42,
          100,
          78,
          (0.38 + frame.rms * 0.22) * presence * detailPresence,
        ),
      );
    }
    context.strokeStyle = gradient;
    context.lineWidth =
      Math.max(0.9, this.width / 1350) *
      (1 + visual.peak * 0.3 + choreography.impact * 0.28);
    context.stroke();

    let nodes = 0;
    for (let index = 2; index < points.length - 2 && nodes < 7; index += 1) {
      const point = points[index];
      const previous = points[index - 1];
      const next = points[index + 1];
      if (
        !point ||
        !previous ||
        !next ||
        !point.front ||
        point.energy < 0.24 ||
        point.energy < previous.energy ||
        point.energy <= next.energy
      ) {
        continue;
      }
      const nodePresence = smoothstep(0.24, 0.5, point.energy);
      const alpha =
        (0.16 + point.energy * 0.45) *
        presence *
        detailPresence *
        nodePresence *
        this.config.visual.intensity;
      const radius =
        Math.max(0.7, this.width / 2200) *
        (0.7 + point.energy * 1.5 + visual.peak * 0.45);
      context.fillStyle = this.color(
        this.palettePhase + point.hue + time * 0.42,
        100,
        88,
        alpha,
      );
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      nodes += 1;
    }
    context.restore();
  }

  private drawSpectralFlares(
    points: RibbonPoint[],
    visual: VisualState,
    choreography: Choreography,
    time: number,
  ): void {
    const context = this.context;
    const radii = safeGraphRadii(this.layout);
    const modePresence = clamp(
      0.06 +
        choreography.layers.tunnel * 0.34 +
        visual.peak * 0.5 +
        choreography.impact * 0.18,
    );
    const step = Math.max(8, Math.floor(points.length / 11));

    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    for (let index = step; index < points.length; index += step) {
      const point = points[index];
      if (!point || point.progress < 0.2) continue;
      const spectralPresence = smoothstep(0.14, 0.62, point.energy);
      const depthPresence = smoothstep(0.42, 0.68, point.depth);
      const presence = spectralPresence * depthPresence * modePresence;
      if (presence < 0.012) continue;

      const direction = point.angle + point.waveform * 0.08;
      const length =
        (0.018 + point.energy * 0.072) *
        (0.58 + visual.peak * 0.58 + choreography.impact * 0.35);
      const startX =
        point.x + Math.cos(direction) * radii.x * length * 0.08;
      const startY =
        point.y + Math.sin(direction) * radii.y * length * 0.08;
      const endX = point.x + Math.cos(direction) * radii.x * length;
      const endY = point.y + Math.sin(direction) * radii.y * length;
      const hue = this.palettePhase + point.hue + time * 0.42;
      const flare = context.createLinearGradient(startX, startY, endX, endY);
      flare.addColorStop(0, this.color(hue, 100, 90, 0.42 * presence));
      flare.addColorStop(0.35, this.color(hue + 18, 100, 76, 0.24 * presence));
      flare.addColorStop(1, this.color(hue + 42, 100, 62, 0));
      context.strokeStyle = flare;
      context.lineWidth =
        Math.max(0.5, this.width / 2100) *
        (0.72 + point.energy * 1.4 + visual.peak * 0.35);
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();
    }
    context.restore();
  }

  private recentOnsetEvents(
    analysis: AudioAnalysis,
    time: number,
    lifetime: number,
    limit: number,
  ): OnsetEvent[] {
    const events: OnsetEvent[] = [];
    for (const event of onsetEventsBetween(analysis, time - lifetime, time)) {
      if (event.strength < 0.11) continue;
      const frame = analysis.frames[event.index];
      if (!frame) continue;
      let dominantBand = 0;
      for (let band = 1; band < frame.spectrum.length; band += 1) {
        if ((frame.spectrum[band] ?? 0) > (frame.spectrum[dominantBand] ?? 0)) {
          dominantBand = band;
        }
      }
      events.push({
        index: event.index,
        age: Math.max(0, time - event.time),
        strength: event.strength,
        dominantRatio: dominantBand / Math.max(1, frame.spectrum.length - 1),
      });
    }
    return events.slice(-limit);
  }

  private drawOnsetSparks(analysis: AudioAnalysis, visual: VisualState, time: number): void {
    const context = this.context;
    const radius = Math.min(this.layout.width * 0.38,
      (this.layout.graphBottom - this.layout.graphTop) * 0.46);
    context.save();
    context.globalCompositeOperation = "screen";
    context.lineCap = "round";
    for (const event of this.recentOnsetEvents(analysis, time, 1.3, 4)) {
      const random = createRandom(deriveSeed(this.seed, "sparks:" + event.index));
      const progress = event.age / 1.3;
      const strength = visualTransient(event.strength, this.config.visual.lowFlash);
      const envelope = smoothstep(0, 0.06, event.age) * (1 - progress) ** 2;
      for (let spark = 0; spark < 16; spark += 1) {
        const angle = random() * Math.PI * 2;
        const reach = 0.65 + random() * 0.26;
        const travel = reach + progress * (0.16 + random() * 0.18);
        const x = this.layout.centerX + Math.cos(angle) * radius * travel * 1.65;
        const y = this.layout.horizon + Math.sin(angle) * radius * travel * 0.8;
        const length = radius * (0.008 + progress * 0.012) * (0.6 + visual.peak);
        context.strokeStyle = this.color(this.palettePhase + spark * 6, 86, 86,
          envelope * strength * 1.7 * this.config.visual.intensity);
        context.lineWidth = Math.max(0.5, radius * 0.004);
        context.beginPath();
        context.moveTo(x - Math.cos(angle) * length, y - Math.sin(angle) * length * 0.6);
        context.lineTo(x, y);
        context.stroke();
      }
    }
    context.restore();
  }

  private drawOnsetBeams(
    context: SKRSContext2D,
    analysis: AudioAnalysis,
    time: number,
    visual: VisualState,
    choreography: Choreography,
  ): void {
    const events = this.recentOnsetEvents(analysis, time, 0.82, 2);
    const centerX = this.layout.centerX;
    const centerY = this.layout.horizon;
    const length = Math.max(this.width, this.height) * 0.92;

    context.save();
    context.globalCompositeOperation = "screen";
    for (const event of events) {
      const progress = clamp(event.age / 0.82);
      const random = createRandom(
        deriveSeed(this.seed, "beam:" + event.index),
      );
      const direction =
        event.dominantRatio * Math.PI * 2 -
        Math.PI * 0.9 +
        randomBetween(random, -0.28, 0.28);
      const endX = centerX + Math.cos(direction) * length;
      const endY = centerY + Math.sin(direction) * length;
      const normalX = -Math.sin(direction);
      const normalY = Math.cos(direction);
      const width =
        this.height *
        randomBetween(random, 0.035, 0.072) *
        (0.6 + visual.peak * 0.55);
      const cappedStrength = visualTransient(
        event.strength,
        this.config.visual.lowFlash,
      );
      const alpha =
        cappedStrength *
        (this.config.visual.lowFlash
          ? smoothstep(0, 0.075, event.age)
          : 1) *
        (1 - progress) *
        (0.16 + choreography.layers.tunnel * 0.12) *
        this.config.visual.intensity;
      const hue =
        this.palettePhase +
        this.ribbonPlan.hue +
        event.dominantRatio * lerp(68, 250, visual.peak);
      const beam = context.createLinearGradient(
        centerX,
        centerY,
        endX,
        endY,
      );
      beam.addColorStop(0, this.color(hue, 100, 76, 0));
      beam.addColorStop(0.16, this.color(hue, 100, 72, alpha));
      beam.addColorStop(0.72, this.color(hue + 34, 100, 58, alpha * 0.24));
      beam.addColorStop(1, this.color(hue + 54, 100, 54, 0));
      context.fillStyle = beam;
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.lineTo(
        endX + normalX * width * (0.45 + progress),
        endY + normalY * width * (0.45 + progress),
      );
      context.lineTo(
        endX - normalX * width * (0.45 + progress),
        endY - normalY * width * (0.45 + progress),
      );
      context.closePath();
      context.fill();
    }
    context.restore();
  }

  private drawOnsetShockwaves(
    analysis: AudioAnalysis,
    time: number,
    emission: boolean,
    target: SKRSContext2D = this.context,
  ): void {
    const events = this.recentOnsetEvents(analysis, time, 0.86, 2);
    const radii = safeGraphRadii(this.layout);
    target.save();
    target.globalCompositeOperation = "screen";
    for (const event of events) {
      const progress = clamp(event.age / 0.86);
      const eased = 1 - (1 - progress) ** 3;
      const strength = visualTransient(
        event.strength,
        this.config.visual.lowFlash,
      );
      const hue =
        this.palettePhase +
        this.ribbonPlan.hue +
        event.dominantRatio * 240 +
        event.age * 18;
      const alpha =
        strength *
        (this.config.visual.lowFlash
          ? smoothstep(0, 0.075, event.age)
          : 1) *
        (1 - progress) *
        (emission ? 0.34 : 0.22) *
        this.config.visual.intensity;
      target.strokeStyle = this.color(hue, 100, emission ? 64 : 82, alpha);
      target.lineWidth =
        Math.max(0.65, this.width / 1700) *
        (emission ? 6 : 1) *
        (1 - progress * 0.55);
      target.beginPath();
      target.ellipse(
        this.layout.centerX,
        this.layout.horizon,
        radii.x * (0.13 + eased * 0.86),
        radii.y * (0.1 + eased * 0.82),
        0,
        0,
        Math.PI * 2,
      );
      target.stroke();
    }
    target.restore();
  }

  private drawTypography(
    time: number,
    grade: DynamicGrade,
  ): void {
    const title = this.config.text.title
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim();
    const artist = this.config.text.artist
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim();
    if (!title && !artist) return;

    const context = this.context;
    const safeY = this.layout.titleY;
    const alpha = smoothstep(0.08, 0.65, time);
    const rise = lerp(this.height * 0.004, 0, smoothstep(0.08, 0.65, time));

    context.save();
    context.beginPath();
    context.rect(
      this.layout.textLeft,
      this.layout.top,
      this.layout.textWidth,
      this.layout.graphTop - this.layout.top,
    );
    context.clip();
    context.globalAlpha = alpha;
    context.filter = "none";
    context.shadowColor = "rgba(0,0,0,0.82)";
    context.shadowBlur = Math.min(6, this.width * 0.0032);
    context.textBaseline = "top";

    const textBoxHeight = this.layout.graphTop - safeY;
    const baseTitleSize = Math.min(
      this.width * 0.09,
      this.height * 0.09,
      textBoxHeight / (title && artist ? 1.84 : 1.14),
    );
    const titleGradient = context.createLinearGradient(
      0,
      safeY,
      0,
      safeY + baseTitleSize * 1.25,
    );
    titleGradient.addColorStop(0, this.color(this.palettePhase, 12, 99, 0.98));
    titleGradient.addColorStop(
      1,
      this.color(
        this.palettePhase + this.ribbonPlan.hue + grade.hueShift,
        18,
        94,
        1,
      ),
    );
    context.fillStyle = titleGradient;
    if (this.artwork?.thumbnail) {
      this.drawCoverCredits(this.artwork.thumbnail, title, artist, baseTitleSize, safeY + rise);
      context.restore();
      return;
    }
    const titleSize = this.drawFittedText(
      context,
      title,
      "600",
      "sans-serif",
      baseTitleSize,
      baseTitleSize * 0.015,
      safeY + rise,
    );

    if (artist) {
      context.filter = "none";
      context.shadowBlur = Math.min(4, this.width * 0.0022);
      context.fillStyle = this.color(this.palettePhase + 72, 16, 96, 0.96);
      const artistY = title ? safeY + rise + titleSize * 1.12 : safeY + rise;
      this.drawFittedText(
        context,
        artist,
        "500",
        "sans-serif",
        baseTitleSize * 0.62,
        baseTitleSize * 0.025,
        artistY,
      );
    }
    context.restore();
  }

  private drawCoverCredits(
    thumbnail: Canvas,
    title: string,
    artist: string,
    baseSize: number,
    top: number,
  ): void {
    const context = this.context;
    const smallSide = Math.min(this.width, this.height);
    let coverSize = Math.min(smallSide * 0.13, (this.layout.graphTop - this.layout.titleY) * 0.94);
    const gap = smallSide * 0.023;
    let available = this.layout.textWidth * 0.92 - coverSize - gap;
    context.textAlign = "left";
    context.textBaseline = "alphabetic";

    const measure = (text: string, weight: string, size: number, spacing: number) => {
      context.font = `${weight} ${size}px sans-serif`;
      context.letterSpacing = `${spacing}px`;
      let metrics = context.measureText(text);
      const scale = Math.min(1, available / Math.max(1, metrics.width));
      size *= scale;
      spacing *= scale;
      const font = `${weight} ${size}px sans-serif`;
      const letterSpacing = `${spacing}px`;
      context.font = font;
      context.letterSpacing = letterSpacing;
      metrics = context.measureText(text);
      return {
        text, font, letterSpacing, size,
        width: Math.max(0, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight),
        height: text ? metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent : 0,
        left: metrics.actualBoundingBoxLeft,
        ascent: metrics.actualBoundingBoxAscent,
      };
    };
    const measureLines = () => {
      const titleLine = measure(title, "600", baseSize, baseSize * 0.015);
      const artistSize = title ? Math.min(baseSize * 0.62, titleLine.size * 0.72) : baseSize * 0.62;
      const artistLine = measure(artist, "500", artistSize, artistSize * 0.025 / 0.62);
      const lineGap = title && artist ? titleLine.size * 0.18 : 0;
      return { titleLine, artistLine, lineGap, textHeight: titleLine.height + lineGap + artistLine.height };
    };
    // The cover spans both visible text lines with a little breathing room.
    // Refit once after reserving its height so wide labels still stay safe.
    coverSize = Math.max(coverSize, measureLines().textHeight * 1.06);
    available = Math.max(1, this.layout.textWidth * 0.92 - coverSize - gap);
    const { titleLine, artistLine, lineGap, textHeight } = measureLines();
    const groupHeight = Math.max(coverSize, textHeight);
    const textWidth = Math.max(titleLine.width, artistLine.width);
    const left = this.layout.textCenterX - (coverSize + gap + textWidth) / 2;
    const coverTop = top + (groupHeight - coverSize) / 2;
    const textTop = top + (groupHeight - textHeight) / 2;
    const textLeft = left + coverSize + gap;
    const radius = coverSize * 0.14;
    // Tall accents and the entrance rise must fit too. Scale the complete
    // group so its center and the cover/text proportions stay intact.
    const fit = Math.min(1, Math.max(1, this.layout.graphTop - top - smallSide * 0.002) / groupHeight);
    context.translate(this.layout.textCenterX, top);
    context.scale(fit, fit);
    context.translate(-this.layout.textCenterX, -top);

    context.save();
    context.shadowColor = "rgba(0,0,0,0.82)";
    const finalCoverTop = top + (coverTop - top) * fit;
    const shadowRoom = Math.max(0, Math.min(
      finalCoverTop - this.layout.top,
      this.layout.graphTop - finalCoverTop - coverSize * fit,
    ));
    context.shadowBlur = Math.min(smallSide * 0.011 * fit, shadowRoom * 0.7);
    context.shadowOffsetY = Math.min(smallSide * 0.003 * fit, shadowRoom * 0.2);
    context.beginPath();
    context.roundRect(left, coverTop, coverSize, coverSize, radius);
    context.fillStyle = "rgba(0,0,0,0.9)";
    context.fill();
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
    context.clip();
    context.drawImage(thumbnail, left, coverTop, coverSize, coverSize);
    context.strokeStyle = this.color(this.palettePhase, 12, 96, 0.16);
    context.lineWidth = smallSide / 1080;
    context.stroke();
    context.restore();

    const drawLine = (line: typeof titleLine, y: number) => {
      if (!line.text) return;
      context.font = line.font;
      context.letterSpacing = line.letterSpacing;
      context.fillText(line.text, textLeft + line.left, y + line.ascent);
    };
    drawLine(titleLine, textTop);
    context.shadowBlur = Math.min(4, this.width * 0.0022);
    context.fillStyle = this.color(this.palettePhase + 72, 16, 96, 0.96);
    drawLine(artistLine, textTop + titleLine.height + lineGap);
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
    context.font = weight + " " + size + "px " + family;
    context.letterSpacing = spacing + "px";
    const initialWidth = context.measureText(text).width;
    const scale = Math.min(
      1,
      (this.layout.textWidth * 0.92) / Math.max(1, initialWidth),
    );
    size = Math.max(0.1, size * scale);
    spacing *= scale;
    context.font = weight + " " + size + "px " + family;
    context.letterSpacing = spacing + "px";
    context.textAlign = "center";
    context.fillText(text, this.layout.textCenterX, y);
    return size;
  }

  private drawPostEffects(
    frameIndex: number,
    grade: DynamicGrade,
    visual: VisualState,
  ): void {
    const context = this.context;

    if (this.config.visual.vignette > 0) {
      const centerX =
        this.width / 2 +
        (this.layout.centerX - this.width / 2) * 0.22;
      const centerY =
        this.height / 2 +
        (this.layout.horizon - this.height / 2) * 0.18;
      const vignette = context.createRadialGradient(
        centerX,
        centerY,
        Math.min(this.width, this.height) * 0.16,
        centerX,
        centerY,
        Math.max(this.width, this.height) * 0.72,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(0.58, "rgba(0,0,0,0.025)");
      vignette.addColorStop(
        1,
        "rgba(0,0,0," +
          this.config.visual.vignette *
            grade.vignetteScale *
            (1 - visual.peak * 0.06) +
          ")",
      );
      context.fillStyle = vignette;
      context.fillRect(0, 0, this.width, this.height);
    }

    if (this.config.visual.grain > 0) {
      const grainCadence = Math.max(
        1,
        Math.round(this.config.output.fps / 12),
      );
      const grain =
        this.grainCanvases[
          Math.floor(frameIndex / grainCadence) % this.grainCanvases.length
        ];
      if (grain) {
        context.save();
        context.globalAlpha =
          this.config.visual.grain * grade.grainScale;
        context.globalCompositeOperation = "overlay";
        context.imageSmoothingEnabled = false;
        context.drawImage(grain, 0, 0, this.width, this.height);
        context.restore();
      }
    }
  }
}
