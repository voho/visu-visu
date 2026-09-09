import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { randomPalette } from "../src/render/palette.js";
import {
  buildLightingTimeline, buildLightingGhostSchedule, createLightingPreviewHandler, prepareLightingPalette, encodeLightingMaterialMaps, LIGHTING_TIMELINE_STRIDE,
  parseByteRange, parseLightingPreviewArgs,
} from "../src/preview/lighting-server.js";
import { analyzeAudio } from "../src/audio/analyze.js";
import { surfaceFeatureSamples, sampleSurfaceFeature } from "../src/render/surface-signal.js";
import type { AnalysisFrame } from "../src/types.js";
import { frozenCloudAt, frozenCloudPlan, FROZEN_CLOUD_LIFETIME } from "../src/render/frozen-cloud.js";
import { prepareArtwork } from "../src/render/artwork.js";
import { audioFieldAt } from "../src/render/audio-field.js";
import { previewCamera, preparePreviewCamera, setPreviewHero, createSculptureSampler } from "../src/preview/lighting-camera.js";
import { createSurfaceFragments, selectVisibleFragments } from "../src/preview/lighting-fragments.js";
import { deriveSceneDynamics } from "../src/render/scene-dynamics.js";
import { deriveMusicMotion } from "../src/render/music-motion.js";
import { lightingAt } from "../src/render/lighting.js";
import { lensingSamples } from "../src/preview/lighting-lensing.js";

