import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { frameAt } from "../audio/analyze.js";
import { deriveMusicMotion, type MusicMotion } from "./music-motion.js";
import { HIT_LIFETIME, type HitEvent, hitEventsAt, hitRingAlpha, hitRingReach, hitVariation } from "./hit-plan.js";
import { momentumFromHits, momentumKernel, MOMENTUM_TAU, type Momentum } from "./momentum.js";
import { smoothedFrameAt } from "./audio-field.js";
import { FrozenCloudLayer } from "./frozen-cloud-layer.js";
import { artworkCameraAt, drawArtwork, type ArtworkDrawOptions, type PreparedArtwork } from "./artwork.js";
import { createEmberPlan, drawEmbers, type Ember, type EmberDrive } from "./ember-bokeh.js";
import { createMaterial, recolorMaterial, type MaterialMap, type MaterialSample } from "./material.js";
import { lightingAt, shadeSurface, type LightingState, type Rgb } from "./lighting.js";
import { accentSwatches, liftSwatch, mixRgb, paletteCss, paletteRgb, randomPalette, rgbCss, swatchFamilyDirection, type ScenePalette } from "./palette.js";
import { MaterialLightLayer } from "./material-layer.js";
import { sampleResonanceMaterial } from "./surface-material.js";
import { drawMaterialSurface, type SurfaceCoverage } from "./surface-mesh.js";
import { SurfaceFragmentLayer, type FragmentSource } from "./surface-fragment-layer.js";
import { SpectralFlowLayer } from "./spectral-flow-layer.js";
import { deriveSceneDynamics, type SceneDynamics } from "./scene-dynamics.js";
import { drawAtmosphericBloom, inertialMusicMotion, ringReachWithin, sceneCameraAt, sceneCameraMatrix, sculptureFit, type SceneCameraPose } from "./scene-optics.js";
import { drawSignalBand, signalBandAt, type SignalBandFrame, type SignalStripStyle } from "./signal-strip.js";
import { deriveMusicEffects, type MusicEffects } from "./music-effects.js";
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
  deriveSectionLevel,
  deriveVisualState,
  presenceAt,
  type Choreography,
  type VisualState,
} from "./conductor.js";
import {
  createSafeLayout,
  safeGraphRadii,
  safeGraphRadius,
  type SafeLayout,
} from "./layout.js";
import {
  createResonancePlan,
  createResonanceFilaments,
  type ResonanceCamera,
  type ResonancePlan,
  type ResonanceFilament,
} from "./resonance.js";
import {
  createRibbonPlan,
  createSpectralRibbonPoints,
  deriveDynamicGrade,
  type DynamicGrade,
  type RibbonPlan,
  type RibbonPoint,
} from "./reactive-effects.js";

/**
 * Every music signal of one frame, derived once in render() and shared by
 * all layers so nothing is re-derived per pass. Captures (fragments, frozen
 * clouds) build their own for their capture time.
 */
interface FrameState {
  time: number;
  frame: AnalysisFrame;
  dynamics: SceneDynamics;
  /** Blended envelopes (inertialMusicMotion) that shape the sculpture. */
  motion: MusicMotion;
  /** The raw kick (one-frame attack): only the strip's lowest bars read it. */
  kick: number;
  /** The kept hits as smoothed pushes of different mass (see momentum.ts). */
  momentum: Momentum;
  section: number;
  presence: number;
  visual: VisualState;
  effects: MusicEffects;
  choreography: Choreography;
  grade: DynamicGrade;
  lights: LightingState;
  pose: ResonanceCamera;
  filaments: ResonanceFilament[];
  ribbon: RibbonPoint[];
  hits: HitEvent[];
  signalBand: SignalBandFrame;
}

/** Names of the render stages, in draw order, as reported to the profiler hook. */
export type RenderStage =
  | "signals" | "room" | "flow" | "emission" | "bloom" | "ghosts" | "composite" | "band" | "skin"
  | "filaments" | "hits" | "fragments" | "embers" | "post" | "dither" | "vignette" | "typography" | "readback";

