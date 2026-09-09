import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLightingTimeline, createLightingPreviewHandler, LIGHTING_TIMELINE_STRIDE,
  parseByteRange, parseLightingPreviewArgs,
} from "../src/preview/lighting-server.js";
import { analyzeAudio } from "../src/audio/analyze.js";
import { surfaceFeatureSamples, sampleSurfaceFeature } from "../src/render/surface-signal.js";
import type { AnalysisFrame } from "../src/types.js";

let directory: string;
let audioPath: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-lighting-preview-"));
  audioPath = join(directory, "song.wav");
  await writeFile(audioPath, "0123456789");
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
      fps: 60, frameCount: 1, stride: LIGHTING_TIMELINE_STRIDE, hasArtwork: false,
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
    expect(timeline.length / 60).toBe(147);
    for (let layer = 0; layer < 6; layer += 1) {
      const energy = timeline[59 * LIGHTING_TIMELINE_STRIDE + 135 + layer * 2]!;
      expect(energy).toBeGreaterThanOrEqual(0);
      expect(energy).toBeLessThanOrEqual(1);
      expect(timeline[59 * LIGHTING_TIMELINE_STRIDE + 136 + layer * 2]!).toBeGreaterThan(0);
    }
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