let directory: string;
let audioPath: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-lighting-preview-"));
  audioPath = join(directory, "song.wav");
  await writeFile(audioPath, "0123456789");
  for (const [name, color] of [["warm", "#d02718"], ["cool", "#193ed8"], ["gray", "#828282"]]) {
    const cover = createCanvas(48, 48);
    const context = cover.getContext("2d");
    context.fillStyle = color!;
    context.fillRect(0, 0, 48, 48);
    await writeFile(join(directory, `${name}.png`), cover.toBuffer("image/png"));
  }
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("live lighting preview", () => {
  test("parses explicit paths and rejects ambiguous or invalid CLI options", () => {
    expect(parseLightingPreviewArgs(["--help"])).toBeNull();
    const options = parseLightingPreviewArgs(["--", "my song.wav", "--image", "cover.png", "--title", "Title", "--artist", "Artist", "--port", "4199", "--low-flash"]);
    expect(options?.audioPath.endsWith("my song.wav")).toBe(true);
    expect(options?.imagePath?.endsWith("cover.png")).toBe(true);
    expect(options?.port).toBe(4199);
    expect(options?.lowFlash).toBe(true);
    for (const args of [[], ["one.wav", "two.wav"], ["one.wav", "--port", "0"], ["one.wav", "--port", "4180.5"], ["one.wav", "--port", "65536"], ["one.wav", "--unknown"]]) {
      expect(() => parseLightingPreviewArgs(args)).toThrow();
    }
  });

  test("supports browser audio seek ranges and rejects unsafe/out-of-file ranges", () => {
    expect(parseByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange("bytes=-30", 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=8-30", 10)).toEqual({ start: 8, end: 9 });
    for (const range of ["bytes=10-", "bytes=-0", "bytes=5-2", "bytes=0-1,3-4", "bytes=-", "bytes=9007199254740999-", "items=0-1"]) {
      expect(parseByteRange(range, 10)).toBeNull();
    }
  });

  test("serves explicit files only with correct range, HEAD, and local host handling", async () => {
    const timeline = new Float32Array([1, 2, 3]);
    const handler = createLightingPreviewHandler({
      title: "<script>literal credit</script>", artist: "Artist", duration: 1,
      fps: 60, frameCount: 1, stride: LIGHTING_TIMELINE_STRIDE, hasArtwork: false, palette: randomPalette("preview-test"),
    }, timeline, new Map([["/audio", audioPath]]));
    const response = await handler(new Request("http://127.0.0.1:4180/audio", { headers: { Range: "bytes=3-5" } }));
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 3-5/10");
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(await response.text()).toBe("345");
    const head = await handler(new Request("http://localhost/audio", { method: "HEAD" }));
    expect(head.headers.get("Content-Length")).toBe("10");
    expect(await head.text()).toBe("");
    expect((await handler(new Request("http://localhost/audio", { headers: { Range: "bytes=10-" } }))).status).toBe(416);
    expect((await handler(new Request("http://localhost/audio", { method: "POST" }))).status).toBe(405);
    expect((await handler(new Request("http://hostile.example/audio"))).status).toBe(403);
    for (const path of ["/etc/passwd", "/../../package.json", "/%2e%2e/package.json", "/artwork", "/audio/other.wav"]) {
      expect((await handler(new Request(`http://127.0.0.1${path}`))).status).toBe(404);
    }
    const profile = await handler(new Request("http://127.0.0.1/profile.json"));
    expect(await profile.json()).toMatchObject({ title: "<script>literal credit</script>" });
    expect(profile.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const binary = await handler(new Request("http://127.0.0.1/timeline.f32"));
    expect(Array.from(new Float32Array(await binary.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  test("cover palettes drive distinct profiles and keep grayscale lighting neutral", async () => {
    const [warm, cool, gray, fallback] = await Promise.all([
      prepareLightingPalette(join(directory, "warm.png"), "same-seed"),
      prepareLightingPalette(join(directory, "cool.png"), "same-seed"),
      prepareLightingPalette(join(directory, "gray.png"), "same-seed"),
      prepareLightingPalette(undefined, "same-seed"),
    ]);
    expect(warm.source).toBe("artwork");
    expect(cool.source).toBe("artwork");
    expect(gray.source).toBe("artwork");
    expect(fallback.source).toBe("random");
    expect(warm.colors).not.toEqual(cool.colors);
    expect(fallback).toEqual(await prepareLightingPalette(undefined, "same-seed"));
    expect(fallback).not.toEqual(await prepareLightingPalette(undefined, "other-seed"));
    for (const color of gray.colors) {
      expect(color[0]).toBeCloseTo(color[1], 6);
      expect(color[1]).toBeCloseTo(color[2], 6);
    }
    const samples = Float32Array.from({ length: 24_000 }, (_, index) => Math.sin(index / 24_000 * Math.PI * 2 * 65) * 0.5);
    const analysis = analyzeAudio({ samples, sampleRate: 24_000, duration: 1, sourceHash: "0".repeat(64), sourceFileHash: "0".repeat(64) }, 60, 64);
    const warmTimeline = buildLightingTimeline(analysis, "same-seed", false, warm);
    const coolTimeline = buildLightingTimeline(analysis, "same-seed", false, cool);
    const grayTimeline = buildLightingTimeline(analysis, "same-seed", false, gray);
    expect(Array.from(warmTimeline.slice(15, 18))).not.toEqual(Array.from(coolTimeline.slice(15, 18)));
    for (let frame = 0; frame < 60; frame++) for (const colorOffset of [8, 15, 23, 31]) {
      const offset = frame * LIGHTING_TIMELINE_STRIDE + colorOffset;
      expect(grayTimeline[offset]!).toBeCloseTo(grayTimeline[offset + 1]!, 6);
      expect(grayTimeline[offset + 1]!).toBeCloseTo(grayTimeline[offset + 2]!, 6);
    }
    const profile = { title: "Track", artist: "Artist", duration: 1, fps: 60, frameCount: 60, stride: LIGHTING_TIMELINE_STRIDE, hasArtwork: true };
    const warmHandler = createLightingPreviewHandler({ ...profile, palette: warm }, warmTimeline, new Map());
    const coolHandler = createLightingPreviewHandler({ ...profile, palette: cool }, coolTimeline, new Map());
    const warmResponse = await (await warmHandler(new Request("http://127.0.0.1/profile.json"))).json();
    const coolResponse = await (await coolHandler(new Request("http://127.0.0.1/profile.json"))).json();
    expect(warmResponse).not.toEqual(coolResponse);
  });

  test("serves the original cover and its full-source relief maps without backdrop masking", async () => {
    const path = join(directory, "warm.png");
    const artwork = await prepareArtwork(path, 1920, 1080);
    expect(artwork?.objectMaterial).toBeDefined();
    const material = artwork!.objectMaterial!;
    expect(material.albedo[3]).toBe(255);
    expect(material.albedo.at(-1)).toBe(255);
    const maps = encodeLightingMaterialMaps(material);
    const handler = createLightingPreviewHandler({
      title: "Track", artist: "Artist", duration: 1, fps: 60, frameCount: 1,
      stride: LIGHTING_TIMELINE_STRIDE, hasArtwork: true, palette: artwork!.palette,
    }, new Float32Array(LIGHTING_TIMELINE_STRIDE), new Map([["/artwork", path]]), maps);
    const source = await handler(new Request("http://127.0.0.1/artwork"));
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(new Uint8Array(await Bun.file(path).arrayBuffer()));
    for (const [route, bytes] of maps) {
      const response = await handler(new Request(`http://localhost${route}`));
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
      const head = await handler(new Request(`http://localhost${route}`, { method: "HEAD" }));
      expect(head.headers.get("Content-Length")).toBe(String(bytes.length));
      expect(await head.text()).toBe("");
      const image = await loadImage(new Uint8Array(bytes));
      expect([image.width, image.height]).toEqual([material.width, material.height]);
    }
    expect((await handler(new Request("http://localhost/object-albedo.png"))).status).toBe(404);
  });

  test("uniform timeline is deterministic, finite, and carries distinct animated light positions", () => {
    const samples = Float32Array.from({ length: 24_000 }, (_, index) => Math.sin(index / 24_000 * Math.PI * 2 * 65) * 0.5);
    const analysis = analyzeAudio({ samples, sampleRate: 24_000, duration: 1, sourceHash: "0".repeat(64), sourceFileHash: "0".repeat(64) }, 60, 64);
    const timeline = buildLightingTimeline(analysis, "test-lighting");
    expect(timeline.length).toBe(60 * LIGHTING_TIMELINE_STRIDE);
    expect(Array.from(timeline).every(Number.isFinite)).toBe(true);
    expect(timeline).toEqual(buildLightingTimeline(analysis, "test-lighting"));
    expect(timeline[12]).not.toBe(timeline[59 * LIGHTING_TIMELINE_STRIDE + 12]);
    expect(timeline.slice(12, 15)).not.toEqual(timeline.slice(20, 23));
    expect(timeline[11]).toBeGreaterThan(0);
    expect(Array.from(timeline.slice(36, 100))).toEqual(Array.from(surfaceFeatureSamples(analysis.frames[0]!)));
    expect(timeline.slice(36, 68).some(value => value > 0)).toBe(true);
    expect(timeline.slice(68, 100).some(value => value < 0)).toBe(true);
    expect(timeline.slice(68, 100).some(value => value > 0)).toBe(true);
    expect(timeline.slice(100, 132).some(value => value > 0)).toBe(true);
    expect(timeline[134]).toBeCloseTo(0.52, 6);
    expect(Math.hypot(timeline[132]!, timeline[133]!)).toBeCloseTo(1, 6);
    const ghosts = buildLightingGhostSchedule(analysis);
    expect(ghosts.lifetime).toBe(FROZEN_CLOUD_LIFETIME);
    expect(ghosts.events).toEqual(frozenCloudPlan(analysis));
    expect(ghosts.envelope[0]).toEqual({ scale: 1, opacity: 0, blur: 0.006, dissolve: 0 });
    for (const age of [0.6, 1.5, 4, 7]) {
      const expected = frozenCloudAt({ id: 0, captureTime: 0, strength: 1 }, age)!;
      expect(ghosts.envelope[Math.round(age * ghosts.envelopeFps)]).toEqual({
        scale: expected.scale, opacity: expected.opacity, blur: expected.blur, dissolve: expected.dissolve,
      });
    }
    expect(ghosts.envelope.at(-1)!.opacity).toBeLessThan(1e-10);
    expect(timeline.length / 60).toBe(181);
    const dynamics = deriveSceneDynamics(analysis, 59 / 60);
    const palette = randomPalette("test-lighting");
    const lightMotion = { ...deriveMusicMotion(analysis, 59 / 60), bassEnergy: dynamics.body.energy,
      midEnergy: dynamics.detail.energy, trebleEnergy: dynamics.spark.energy,
      bassPulse: dynamics.impact.energy, treblePulse: dynamics.spark.energy, sustain: dynamics.cloud.energy };
    const phase = palette.anchorHue + dynamics.drift.clock * 22 + dynamics.cloud.energy * 18
      + dynamics.body.energy * 24 + dynamics.detail.energy * 36 + dynamics.spark.energy * 12;
    const lights = lightingAt(lightMotion, 59 / 60, "test-lighting", phase, false, analysis.frames[59]!.spectrum, palette);
    for (let light = 0; light < 3; light += 1) {
      const offset = 59 * LIGHTING_TIMELINE_STRIDE + 12 + light * 8;
      expect(timeline[offset + 6]!).toBeCloseTo(lights.lights[light]!.intensity, 6);
      expect(timeline[offset + 7]!).toBeCloseTo(lights.lights[light]!.falloff, 6);
    }
    const field = audioFieldAt(analysis, 59 / 60);
    const fieldOffset = 59 * LIGHTING_TIMELINE_STRIDE + 147;
    expect(timeline[fieldOffset]!).toBeCloseTo(field.fast, 6);
    expect(timeline[fieldOffset + 1]!).toBeCloseTo(field.slow, 6);
    expect(Array.from(timeline.slice(fieldOffset + 2, fieldOffset + 34))).toEqual(Array.from(field.spectrum));
    for (let layer = 0; layer < 6; layer += 1) {
      const energy = timeline[59 * LIGHTING_TIMELINE_STRIDE + 135 + layer * 2]!;
      expect(energy).toBeGreaterThanOrEqual(0);
      expect(energy).toBeLessThanOrEqual(1);
      expect(timeline[59 * LIGHTING_TIMELINE_STRIDE + 136 + layer * 2]!).toBeGreaterThan(0);
    }
  });

  test("camera history coordinates survive capture resizing and broad motion stays bounded", () => {
    const values = new Float32Array(LIGHTING_TIMELINE_STRIDE);
    for (let index = 135; index < 147; index += 2) values[index] = 1;
    for (let time = 0; time <= 180; time += 3) {
      for (let index = 136; index < 147; index += 2) values[index] = time * (index - 134) * 0.15;
      const camera = previewCamera(values, 1920, 1080);
      expect(camera).toEqual(previewCamera(values, 480, 270));
      expect(previewCamera(values, 390, 844)).toEqual(previewCamera(values, 195, 422));
      expect(Math.abs(camera.roll - Math.PI / 2)).toBeLessThanOrEqual(0.084);
      expect(camera.zoom).toBeGreaterThan(0.84);
      expect(camera.zoom).toBeLessThan(1.35);
      expect(camera.x).toBeGreaterThan(0.485);
      expect(camera.x).toBeLessThan(0.515);
    }
  });

  test("preflight fitting is deterministic across seeks and caps intersample zoom speed", () => {
    const profile = { duration: 4, fps: 60, frameCount: 241, stride: LIGHTING_TIMELINE_STRIDE };
    const timeline = new Float32Array(profile.frameCount * profile.stride);
    for (let frame = 0; frame < profile.frameCount; frame++) {
      const time = frame / 60, row = timeline.subarray(frame * profile.stride, (frame + 1) * profile.stride);
      row[0] = time * 0.5; row[1] = time * 1.7;
      for (let layer = 0; layer < 6; layer++) {
        row[135 + layer * 2] = 0.4 + Math.sin(time * (layer + 1)) * 0.15;
        row[136 + layer * 2] = time * (layer + 1) * 0.2;
      }
      for (let band = 0; band < 32; band++) row[36 + band] = 0.3 + Math.sin(time * 4 + band) * 0.15;
    }
    const row = (frame: number) => timeline.subarray(frame * profile.stride, (frame + 1) * profile.stride);
    setPreviewHero(1920, 1080, 734);
    preparePreviewCamera(timeline, profile);
    const beforeSeek = previewCamera(row(107), 1920, 1080);
    previewCamera(row(230), 1920, 1080);
    previewCamera(row(5), 1920, 1080);
    expect(previewCamera(row(107), 1920, 1080)).toEqual(beforeSeek);
    expect(previewCamera(row(107), 480, 270)).toEqual(beforeSeek);
    let previous = previewCamera(row(0), 1920, 1080);
    for (let frame = 1; frame < profile.frameCount; frame++) {
      const camera = previewCamera(row(frame), 1920, 1080);
      expect(Object.values(camera).every(Number.isFinite)).toBe(true);
      expect(Math.abs(camera.zoom - previous.zoom)).toBeLessThan(0.012);
      previous = camera;
    }
    const beyondEnd = new Float32Array(row(240)); beyondEnd[0] = 1e4;
    expect(Object.values(previewCamera(beyondEnd, 1920, 1080)).every(Number.isFinite)).toBe(true);
    preparePreviewCamera(new Float32Array(timeline.length), profile);
    expect(previewCamera(row(107), 1920, 1080)).not.toEqual(beforeSeek);
    preparePreviewCamera(timeline, profile);
    expect(previewCamera(row(107), 1920, 1080)).toEqual(beforeSeek);
  });

  test("cover lens brackets stay causal and fit their bounded geometry atlas", () => {
    expect(lensingSamples(0)).toEqual([
      { a: 0, b: 0, blend: 0, weight: 0.5 },
      { a: 0, b: 0, blend: 0, weight: 0.32 },
      { a: 0, b: 0, blend: 0, weight: 0.18 },
    ]);
    for (const time of [0.01, 0.35, 0.70, 1.15, 3.05, 29.9, 107.967]) {
      const samples = lensingSamples(time);
      expect(samples.reduce((sum, sample) => sum + sample.weight, 0)).toBeCloseTo(1, 10);
      const ids = new Set([Math.floor(time * 10)]);
      for (const sample of samples) {
        expect(sample.a / 10).toBeLessThanOrEqual(time);
        expect(sample.b / 10).toBeLessThanOrEqual(time);
        expect(sample.blend).toBeGreaterThanOrEqual(0);
        expect(sample.blend).toBeLessThanOrEqual(1);
        ids.add(sample.a); ids.add(sample.b);
      }
      expect(new Set([...ids].map(id => id % 16)).size).toBe(ids.size);
    }
    const beforeSeek = lensingSamples(29.9);
    lensingSamples(107.967);
    expect(lensingSamples(29.9)).toEqual(beforeSeek);
  });

  test("detached patches keep actual captured surface coordinates and bounded size", () => {
    const values = new Float32Array(LIGHTING_TIMELINE_STRIDE);
    values[0] = 7; values[1] = 14;
    for (let layer = 0; layer < 6; layer++) {
      values[135 + layer * 2] = 0.5;
      values[136 + layer * 2] = 4 + layer;
    }
    for (let band = 0; band < 32; band++) values[36 + band] = 0.3;
    const event = { id: 100, captureTime: 1, strength: 0.9 };
    const pieces = selectVisibleFragments(values, event, "patch-test");
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.length).toBeLessThanOrEqual(6);
    expect(selectVisibleFragments(values, event, "patch-test")).toEqual(pieces);
    const sample = createSculptureSampler(values);
    for (const piece of pieces) {
      expect(piece.anchor).toEqual(sample(piece.u, piece.v));
      expect(piece.anchor.every(Number.isFinite)).toBe(true);
      expect(piece.halfU).toBeGreaterThan(0);
      expect(piece.halfV).toBeGreaterThan(0);
      const points = Array.from({ length: 24 }, (_, index) => {
        const angle = index / 24 * Math.PI * 2;
        const [x, y, z] = sample(piece.u + Math.cos(angle) * piece.halfU, piece.v + Math.sin(angle) * piece.halfV);
        return [x * 3.8 / (3.8 - z), y * 3.8 / (3.8 - z)];
      });
      for (let axis = 0; axis < 2; axis++) {
        expect(Math.max(...points.map(p => p[axis]!)) - Math.min(...points.map(p => p[axis]!))).toBeLessThan(0.32);
      }
    }
  });

  test("fragment captures freeze music data, heal their gaps, and restore after seeking", () => {
    const profile = { stride: LIGHTING_TIMELINE_STRIDE, seed: "frozen-patches", ghosts: {
      events: Array.from({ length: 5 }, (_, index) => ({ id: index, captureTime: index * 3, strength: 0.9 })),
    } };
    const source = new Float32Array(profile.stride);
    for (let band = 0; band < 32; band++) source[36 + band] = 0.25;
    let capturedSignal: Float32Array | undefined;
    let drawCount = 0;
    let drawOrder: string[] = [];
    const fragments = createSurfaceFragments(profile, (time, out) => {
      out.set(source); out[0] = time * 0.6; out[1] = time * 1.8;
      for (let layer = 0; layer < 6; layer++) { out[135 + layer * 2] = 0.5; out[136 + layer * 2] = time * (layer + 1); }
    }, signal => { capturedSignal = new Float32Array(signal); }, (_signal, _width, _height, _mode, options) => {
      expect(options.fragment?.bounds).toHaveLength(4);
      expect(options.fragment?.motion.every(Number.isFinite)).toBe(true);
      drawOrder.push(options.fragment!.bounds.join(","));
      drawCount++;
    });
    fragments.update(1.2);
    const first = fragments.inspect(1.2).snapshots[0]!;
    expect(first.pieces.length).toBeGreaterThan(0);
    const original = first.sourceHash;
    source[36] = 0.95;
    fragments.update(1.3); fragments.draw(1.3, 1920, 1080);
    expect(fragments.inspect(1.3).snapshots[0]!.sourceHash).toBe(original);
    expect(capturedSignal![36]).toBeCloseTo(0.25, 6);
    expect(drawCount).toBeGreaterThan(0);
    fragments.update(2.8);
    expect(fragments.tears(2.8)).toHaveLength(0);
    fragments.update(6.15);
    expect(fragments.inspect(6.15).cached).toBe(3);
    expect(fragments.inspect(6.15).snapshots.reduce((sum, event) => sum + event.pieces.length, 0)).toBeLessThanOrEqual(18);
    expect(fragments.tears(6.15).length).toBeLessThanOrEqual(6);
    source[36] = 0.25;
    fragments.update(9.2); fragments.update(1.2);
    expect(fragments.inspect(1.2).snapshots[0]!.sourceHash).toBe(original);
    fragments.update(100);
    expect(fragments.inspect(100).cached).toBe(0);
    fragments.update(1.2); fragments.update(4.8);
    drawOrder = []; fragments.draw(4.8, 1920, 1080);
    const forwardOrder = [...drawOrder], forwardSnapshots = fragments.inspect(4.8).snapshots;
    fragments.update(7.2); fragments.update(4.8);
    drawOrder = []; fragments.draw(4.8, 1920, 1080);
    expect(drawOrder).toEqual(forwardOrder);
    expect(fragments.inspect(4.8).snapshots).toEqual(forwardSnapshots);
  });
});


describe("shared spectrum and waveform surface signals", () => {
  function frame(spectrum: number[], waveform: number[]): AnalysisFrame {
    return { spectrum: new Float32Array(spectrum), waveform: new Float32Array(waveform), rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, centroid: 0, flux: 0, onset: 0 };
  }
  test("preserves averaged source energies, waveform sign, and interval boundaries", () => {
    const source = frame(Array.from({ length: 64 }, (_, index) => index / 64), Array.from({ length: 192 }, (_, index) => index < 96 ? -0.8 : 0.4));
    const signals = surfaceFeatureSamples(source);
    expect(signals.length).toBe(64);
    expect(signals[0]).toBeCloseTo(0.5 / 64, 6);
    expect(signals[31]).toBeCloseTo(62.5 / 64, 6);
    expect(signals[32]).toBeCloseTo(-0.8, 6);
    expect(signals[47]).toBeCloseTo(-0.8, 6);
    expect(signals[48]).toBeCloseTo(0.4, 6);
    expect(surfaceFeatureSamples(source)).toBe(signals);
    expect(sampleSurfaceFeature(signals, "spectrum", 0)).toBe(signals[0]!);
    expect(sampleSurfaceFeature(signals, "spectrum", 1)).toBe(signals[31]!);
    expect(sampleSurfaceFeature(signals, "waveform", 0.5)).toBeCloseTo(-0.2, 6);
  });
  test("upsamples fewer source bands and bounds malformed features", () => {
    const signals = surfaceFeatureSamples(frame([1, 0.25], [-1, 1]));
    expect(Array.from(signals.slice(0, 16))).toEqual(new Array(16).fill(1));
    expect(Array.from(signals.slice(16, 32))).toEqual(new Array(16).fill(0.25));
    expect(sampleSurfaceFeature(signals, "waveform", 0)).toBe(-1);
    expect(sampleSurfaceFeature(signals, "waveform", 1)).toBe(1);
    expect(Array.from(surfaceFeatureSamples(frame([NaN, Infinity, -1], []))).every(value => value === 0)).toBe(true);
  });
});