/** Seconds until the title lockup has fully faded and risen into place. */
const TYPOGRAPHY_SETTLE = 0.65;

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
  private readonly ribbonPlan: RibbonPlan;
  private readonly resonancePlan: ResonancePlan;
  /** Cover-coloured bokeh on two parallax planes; the count is the config's bokehCount. */
  private readonly embers: Ember[];
  private readonly emberColors: Rgb[];
  private readonly width: number;
  private readonly height: number;
  private readonly backgroundWidth: number;
  private readonly backgroundHeight: number;
  private readonly config: ProjectConfig;
  private readonly seed: string;
  private readonly palettePhase: number;
  /** Ring phases of the cover's warm, cool and darkest pigments; feed them to color() directly. */
  private readonly warmPhase: number;
  private readonly coolPhase: number;
  private readonly darkPhase: number;
  /** Ring direction in which each accent's gradient may spread without leaving its pigment family. */
  private readonly warmDirection: 1 | -1;
  private readonly coolDirection: 1 | -1;
  private readonly signalStyle: SignalStripStyle;
  /** The warm and cool accents lifted to mid luma: the hit rings, the core burst and the grade share them. */
  private readonly warmPigment: Rgb;
  private readonly coolPigment: Rgb;
  /** The hit lift's colour: the warm pigment a third of the way to white. */
  private readonly liftPigment: Rgb;
  private readonly palette: ScenePalette;
  private readonly layout: SafeLayout;
  private readonly frozenClouds: FrozenCloudLayer;
  private readonly surfaceFragments: SurfaceFragmentLayer;
  private readonly spectralFlow: SpectralFlowLayer;
  private readonly material: MaterialMap;
  private readonly materialLight: MaterialLightLayer;
  private backgroundCacheKey = "";
  private backgroundCacheAnalysis: AudioAnalysis | undefined;
  /** The settled title lockup, painted once on first use (see drawTypography). */
  private typographySheet: Canvas | undefined;
  /**
   * Called after each stage of render() with the surface that stage drew to.
   * A no-op in production; a profiler flushes the surface (getImageData) to
   * time the stage, which never changes the pixels.
   */
  profiler: ((stage: RenderStage, surface: Canvas) => void) | undefined;

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
    const accents = accentSwatches(this.palette);
    const swatchStep = 360 / this.palette.colors.length;
    this.warmPhase = this.palettePhase + accents.warm * swatchStep;
    this.coolPhase = this.palettePhase + accents.cool * swatchStep;
    this.darkPhase = this.palettePhase + accents.darkest * swatchStep;
    this.warmDirection = swatchFamilyDirection(this.palette, accents.warm);
    this.coolDirection = swatchFamilyDirection(this.palette, accents.cool);
    this.signalStyle = { palette: this.palette,
      warm: { phase: this.warmPhase - this.palettePhase, direction: this.warmDirection },
      cool: { phase: this.coolPhase - this.palettePhase, direction: this.coolDirection } };
    this.warmPigment = liftSwatch(paletteRgb(this.palette, this.warmPhase - this.palettePhase), 0.5, 0);
    this.coolPigment = liftSwatch(paletteRgb(this.palette, this.coolPhase - this.palettePhase), 0.5, 0);
    this.liftPigment = liftSwatch(this.warmPigment, 0.5, 0.35);
    this.layout = createSafeLayout(this.width, this.height);
    this.frozenClouds = new FrozenCloudLayer(this.width, this.height, this.layout, this.seed);
    this.surfaceFragments = new SurfaceFragmentLayer(this.layout, this.seed);
    this.spectralFlow = new SpectralFlowLayer(this.width, this.height, this.layout, this.palette, this.seed, config.visual.lowFlash);
    const atmosphereMaterial = recolorMaterial(createMaterial(seed), this.palette);
    this.material = artwork?.objectMaterial ?? atmosphereMaterial;
    this.materialLight = new MaterialLightLayer(this.width, this.height, atmosphereMaterial, this.layout);

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
    this.ribbonPlan = createRibbonPlan(this.seed);
    this.resonancePlan = createResonancePlan(this.seed);
    this.embers = createEmberPlan(this.seed, this.config.visual.bokehCount);
    // Embers are the cover's own light: its bright saturated pixels, lifted to
    // read as light sources; the seeded palette's accents stand in without a cover.
    const emberSources = artwork?.emberColors?.length ? artwork.emberColors : [this.warmPigment, this.coolPigment];
    this.emberColors = emberSources.map((rgb) => liftSwatch(rgb, 0.55, 0));
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
      opacity: randomBetween(random, 0.14, 0.30),
      hueOffset: index % 2 === 0
        ? randomBetween(random, -18, 28)
        : randomBetween(random, 72, 118),
    }));
  }

  /**
   * A luminance dither, not a film-grain overlay: quarter-resolution white
   * sheets whose alpha is uniform in 0..1/4, added with `lighter` at the
   * grain amount, so each 4x4 block gains 0..grain*64 levels (0..1.9 at the
   * default 0.03) and the banding of the upscaled cover breaks without any
   * visible texture. Additive Porter-Duff at nearest-neighbour scale is the
   * one full-frame blend that costs ~3 ms; soft-light with smoothing was 18.
   * 13 seeded sheets cycle at 12 Hz, so the pattern never sits on one pixel.
   */
  private createGrainCanvases(): Canvas[] {
    const random = createRandom(deriveSeed(this.seed, "grain"));
    return Array.from({ length: 13 }, () => {
      const canvas = createCanvas(this.backgroundWidth, this.backgroundHeight);
      const context = canvas.getContext("2d");
      const image = context.createImageData(this.backgroundWidth, this.backgroundHeight);
      for (let index = 0; index < image.data.length; index += 4) {
        image.data[index] = 255;
        image.data[index + 1] = 255;
        image.data[index + 2] = 255;
        image.data[index + 3] = Math.round(randomBetween(random, 0, 64));
      }
      context.putImageData(image, 0, 0);
      return canvas;
    });
  }

  /**
   * Derives every signal of one frame from the cached analysis and absolute
   * time. Captures call it for their own capture time, so a fragment or a
   * frozen cloud carries the geometry, light and camera of that instant.
   */
  private frameState(analysis: AudioAnalysis, time: number): FrameState {
    // The sculpture, skin and lights read the smoothed spectrum (the strip's
    // envelopes), never the per-frame FFT; onset, loudness and waveform are raw.
    const frame = smoothedFrameAt(analysis, time);
    const dynamics = deriveSceneDynamics(analysis, time);
    const rawMotion = deriveMusicMotion(analysis, time);
    // The raw kick reaches only the strip. Everything with mass follows the
    // kept hits through kernels of different weight, and the surrounding
    // section sets the room, the camera and the sculpture's size.
    const kick = rawMotion.bassPulse;
    const hits = hitEventsAt(analysis, time);
    const momentum = momentumFromHits(hits);
    const section = deriveSectionLevel(analysis, time);
    const motion = inertialMusicMotion(rawMotion, dynamics, momentum.body, momentum.flick);
    const visual = deriveVisualState(analysis, time);
    const lowFlash = this.config.visual.lowFlash;
    const effects = deriveMusicEffects(motion, lowFlash, dynamics, visual.warmth);
    const choreography = deriveChoreography(visual, frame.onset, lowFlash);
    // The video begins and ends: the sculpture arrives over the first seconds
    // and steps back over the last, and everything but the room follows it.
    const presence = presenceAt(time, analysis.duration);
    const pose = this.cameraPose(dynamics, momentum.camera, section, presence);
    return {
      time, frame, dynamics, motion, kick, momentum, section, presence, visual, effects, choreography,
      grade: deriveDynamicGrade(visual, lowFlash),
      lights: lightingAt(motion, time, this.seed, this.palettePhase + effects.hueShift, lowFlash, frame.spectrum, this.palette),
      pose,
      filaments: createResonanceFilaments(this.resonancePlan, frame, visual, this.layout, time, lowFlash, motion, pose),
      ribbon: createSpectralRibbonPoints(frame, visual, this.layout, time, this.ribbonPlan, {
        lowFlash,
        samples: Math.max(144, this.config.visual.spectrumBands * 2),
        waveformScale: choreography.layers.waveform,
      }),
      hits,
      signalBand: signalBandAt(analysis, time, this.layout, this.height,
        { kick, section, treblePulse: rawMotion.treblePulse }),
    };
  }

  render(analysis: AudioAnalysis, time: number): Buffer {
    const state = this.frameState(analysis, time);
    const { frame, motion, momentum, section, presence, visual, pose, filaments, hits, signalBand, lights } = state;
    this.surfaceFragments.update(analysis, time, captureTime => this.captureFragmentSource(analysis, captureTime));
    const coverOptions = this.coverOptions(pose, section, momentum.push, presence);
    const coverCamera = this.artwork ? artworkCameraAt(this.artwork, time, coverOptions) : undefined;
    const pan = this.graphPan(pose);
    const emberDrive: EmberDrive = {
      time, dynamics: state.dynamics, section, kick: momentum.body, treblePulse: motion.treblePulse, bands: signalBand.levels,
      pan: { x: pan.x / this.width, y: pan.y / this.height },
      cover: { x: (coverCamera?.offsetX ?? 0) / this.width, y: (coverCamera?.offsetY ?? 0) / this.height },
      layout: this.layout, width: this.width, height: this.height,
      gain: this.config.visual.intensity * this.bandPresence(presence),
    };
    this.profiler?.("signals", this.canvas);

    resetContext(this.context, this.width, this.height);
    this.drawCinematicBackground(
      analysis, state,
      coverCamera ? { ...coverOptions, camera: coverCamera } : coverOptions,
      emberDrive,
    );
    // The readouts sit in the band below the graph, on the main canvas and
    // off the graph camera, so the sculpture can never cover them.
    this.drawSignalBandWithPresence(this.context, signalBand, presence, false);
    this.profiler?.("band", this.canvas);

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
    this.applyGraphCamera(context, pose);
    // The ripples spread behind the sculpture: it stands in front of them.
    this.drawHitRings(context, hits, visual, pose, false);
    this.profiler?.("hits", this.canvas);
    drawMaterialSurface(context, filaments, frame, motion, this.material, lights,
      this.skinStrength(section, presence), this.config.visual.lowFlash, this.surfaceFragments.opacityAt);
    this.profiler?.("skin", this.canvas);
    this.drawResonance(context, filaments, frame, visual, time, false, "back", motion, lights, presence, this.surfaceFragments.opacityAt);
    this.drawResonance(context, filaments, frame, visual, time, false, "front", motion, lights, presence, this.surfaceFragments.opacityAt);
    this.profiler?.("filaments", this.canvas);
    context.restore();
    this.surfaceFragments.draw(context);
    this.profiler?.("fragments", this.canvas);
    // The near plane floats in front of the sculpture and its fragments.
    drawEmbers(context, this.embers, this.emberColors, emberDrive, "near");
    this.profiler?.("embers", this.canvas);

    this.drawPostEffects(Math.round(time * this.config.output.fps), state);
    this.drawTypography(time);
    this.profiler?.("typography", this.canvas);

    const image = context.getImageData(0, 0, this.width, this.height);
    this.profiler?.("readback", this.canvas);
    return Buffer.from(
      image.data.buffer,
      image.data.byteOffset,
      image.data.byteLength,
    );
  }

  private drawCinematicBackground(
    analysis: AudioAnalysis,
    state: FrameState,
    coverOptions: ArtworkDrawOptions,
    emberDrive: EmberDrive,
  ): void {
    const output = this.context;
    const { time, dynamics, visual, effects, momentum, presence } = state;
    if (this.artwork) {
      this.drawCoverRoom(output, this.artwork, time, coverOptions);
    } else {
      this.drawNebulaRoom(output, analysis, time, visual, state.choreography, state.motion);
    }
    // The far plane lives in the room, under the sculpture's bloom.
    drawEmbers(output, this.embers, this.emberColors, emberDrive, "far");
    this.profiler?.("room", this.canvas);
    this.spectralFlow.draw(output, analysis, time, this.config.visual.intensity);
    this.profiler?.("flow", this.canvas);

    const background = this.backgroundContext;
    resetContext(background, this.backgroundWidth, this.backgroundHeight);
    this.renderEmission(state);
    this.profiler?.("emission", this.emissionCanvas);
    // Bloom strength 0.30 (quiet) -> ~0.75 (peak): blended sustain, the peak
    // tier and the hit's flick, whose share is a luminance transient under lowFlash.
    const transient = this.config.visual.lowFlash ? 0.5 : 1;
    drawAtmosphericBloom(background, this.emissionCanvas, this.layout, this.width, this.height,
      dynamics,
      (0.30 + effects.glow * 0.30 + dynamics.cloud.energy * 0.10 + visual.peak * 0.22 + momentum.flick * 0.18 * transient)
        * this.config.visual.intensity * presence,
      effects.saturation * 1.3 + visual.peak * 0.3, this.config.visual.lowFlash, momentum.flick);
    this.profiler?.("bloom", this.backgroundCanvas);

    // The diffuse texture light only serves the seeded material; under a cover
    // it would lay a haze over the illustration's own pigment.
    const lightingStrength = this.config.visual.lighting ?? 0.65;
    if (!this.artwork && lightingStrength > 0) this.materialLight.draw(output, state.lights, lightingStrength);
    // Frozen clouds: sparse captures of the sculpture on bass hits that expand
    // and blur into a faint halo (kept: at peaks they move ~1-2% of the
    // frame's pixels by more than 16 levels).
    this.frozenClouds.draw(output, analysis, time, (context, captureTime) => {
      const frozen = this.frameState(analysis, captureTime);
      context.save();
      this.applyGraphCamera(context, frozen.pose);
      drawMaterialSurface(context, frozen.filaments, frozen.frame, frozen.motion, this.material, frozen.lights,
        this.skinStrength(frozen.section, frozen.presence), this.config.visual.lowFlash);
      this.drawResonance(context, frozen.filaments, frozen.frame, frozen.visual, captureTime,
        true, "back", frozen.motion, frozen.lights, frozen.presence);
      this.drawResonance(context, frozen.filaments, frozen.frame, frozen.visual, captureTime,
        true, "front", frozen.motion, frozen.lights, frozen.presence);
      context.restore();
    });
    this.profiler?.("ghosts", this.canvas);
    output.save();
    // Screen halves a light's contribution over the mid-tone cover room and
    // pushes it toward white; adding it keeps the pigment's hue. Over the dark
    // nebula bed screen and lighter are nearly the same, so screen stays there.
    output.globalCompositeOperation = this.artwork ? "lighter" : "screen";
    output.drawImage(this.backgroundCanvas, 0, 0, this.width, this.height);
    output.restore();
    this.profiler?.("composite", this.canvas);
  }

  /**
   * Cover mode: the illustration is the room. One opaque fill of its darkest
   * pigment shows through the baked hero hole and corners; the cover itself is
   * drawn source-over with the section/kick camera and a third of the graph
   * camera's pan as parallax.
   */
  private drawCoverRoom(
    output: SKRSContext2D,
    artwork: PreparedArtwork,
    time: number,
    options: ArtworkDrawOptions,
  ): void {
    output.fillStyle = this.color(this.darkPhase, 100, 14);
    output.fillRect(0, 0, this.width, this.height);
    drawArtwork(output, artwork, time, options);
  }

  /** The graph camera's pan in output pixels; the room and the ember planes follow shares of it. */
  private graphPan(pose: SceneCameraPose): { x: number; y: number } {
    const halfY = Math.min(this.layout.horizon - this.layout.graphTop, this.layout.graphBottom - this.layout.horizon);
    return { x: pose.x * this.layout.width / 2, y: pose.y * halfY };
  }

  /**
   * What the cover room is drawn with. 0.35x of the graph-camera pan becomes
   * parallax (scaled inside drawArtwork). coverCameraAt clamps the sum of Ken
   * Burns drift and parallax to the zoom margin, so a larger scene pan would
   * start eating the drift at quiet zooms (margin ~65 px at zoom 1.07) rather
   * than exposing the base fill.
   */
  private coverOptions(pose: SceneCameraPose, section: number, kick: number, presence: number): ArtworkDrawOptions {
    const pan = this.graphPan(pose);
    return { section, kick, presence, panX: pan.x, panY: pan.y, seedPhase: this.palettePhase * Math.PI / 180 };
  }

  /** The readouts and embers keep a third of their light before the sculpture arrives and after it leaves. */
  private bandPresence(presence: number): number {
    return 0.3 + 0.7 * clamp(presence);
  }

  private drawSignalBandWithPresence(context: SKRSContext2D, signalBand: SignalBandFrame, presence: number, emission: boolean): void {
    context.save();
    context.globalAlpha = this.bandPresence(presence);
    drawSignalBand(context, signalBand, this.signalStyle, emission);
    context.restore();
  }

  /** No-cover mode: the cached 10 Hz nebula, drawn with slow breathing. */
  private drawNebulaRoom(
    output: SKRSContext2D,
    analysis: AudioAnalysis,
    time: number,
    visual: VisualState,
    choreography: Choreography,
    motion: MusicMotion,
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
  }

  private renderSlowBackground(
    analysis: AudioAnalysis,
    time: number,
  ): void {
    const frame = frameAt(analysis, time);
    const visual = deriveVisualState(analysis, time);
    const choreography = deriveChoreography(
      visual,
      frame.onset,
      this.config.visual.lowFlash,
    );
    const atmosphere = 0.6 + choreography.layers.aurora * 0.4;
    const context = this.slowBackgroundContext;
    const width = this.backgroundWidth;
    const height = this.backgroundHeight;
    const effects = deriveMusicEffects(deriveMusicMotion(analysis, time), this.config.visual.lowFlash, deriveSceneDynamics(analysis, time), visual.warmth);
    const baseHue = this.palettePhase + effects.hueShift * 0.5;
    // Peaks brighten the bed; the sculpture's halo and skin carry the contrast.
    const peakShade = 1 + visual.peak * 0.25;

    resetContext(context, width, height);
    const base = context.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, this.color(this.darkPhase + 288, 100, 10 * peakShade));
    base.addColorStop(0.48, this.color(this.darkPhase, 100, 7 * peakShade));
    base.addColorStop(1, this.color(this.darkPhase + 300, 100, 13 * peakShade));
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

    context.restore();
  }

  private renderEmission(state: FrameState): void {
    const { frame, time, visual, choreography, grade, ribbon, filaments, motion, lights, hits, pose, presence, signalBand } = state;
    const context = this.emissionContext;
    resetContext(context, this.backgroundWidth, this.backgroundHeight);
    const scaleX = this.backgroundWidth / this.width;
    const scaleY = this.backgroundHeight / this.height;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    // The bloom's credit mask fades out below 0.87H, so the band's copy
    // becomes a soft coloured glow above the strip rather than a second strip.
    this.drawSignalBandWithPresence(context, signalBand, presence, true);
    context.save();
    this.applyGraphCamera(context, pose);
    this.drawCoreBurst(context, hits, visual);
    context.restore();

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
    // The core travels from the cool pigment at rest to the warm one at peaks.
    const coreHue = lerp(this.coolPhase, this.warmPhase, visual.peak);
    coreGlow.addColorStop(
      0,
      this.color(
        coreHue,
        100,
        55,
        (0.12 + choreography.layers.spiral * 0.2 + grade.bloom * 0.5) *
          this.config.visual.intensity,
      ),
    );
    coreGlow.addColorStop(
      0.28,
      this.color(coreHue + 54, 100, 46, 0.08 + visual.peak * 0.08),
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
    this.applyGraphCamera(context, pose);
    this.drawHitRings(context, hits, visual, pose, true);
    this.drawResonance(context, filaments, frame, visual, time, true, "back", motion, lights, 1, this.surfaceFragments.opacityAt);
    this.drawResonance(context, filaments, frame, visual, time, true, "front", motion, lights, 1, this.surfaceFragments.opacityAt);
    // The spectral ribbon survives only as this faint light-field copy: the
    // bloom spreads it into a diffuse iridescent halo around the sculpture
    // (kept: it moves ~1% of the frame's pixels by > 16 levels at peaks).
    context.save();
    context.globalAlpha = 0.12;
    this.drawRibbonEmission(context, ribbon, visual, choreography, time);
    context.restore();
    context.restore();
    context.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * One camera for every layer of a frame (live geometry, both emission passes,
   * fragment and frozen captures), so nothing drifts off the shared matrix.
   * Captures pass the kick, section and presence of their own capture time.
   * The sculpture grows in from a quarter of its size as it arrives.
   */
  private cameraPose(dynamics: SceneDynamics, kick: number, section: number, presence: number): ResonanceCamera {
    return {
      ...sceneCameraAt(dynamics, this.palettePhase * 0.01, this.ribbonPlan.direction, kick, section),
      fit: sculptureFit(section) * (0.25 + 0.75 * clamp(presence)),
    };
  }

  private applyGraphCamera(context: SKRSContext2D, pose: SceneCameraPose): void {
    const matrix = sceneCameraMatrix(this.layout, pose);
    context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  }

  private captureFragmentSource(analysis: AudioAnalysis, time: number): FragmentSource {
    const { filaments, frame, motion, lights, section, presence, pose } = this.frameState(analysis, time);
    return { filaments, frame, motion, material: this.material, lights,
      strength: this.skinStrength(section, presence), lowFlash: this.config.visual.lowFlash,
      camera: sceneCameraMatrix(this.layout, pose) };
  }

  /**
   * The pigment skin is translucent in quiet passages, so the object is a
   * wispy strand sculpture there, and solid lit pigment at peaks; it fades
   * with the sculpture's presence. Captures pass the section and presence
   * of their own capture time.
   */
  private skinStrength(section: number, presence: number): number {
    return (this.config.visual.lighting ?? 0.65) * (0.55 + 0.45 * clamp(section)) * clamp(presence);
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
    lights: LightingState,
    opacity = 1,
    surfaceOpacity?: SurfaceCoverage,
  ): void {
    const radius = Math.min(
      this.layout.horizon - this.layout.graphTop,
      this.layout.graphBottom - this.layout.horizon,
      this.layout.width / 2,
    );
    const presence = (0.62 + frame.rms * 0.2 + visual.peak * 0.18) *
      this.config.visual.intensity;
    const lightingStrength = this.config.visual.lighting ?? 0.65;
    const materialSample: MaterialSample = {r: 0, g: 0, b: 0, a: 1, nx: 0, ny: 0, nz: 1, roughness: 0.6, height: 0.5};
    const lightColor: Rgb = [0, 0, 0];
    const baseColor: Rgb = [0, 0, 0];
    // Lightness stays near 50 so the strands keep the swatch's own chroma;
    // paletteRgb mixes in white above that and would grey the halo. The
    // diagonal gradient walks a little way along the ring (spread in degrees).
    const gradientStops = [
      [0, 0, 1, 0.50, 1], [0.3, 5, 1, 0.52, 1],
      [0.52, 19, 1, 0.50, 0.62], [0.76, 32, 1, 0.48, 1],
      [1, 44, 1, 0.54, 1],
    ] as const;
    // Strands are drawn in the cover's own pigments: bass positions warm,
    // treble positions cool. Breathing and the strand's hue offset spread each
    // family along its own side of the ring only, never through the grey
    // midpoint between the two families.
    const breathing = 7 + Math.sin(time * 0.045) * 7;
    const tints = [
      { phase: this.warmPhase, direction: this.warmDirection },
      { phase: this.coolPhase, direction: this.coolDirection },
    ] as const;
    const gradientColors: Rgb[][] = tints.map(() => gradientStops.map(() => [0, 0, 0]));
    const skinShowsThrough = !emission && this.artwork ? 0.8 : 1;
    context.save();
    // Over the dark bed of no-cover mode the strands glow (screen); over the
    // mid-tone cover room screen bleaches peach to white and loses the dark
    // teal entirely, so there the main passes are painted as pigment lines
    // and the bloom behind them supplies the glow.
    context.globalCompositeOperation = emission || !this.artwork ? "screen" : "source-over";
    context.lineCap = "round";
    context.lineJoin = "round";
    // The light field only feeds the bloom's blur, which cannot resolve
    // neighbouring strands: every second strand at 1.25x width fills the
    // same halo for half the stroke work.
    const strandStep = emission ? 2 : 1;
    for (let strand = 0; strand < filaments.length; strand += strandStep) {
      const filament = filaments[strand]!;
      const alpha = clamp(filament.alpha * presence * 2.3 * opacity) * skinShowsThrough;
      const spread = Math.abs(filament.hueOffset) * 0.18 + breathing;
      for (let tint = 0; tint < tints.length; tint += 1) {
        const { phase, direction } = tints[tint]!;
        for (let stop = 0; stop < gradientStops.length; stop += 1) {
          const [, stopSpread, saturation, lightness] = gradientStops[stop]!;
          paletteRgb(this.palette, phase + direction * (spread + stopSpread) - this.palettePhase,
            saturation * 100, lightness * 100, gradientColors[tint]![stop]!);
        }
      }
      // Emission strokes are set in output pixels but rasterised at quarter
      // resolution: below ~0.02 * radius they are sub-pixel there and the
      // bloom has almost nothing to spread.
      context.lineWidth = emission
        ? Math.max(1.5, radius * (0.020 + frame.mid * 0.006)) * 1.25
        : Math.max(0.45, radius * 0.0046) * (strand % 7 === 0 ? 1.7 : 0.85) * (this.artwork ? 1.3 : 1);
      // Short continuous runs allow depth and local spectrum to shade the
      // surface smoothly, including where strands cross the front/back plane;
      // the light field is blurred by ~10 quarter-res pixels, so it shades
      // in runs twice as long for half the stroke and shading work.
      const runLength = emission ? 20 : 10;
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
        // A short crossover keeps most runs clearly one pigment; a linear mix
        // would leave half the object in the muddy midpoint of the two.
        const coolness = smoothstep(0.3, 0.7, middle.band);
        const warm = gradientColors[0]!, cool = gradientColors[1]!;
        for (let channel = 0; channel < 3; channel += 1) {
          baseColor[channel] = lerp(
            lerp(warm[lower]![channel]!, warm[lower + 1]![channel]!, amount),
            lerp(cool[lower]![channel]!, cool[lower + 1]![channel]!, amount),
            coolness,
          );
        }
        let segmentAlpha = alpha * lerp(left[4], right[4], amount);
        if (lightingStrength > 0) {
          sampleResonanceMaterial(this.material, filaments, strand, Math.floor((start + end) / 2), materialSample);
          shadeSurface(lights, middle.surfaceX, middle.surfaceY, middle.surfaceZ, materialSample, lightColor);
          const lightness = lightColor[0] * 0.2126 + lightColor[1] * 0.7152 + lightColor[2] * 0.0722;
          // Light only shades the pigment (never past the swatch itself) and
          // adds a small gleam; a brightening shade bleached peach to white.
          const shade = Math.min(1, lerp(1, 0.55 + lightness * 0.9, lightingStrength));
          baseColor[0] = clamp(baseColor[0] * shade + Math.sqrt(lightColor[0]) * lightingStrength * 0.06);
          baseColor[1] = clamp(baseColor[1] * shade + Math.sqrt(lightColor[1]) * lightingStrength * 0.06);
          baseColor[2] = clamp(baseColor[2] * shade + Math.sqrt(lightColor[2]) * lightingStrength * 0.06);
          segmentAlpha *= lerp(1, 0.82 + materialSample.height * 0.32, lightingStrength);
        }
        context.strokeStyle = `rgba(${Math.round(baseColor[0] * 255)},${Math.round(baseColor[1] * 255)},${Math.round(baseColor[2] * 255)},${clamp(segmentAlpha)})`;
        const runAlpha = (0.12 + smoothstep(0.18, 0.82, middle.depth) * 0.88) *
          (0.5 + middle.energy * 0.7);
        context.globalAlpha = runAlpha;
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
          const remaining = surfaceOpacity?.((index + 0.5) / (filament.points.length - 1), strand / filaments.length) ?? 1;
          if (remaining < 0.999) {
            context.stroke(); context.beginPath(); connected = false;
            if (remaining > 0.001) {
              context.globalAlpha = runAlpha * remaining;
              context.moveTo(point.x, point.y); context.lineTo(next.x, next.y); context.stroke();
              context.beginPath(); context.globalAlpha = runAlpha;
            }
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
        const tint = tints[point.band < 0.5 ? 0 : 1]!;
        context.fillStyle = this.color(tint.phase + tint.direction * spread, 100, 60,
          (0.28 + point.energy * 0.65) * presence * (surfaceOpacity?.(phase, strand / filaments.length) ?? 1));
        context.beginPath();
        context.arc(x, y, Math.max(0.65, radius * 0.005), 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  /** How big and bright a hit is: its ranked strength, gated by the chapter so intro taps stay small. */
  private hitSize(hit: HitEvent, visual: VisualState): number {
    return clamp(hit.strength) * (0.45 + 0.55 * clamp(visual.chapter));
  }

  /**
   * Kicks ring in the warm pigment, hats in the cool one; hit.kick already
   * carries the plan's narrow, track-relative split, so almost no ring lands
   * in the grey between the two pigments. Both swatches are lifted to a
   * readable luma with no white mixed in, which would only grey the ring.
   */
  private hitColor(hit: HitEvent): Rgb {
    return mixRgb(this.coolPigment, this.warmPigment, hit.kick);
  }

  /**
   * The one hit layer: a ripple ring from the object's core that eases out
   * toward the graph reserve and fades over HIT_LIFETIME. Its radius and
   * width are geometry and never capped; its light is a luminance transient,
   * so lowFlash ramps it in over 50 ms and caps it, and the hit plan keeps
   * rings >= HIT_REFRACTORY apart. Drawn inside the graph clip and camera,
   * and sized to the clip under that camera (ringReachWithin), so the ring
   * dissolves inside the reserve instead of being cut flat by the clip edges.
   */
  private drawHitRings(
    context: SKRSContext2D,
    hits: HitEvent[],
    visual: VisualState,
    pose: SceneCameraPose,
    emission: boolean,
  ): void {
    if (hits.length === 0) return;
    const radii = safeGraphRadii(this.layout);
    const unit = this.height / 1080;
    context.save();
    // Over the mid-tone cover screen bleaches the peach ring to cream, so the
    // main pass paints it as pigment and the emission copy supplies the glow.
    context.globalCompositeOperation = emission || !this.artwork ? "screen" : "source-over";
    context.lineCap = "round";
    for (const hit of hits) {
      const progress = clamp(hit.age / HIT_LIFETIME);
      const eased = 1 - (1 - progress) ** 2.4;
      const size = this.hitSize(hit, visual);
      // Small hits (intro taps) are small, faint ripples; drop kicks are the wide ones.
      const alpha = hitRingAlpha(hit.age, size, this.config.visual.lowFlash, this.config.visual.intensity)
        * smoothstep(0.1, 0.45, size);
      if (alpha < 0.002) continue;
      // Every ring is its own ellipse: size, aspect, thickness, tilt and the
      // direction it drifts in while it spreads, fixed per hit by the seed.
      const variation = hitVariation(this.seed, hit);
      const color = this.hitColor(hit);
      const width = (12 - eased * 8) * (0.7 + size * 0.5) * unit * variation.thickness;
      // The ring blurs as it grows, until it is lost in the room: crisp on
      // the hit, a wide haze by the end of its life. The blur is a stack of
      // widening strokes with Gaussian weights (a canvas blur filter on a
      // 1080p stroke costs ~12 ms; the stack costs a fraction of that), and
      // the pigment copy also fades faster than its light, so the last of
      // every ring is the bloom's diffuse glow.
      const spread = eased * (18 + size * 16) * unit;
      const stack = spread < unit ? 0 : Math.min(6, Math.ceil(spread / (4 * unit)));
      // A wider, fainter stroke underneath softens the young ring's edge;
      // the spread takes that job over as the ring grows.
      const halo = lerp(3, 2.2, smoothstep(0.2, 0.5, size)) * (1 - eased * 0.6);
      const ringRadii = { x: radii.x * variation.diameter, y: radii.y * variation.diameter * variation.ratio };
      // The reach keeps the halo and the spread inside the clip; the tilt
      // rolls with the camera and the drift takes its share of the room.
      const margin = (width * halo) / 2 + spread * 2;
      const fit = ringReachWithin(this.layout, { ...pose, roll: pose.roll + variation.tilt }, ringRadii, margin) * 0.97
        - variation.drift;
      const reach = hitRingReach(hit.age, size, Math.max(0, fit));
      const centerX = this.layout.centerX + Math.cos(variation.driftAngle) * ringRadii.x * variation.drift * eased;
      const centerY = this.layout.horizon + Math.sin(variation.driftAngle) * ringRadii.y * variation.drift * eased;
      context.beginPath();
      context.ellipse(centerX, centerY, ringRadii.x * reach, ringRadii.y * reach, variation.tilt, 0, Math.PI * 2);
      if (emission) {
        // The bloom blurs this copy anyway; it only needs the ring's light.
        context.strokeStyle = rgbCss(color, alpha * 0.6);
        context.lineWidth = width * 3;
        context.stroke();
        continue;
      }
      const pigment = alpha * (1 - eased) ** 1.5;
      if (halo > 1) {
        context.strokeStyle = rgbCss(color, pigment * lerp(0.2, 0.3, smoothstep(0.2, 0.5, size)) * (1 - eased));
        context.lineWidth = width * halo;
        context.stroke();
      }
      if (stack === 0) {
        context.strokeStyle = rgbCss(color, pigment);
        context.lineWidth = width;
        context.stroke();
        continue;
      }
      // Gaussian weights across the stack, normalised so the stack carries the
      // same pigment the single stroke would.
      let total = 0;
      const weights: number[] = [];
      for (let step = 0; step <= stack; step += 1) {
        const weight = Math.exp(-2.5 * (step / stack) ** 2);
        weights.push(weight);
        total += weight;
      }
      for (let step = stack; step >= 0; step -= 1) {
        context.strokeStyle = rgbCss(color, pigment * weights[step]! / total);
        context.lineWidth = width + spread * 4 * (step / stack);
        context.stroke();
      }
    }
    context.restore();
  }

  /**
   * A short flash of the hit's pigment at the core, in the emission field
   * only so the bloom turns it into a soft burst of light. It follows the
   * glow kernel: nothing on the hit frame, peak 100 ms later, gone by 0.5 s.
   */
  private drawCoreBurst(context: SKRSContext2D, hits: HitEvent[], visual: VisualState): void {
    const radius = safeGraphRadius(this.layout);
    for (const hit of hits) {
      const size = this.hitSize(hit, visual);
      let alpha = size * momentumKernel(hit.age, MOMENTUM_TAU.glow) * 0.9 * this.config.visual.intensity;
      if (this.config.visual.lowFlash) alpha = Math.min(0.5, alpha * smoothstep(0, 0.05, hit.age));
      if (alpha < 0.003) continue;
      const reach = 0.4 * radius * (1 + size);
      const color = this.hitColor(hit);
      const burst = context.createRadialGradient(this.layout.centerX, this.layout.horizon, 0,
        this.layout.centerX, this.layout.horizon, reach);
      burst.addColorStop(0, rgbCss(color, alpha));
      burst.addColorStop(1, rgbCss(color, 0));
      context.fillStyle = burst;
      context.fillRect(this.layout.centerX - reach, this.layout.horizon - reach, reach * 2, reach * 2);
    }
  }

  /**
   * The frame's colour temperature, 0 cool .. 1 warm, from two section-scale
   * signals only (both are 5 s windowed means, so the grade changes between
   * sections and never with the beat): the track-relative spectral centroid
   * and the section level. The loudness term is there because a bass-heavy
   * drop has the lowest centroid of the song, and a drop graded cold reads
   * wrong; the centroid moves the balance within a section. Its weight is
   * the smaller one because the p10..p90 scale re-amplifies what ripple a
   * 5 s mean leaves: at 0.4 the grade alone moves the frame's mean R-B by
   * at most ~5 levels in any second of the drop (0.6 gave 7). Note that the
   * warmth window clamps to the track, so in the first and last seconds it
   * shrinks and warmth gets noisier there (a 0.6 swing per second was seen
   * in the outro); it is invisible while the section term keeps the wash
   * amount small there, and a padded window would be the fix if S8 raises it.
   */
  private frameTemperature(visual: VisualState, section: number): number {
    return clamp(0.5 + (clamp(visual.warmth) - 0.5) * 0.4 + (clamp(section) - 0.5) * 0.7);
  }

  /**
   * The grade: one overlay tint of the whole frame in the cover's cool or
   * warm pigment, chosen by frameTemperature, with an amount that grows
   * with the distance from a balanced 0.5 (a balanced passage is untinted;
   * an RGB blend of the two pigments is a grey-teal that only desaturates
   * the cover). Both pigments are lifted to mid luma so the tint shifts
   * temperature instead of darkening, and a solid overlay is the one
   * full-frame blend Skia runs cheaply (~2 ms; a gradient or soft-light
   * costs 4-9 ms, and a diagonal gradient's two ends cancel in the frame
   * mean). Loud sections raise the amount.
   */
  private drawWarmthWash(context: SKRSContext2D, visual: VisualState, section: number): void {
    const temperature = this.frameTemperature(visual, section);
    const amount = (0.06 + clamp(section) * 0.13) * Math.abs(temperature - 0.5) * 2;
    if (amount < 0.005) return;
    const tint = mixRgb(this.coolPigment, this.warmPigment, smoothstep(0.45, 0.55, temperature));
    context.save();
    context.globalCompositeOperation = "overlay";
    context.fillStyle = rgbCss(tint, amount);
    context.fillRect(0, 0, this.width, this.height);
    context.restore();
  }

  /**
   * A warm lift of the whole frame on each kept hit. The whole frame has
   * mass: it rises over the glow kernel (nothing on the hit frame, peak
   * 100 ms later) and is gone by half a second, so the room never pumps. It
   * is the only full-frame luminance transient: rate-limited by the hit plan
   * and capped at +0.03 luma under lowFlash (+0.06 without).
   */
  private drawHitLift(context: SKRSContext2D, hits: HitEvent[], visual: VisualState): void {
    let lift = 0;
    for (const hit of hits) lift = Math.max(lift, this.hitSize(hit, visual) * momentumKernel(hit.age, MOMENTUM_TAU.glow));
    lift *= (this.config.visual.lowFlash ? 0.5 : 1) * this.config.visual.intensity;
    if (lift <= 0.02) return;
    context.save();
    context.globalCompositeOperation = "lighter";
    // The cover's warm pigment lifted a third of the way to white: the lift
    // is a pulse of light, and the full-chroma pigment swung the frame's
    // colour temperature by ~10 levels on every kick.
    context.fillStyle = rgbCss(this.liftPigment, lift * 0.06);
    context.fillRect(0, 0, this.width, this.height);
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

  /**
   * The lockup fades and rises in over TYPOGRAPHY_SETTLE seconds and then
   * never changes (it stays centred for the whole track), so from then on it
   * is painted once into a sheet and composited, instead of laying out and
   * shadowing the text on every frame (~9 ms at 1080p).
   */
  private drawTypography(time: number): void {
    if (!(time >= TYPOGRAPHY_SETTLE)) {
      this.paintTypography(this.context, time);
      return;
    }
    if (!this.typographySheet) {
      const sheet = createCanvas(this.width, this.height);
      this.paintTypography(sheet.getContext("2d"), TYPOGRAPHY_SETTLE);
      this.typographySheet = sheet;
    }
    this.context.drawImage(this.typographySheet, 0, 0);
  }

  private paintTypography(context: SKRSContext2D, time: number): void {
    const title = this.config.text.title
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim();
    const artist = this.config.text.artist
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim();
    if (!title && !artist) return;

    const safeY = this.layout.titleY;
    const alpha = smoothstep(0.08, TYPOGRAPHY_SETTLE, time);
    const rise = lerp(this.height * 0.004, 0, alpha);

    context.save();
    context.globalAlpha = alpha;
    context.filter = "none";
    // Only the letter silhouettes cast shade. Let their wide soft feather
    // extend naturally over the cover instead of clipping it into a text band.
    context.shadowColor = "rgba(0,0,0,0.9)";
    context.shadowBlur = Math.min(this.width, this.height) * 0.026;
    context.shadowOffsetY = Math.min(this.width, this.height) * 0.003;
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
    titleGradient.addColorStop(1, this.color(this.palettePhase, 12, 94, 1));
    context.fillStyle = titleGradient;
    if (this.artwork?.thumbnail) {
      this.drawCoverCredits(context, this.artwork.thumbnail, title, artist, baseTitleSize, safeY + rise);
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
      context.shadowBlur = Math.min(this.width, this.height) * 0.023;
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
    context: SKRSContext2D,
    thumbnail: Canvas,
    title: string,
    artist: string,
    baseSize: number,
    top: number,
  ): void {
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
    context.shadowBlur = smallSide * 0.023;
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

  private drawPostEffects(frameIndex: number, state: FrameState): void {
    const { grade, visual, section, hits } = state;
    const context = this.context;
    this.drawWarmthWash(context, visual, section);
    this.drawHitLift(context, hits, visual);
    this.profiler?.("post", this.canvas);

    // The dither goes on before the vignette so the vignette's own gradient
    // is dithered too.
    if (this.config.visual.grain > 0) {
      const grainCadence = Math.max(1, Math.round(this.config.output.fps / 12));
      const grain = this.grainCanvases[Math.floor(frameIndex / grainCadence) % this.grainCanvases.length];
      if (grain) {
        context.save();
        context.globalAlpha = this.config.visual.grain;
        context.globalCompositeOperation = "lighter";
        context.imageSmoothingEnabled = false;
        context.drawImage(grain, 0, 0, this.width, this.height);
        context.restore();
      }
    }
    this.profiler?.("dither", this.canvas);

    // The cover carries its own corner vignette; a second one would only mud
    // the illustration. The seeded nebula keeps a vignette in its own pigment.
    if (this.config.visual.vignette > 0 && !this.artwork) {
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
      vignette.addColorStop(0.58, this.color(this.darkPhase, 100, 6, 0.025));
      vignette.addColorStop(
        1,
        this.color(
          this.darkPhase, 100, 6,
          this.config.visual.vignette * grade.vignetteScale * (1 - visual.peak * 0.06),
        ),
      );
      context.fillStyle = vignette;
      context.fillRect(0, 0, this.width, this.height);
    }
    this.profiler?.("vignette", this.canvas);
  }
}
