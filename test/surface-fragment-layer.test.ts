import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "bun:test";
import { ANALYSIS_VERSION, type AnalysisFrame, type AudioAnalysis } from "../src/types.js";
import type { VisualState } from "../src/render/conductor.js";
import { createSafeLayout, safeGraphRadius } from "../src/render/layout.js";
import { lightingAt } from "../src/render/lighting.js";
import { createMaterialFromRgba, type MaterialMap } from "../src/render/material.js";
import type { MusicMotion } from "../src/render/music-motion.js";
import { createResonanceFilaments, createResonancePlan, type ResonanceCamera } from "../src/render/resonance.js";
import {
  fragmentProjection, projectFragmentPoint, SurfaceFragmentLayer, type FragmentSource,
} from "../src/render/surface-fragment-layer.js";
import { fragmentCoverage, surfaceFragmentCandidates, surfaceFragmentPose } from "../src/render/surface-fragments.js";

const seed = "actual-surface-fragments";
const plan = createResonancePlan(seed);
const visual: VisualState = { ambient: 0.6, drive: 0.7, peak: 0.8, beat: 0.8, trend: 0.2, motion: 0.6, chapter: 0.4, form: 0.5, warmth: 0.5 };
const frame: AnalysisFrame = {
  rms: 0.5, peak: 0.7, bass: 0.4, mid: 0.3, treble: 0.2, centroid: 0.4, flux: 0.1, onset: 0.2,
  spectrum: Float32Array.from({ length: 32 }, (_, index) => 0.2 + Math.sin(index * 0.3) * 0.1),
  waveform: Float32Array.from({ length: 64 }, (_, index) => Math.sin(index * Math.PI / 16) * 0.3),
};

function analysis(): AudioAnalysis {
  const fps = 30, duration = 24;
  return {
    version: ANALYSIS_VERSION, fps, duration, sampleRate: 48_000, spectrumBands: 32, waveformPoints: 64,
    sourceHash: "surface-fragment-layer", sourceFileHash: "surface-fragment-layer",
    frames: Array.from({ length: fps * duration }, (_, index) => ({
      ...frame, bass: index >= fps && (index - fps) % (fps * 3) === 0 ? 0.3 : 0.025,
    })),
  };
}

function material(kind: "gray" | "photo" | "swapped" = "gray", alpha = 255): MaterialMap {
  const pixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    // The two photo pigments have exactly equal Rec.709 luminance. Neither
    // lighting nor relief changes when their positions are exchanged.
    const pink = (Math.floor(x / 8) + Math.floor(y / 8) + Number(kind === "swapped")) % 2 === 0;
    const color = kind === "gray" ? [160, 160, 160] : pink ? [204, 36, 132] : [40, 90, 80];
    pixels.set([...color, alpha], (y * 32 + x) * 4);
  }
  const result = createMaterialFromRgba(pixels, 32, 32);
  result.heightMap.fill(0.5);
  result.roughness.fill(0.7);
  result.normals.fill(0);
  for (let index = 2; index < result.normals.length; index += 3) result.normals[index] = 1;
  return result;
}

function sourceAt(width: number, height: number, time: number, photo = material()): FragmentSource {
  const layout = createSafeLayout(width, height);
  const motion: MusicMotion = {
    slowTime: time * 0.75, fastTime: time * 2.5, bassPulse: 0.6, treblePulse: 0.3,
    bassEnergy: 0.65, midEnergy: 0.4, trebleEnergy: 0.3, attack: 0.4, sustain: 0.6,
  };
  const cameraPose: ResonanceCamera = {
    x: Math.sin(time) * 0.018, y: Math.cos(time) * 0.012, roll: Math.sin(time * 0.6) * 0.08, zoom: 1.09,
  };
  const a = Math.cos(cameraPose.roll) * cameraPose.zoom, b = Math.sin(cameraPose.roll) * cameraPose.zoom;
  const c = -b, d = a;
  const halfY = Math.min(layout.horizon - layout.graphTop, layout.graphBottom - layout.horizon);
  return {
    frame, motion, material: photo, strength: 0.9, lowFlash: false,
    filaments: createResonanceFilaments(plan, frame, visual, layout, time, false, motion, cameraPose),
    lights: lightingAt(motion, time, seed, 0, false, frame.spectrum,
      { source: "artwork", colors: [[0.6, 0.6, 0.6]], anchorHue: 0 }),
    camera: { a, b, c, d,
      e: layout.centerX + cameraPose.x * layout.width / 2 - a * layout.centerX - c * layout.horizon,
      f: layout.horizon + cameraPose.y * halfY - b * layout.centerX - d * layout.horizon },
  };
}

function fixture(width = 320, height = 180, photo = material()) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const layout = createSafeLayout(width, height);
  const layer = new SurfaceFragmentLayer(layout, seed);
  const captureTimes: number[] = [];
  const sources = new Map<number, FragmentSource>();
  const capture = (time: number): FragmentSource => {
    captureTimes.push(time);
    if (!sources.has(time)) sources.set(time, sourceAt(width, height, time, photo));
    return sources.get(time)!;
  };
  const render = (audio: AudioAnalysis, time: number): Buffer => {
    context.clearRect(0, 0, width, height);
    layer.update(audio, time, capture);
    layer.draw(context);
    return Buffer.from(context.getImageData(0, 0, width, height).data);
  };
  return { layer, render, context, layout, captureTimes, sources };
}

function alphaCount(pixels: Buffer, threshold = 0): number {
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) count += Number(pixels[index]! > threshold);
  return count;
}

describe("departing pieces of the captured surface", () => {
  test("birth projection exactly matches the source camera on real curved geometry", () => {
    const event = { id: 30, captureTime: 1, strength: 1 };
    const attached = surfaceFragmentPose(event, surfaceFragmentCandidates(event, seed)[0]!, 1)!;
    for (const [width, height] of [[320, 180], [180, 320], [240, 240]] as const) {
      const layout = createSafeLayout(width, height);
      for (const time of [1, 4.7]) {
        const source = sourceAt(width, height, time);
        const projection = fragmentProjection(source, layout);
        const anchor = projection.point(source.filaments[17]!.points[93]!);
        let largestError = 0, depthSpan = 0;
        for (const strand of source.filaments) for (const point of strand.points) {
          const result = projectFragmentPoint(projection.point(point), anchor, attached,
            projection.origin, projection.distance, safeGraphRadius(layout));
          const expectedX = source.camera.a * point.x + source.camera.c * point.y + source.camera.e;
          const expectedY = source.camera.b * point.x + source.camera.d * point.y + source.camera.f;
          largestError = Math.max(largestError, Math.hypot(result.x - expectedX, result.y - expectedY));
          depthSpan = Math.max(depthSpan, Math.abs(point.surfaceZ));
        }
        expect(depthSpan).toBeGreaterThan(0.3);
        expect(projection.distance).toBeGreaterThan(safeGraphRadius(layout));
        expect(largestError).toBeLessThan(1e-9);
      }
    }
  });

  test("renders source photograph pigment and preserves neutral images and transparency", () => {
    const audio = analysis();
    const first = fixture(320, 180, material("photo")).render(audio, 2.2);
    const swapped = fixture(320, 180, material("swapped")).render(audio, 2.2);
    const gray = fixture().render(audio, 2.2);
    expect(alphaCount(first, 20)).toBeGreaterThan(80);
    let changed = 0, pink = 0, teal = 0, neutralChroma = 0;
    for (let index = 0; index < first.length; index += 4) {
      if (first[index + 3]! > 20 && swapped[index + 3]! > 20) {
        const a = [first[index]!, first[index + 1]!, first[index + 2]!];
        const b = [swapped[index]!, swapped[index + 1]!, swapped[index + 2]!];
        changed += Number(Math.max(...a.map((value, channel) => Math.abs(value - b[channel]!))) > 10);
        pink += Number(a[0]! > a[1]! * 1.3);
        teal += Number(a[1]! > a[0]! * 1.1);
      }
      if (gray[index + 3]! > 20) neutralChroma = Math.max(neutralChroma,
        Math.max(gray[index]!, gray[index + 1]!, gray[index + 2]!) - Math.min(gray[index]!, gray[index + 1]!, gray[index + 2]!));
    }
    expect(changed).toBeGreaterThan(50);
    expect(pink).toBeGreaterThan(10);
    expect(teal).toBeGreaterThan(10);
    expect(alphaCount(gray, 20)).toBeGreaterThan(80);
    expect(neutralChroma).toBeLessThanOrEqual(2);
    const transparent = fixture(320, 180, material("photo", 0));
    expect(alphaCount(transparent.render(audio, 2.2))).toBe(0);
    expect(transparent.layer.inspect().pieces).toBe(0);
  });

  test("replays fixed captures after forward and reverse seeks, cache eviction, and a new renderer", () => {
    const audio = analysis();
    const subject = fixture();
    const expected = subject.render(audio, 4.8);
    expect(alphaCount(expected, 10)).toBeGreaterThan(100);
    expect(subject.captureTimes).toEqual([1, 4]);
    subject.render(audio, 5);
    expect(subject.captureTimes).toEqual([1, 4]);
    for (const time of [18.2, 0, 10.7, 1.8]) subject.render(audio, time);
    expect(subject.render(audio, 4.8)).toEqual(expected);
    expect(fixture().render(audio, 4.8)).toEqual(expected);
    // The capture callback is sampled at each bass onset, never at query time.
    expect(subject.captureTimes.every(time => (time - 1) % 3 === 0)).toBe(true);
    expect(subject.captureTimes.filter(time => time === 1).length).toBeGreaterThan(1);
    const reanalyzed = analysis();
    const before = subject.captureTimes.length;
    expect(subject.render(reanalyzed, 4.8)).toEqual(expected);
    expect(subject.captureTimes.slice(before)).toEqual([1, 4]);
  });

  test("freezes shaded polygons instead of retaining mutable live geometry or lighting", () => {
    const audio = analysis();
    const subject = fixture(320, 180, material("photo"));
    const expected = subject.render(audio, 2.2);
    expect(alphaCount(expected, 20)).toBeGreaterThan(80);
    const capturedSource = subject.sources.get(1)!;
    for (const strand of capturedSource.filaments) for (const point of strand.points) {
      point.x += 1000;
      point.y += 1000;
      point.surfaceZ = -2;
    }
    capturedSource.material.albedo.fill(0);
    for (const light of capturedSource.lights.lights) light.color = [0, 0, 0];
    expect(subject.render(audio, 2.2)).toEqual(expected);
    expect(subject.captureTimes).toEqual([1]);
  });

  test("bounds active mesh caches and heals source UV holes before the next bass tear", () => {
    const audio = analysis();
    const subject = fixture();
    let maximumPieces = 0, shrunkenPatches = 0;
    for (const time of [1.7, 4.7, 7.1, 10.1, 13.1, 16.1, 19.1, 22.1]) {
      subject.render(audio, time);
      const state = subject.layer.inspect();
      expect(state.bursts).toBeLessThanOrEqual(3);
      expect(state.pieces).toBeLessThanOrEqual(12);
      expect(state.tears).toBeLessThanOrEqual(4);
      expect(state.faces).toBeLessThan(12 * 300);
      expect(new Set(state.ids).size).toBe(state.pieces);
      expect(state.selection).toHaveLength(state.pieces);
      for (const patch of state.selection) {
        expect(patch.birthSpan).toBeLessThanOrEqual(0.8);
        expect(patch.aspect).toBeLessThanOrEqual(5);
        expect(patch.visibility).toBeGreaterThanOrEqual(0.8);
        expect(patch.depthRatio).toBeLessThanOrEqual(0.14);
        const [id, index] = patch.id.split(":").map(Number);
        const original = surfaceFragmentCandidates({ id: id!, captureTime: id! / audio.fps, strength: 1 }, seed)[index!]!;
        expect(patch.halfU).toBeLessThanOrEqual(original.halfU);
        expect(patch.halfV).toBeLessThanOrEqual(original.halfV);
        shrunkenPatches += Number(patch.halfU < original.halfU);
      }
      maximumPieces = Math.max(maximumPieces, state.pieces);
    }
    expect(maximumPieces).toBeGreaterThanOrEqual(8);
    expect(shrunkenPatches).toBeGreaterThan(0);
    subject.render(audio, 1.7);
    expect(subject.layer.opacityAt).toBeDefined();
    const originals = surfaceFragmentCandidates({ id: 30, captureTime: 1, strength: 1 }, seed);
    const selected = subject.layer.inspect().selection.map(patch => ({
      ...originals.find(candidate => candidate.id === patch.id)!, halfU: patch.halfU, halfV: patch.halfV,
    }));
    let removed = 0, retained = 0;
    for (let v = 0; v < 1; v += 1 / 72) for (let u = 0; u < 1; u += 1 / 120) {
      const coverage = subject.layer.opacityAt!(u, v);
      expect(coverage).toBeGreaterThanOrEqual(0);
      expect(coverage).toBeLessThanOrEqual(1);
      // A smaller detached island must remove the same smaller source island,
      // rather than leaving a hole sized for the original oversized candidate.
      const expected = 1 - Math.max(...selected.map(patch => fragmentCoverage(u, v, patch)));
      expect(coverage).toBeCloseTo(expected, 12);
      removed += Number(coverage < 0.1);
      retained += Number(coverage > 0.999);
    }
    expect(removed).toBeGreaterThan(30);
    expect(retained).toBeGreaterThan(72 * 120 * 0.85);
    subject.render(audio, 3.7);
    expect(subject.layer.opacityAt).toBeUndefined();
    expect(subject.layer.inspect().pieces).toBeGreaterThan(0);
    subject.render(audio, 40);
    expect(subject.layer.inspect()).toEqual({ bursts: 0, pieces: 0, tears: 0, faces: 0, ids: [], selection: [] });
    expect(subject.layer.opacityAt).toBeUndefined();
  });

  test("keeps blurred fragments out of portrait credits and restores drawing state", () => {
    const audio = analysis();
    const subject = fixture(180, 320);
    for (const time of [1.7, 3, 5, 7.2]) {
      const pixels = subject.render(audio, time);
      expect(alphaCount(pixels)).toBeGreaterThan(40);
      const textBottom = Math.floor(320 * 0.25);
      expect(alphaCount(pixels.subarray(0, textBottom * 180 * 4))).toBe(0);
    }
    subject.context.globalAlpha = 0.65;
    subject.context.globalCompositeOperation = "multiply";
    subject.context.filter = "blur(0.3px)";
    subject.context.setTransform(1.1, 0.01, 0.02, 1.2, 3, 4);
    const alpha = subject.context.globalAlpha;
    const transform = subject.context.getTransform();
    subject.layer.draw(subject.context);
    expect(subject.context.globalAlpha).toBe(alpha);
    expect(subject.context.globalCompositeOperation).toBe("multiply");
    expect(subject.context.filter).toBe("blur(0.3px)");
    expect(subject.context.getTransform()).toEqual(transform);
  });
});
