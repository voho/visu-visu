import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeAudio } from "../src/audio/analyze.js";
import { decodeAudio } from "../src/audio/decode.js";
import { parseProjectConfig } from "../src/config.js";
import { FfmpegEncoder, resolveFadeDurations } from "../src/render/encoder.js";
import { renderVideo } from "../src/render/render.js";
import type { AudioAnalysis, RenderRequest } from "../src/types.js";

const directory = join(tmpdir(), `visu-visu-clip-fades-${process.pid}`);
const audioPath = join(directory, "fixture.wav");
const width = 160;
const height = 160;
const fps = 20;
const config = parseProjectConfig({
  output: { width, height, fps, preset: "ultrafast", crf: 18, fadeSeconds: 3 },
  visual: { spectrumBands: 16, bokehCount: 0, grain: 0 },
});
let analysis: AudioAnalysis;

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  // Silence before 1.25s makes an accidental start=0 audio trim observable.
  const fixture = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc=if(lt(t\\,1.25)\\,0\\,0.2*sin(2*PI*440*t)):d=8:s=48000",
    "-c:a", "pcm_s16le", audioPath,
  ], { encoding: "utf8" });
  if (fixture.status !== 0) throw new Error(`Could not create clip fixture: ${fixture.stderr}`);
  analysis = analyzeAudio(await decodeAudio(audioPath), fps, 16);
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function decodeVideo(path: string): Buffer {
  const decoded = spawnSync("ffmpeg", [
    "-v", "error", "-i", path, "-map", "0:v:0", "-vf", "scale=1:1",
    "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ]);
  if (decoded.status !== 0) throw new Error(`Could not decode clip frames: ${decoded.stderr.toString()}`);
  return decoded.stdout;
}

function decodeAudioSamples(path: string): Buffer {
  const decoded = spawnSync("ffmpeg", [
    "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000",
    "-f", "f32le", "pipe:1",
  ], { maxBuffer: 4 * 1024 * 1024 });
  if (decoded.status !== 0) throw new Error(`Could not decode clip audio: ${decoded.stderr.toString()}`);
  return decoded.stdout;
}

function audioRms(samples: Buffer, start: number, end: number): number {
  const first = Math.round(start * 48_000);
  const last = Math.min(Math.round(end * 48_000), samples.byteLength / 4);
  let sum = 0;
  for (let index = first; index < last; index += 1) sum += samples.readFloatLE(index * 4) ** 2;
  return Math.sqrt(sum / Math.max(1, last - first));
}

describe("clip rendering and fade overrides", () => {
  test("encodes a nonzero excerpt with a quick intro and matching three-second audio/video decay", async () => {
    const outputPath = join(directory, "asymmetric.mp4");
    const duration = 4;
    const frameCount = fps * duration;
    const encoder = await FfmpegEncoder.create({
      audioPath, outputPath, config, start: 2, duration, frameCount,
      inputWidth: width, inputHeight: height, overwrite: true,
      fadeInSeconds: 0.35, fadeOutSeconds: 3,
    });
    try {
      const white = Buffer.alloc(width * height * 4, 255);
      for (let frame = 0; frame < frameCount; frame += 1) await encoder.write(white);
      await encoder.finish();
    } catch (error) {
      encoder.abort();
      throw error;
    }
    const video = decodeVideo(outputPath);
    expect(video.byteLength).toBe(frameCount * 3);
    const videoAt = (seconds: number): number => video[Math.round(seconds * fps) * 3] ?? 0;
    const fullVideo = videoAt(0.7);
    expect(fullVideo).toBeGreaterThan(248);
    expect(videoAt(0)).toBeLessThan(2);
    expect(videoAt(0.15) / fullVideo).toBeCloseTo(0.15 / 0.35, 1);
    expect(videoAt(1)).toBeGreaterThan(248);
    expect(videoAt(2.5) / fullVideo).toBeCloseTo(0.5, 1);
    expect(videoAt(duration - 1 / fps)).toBeLessThan(8);
    const audio = decodeAudioSamples(outputPath);
    const audioAt = (time: number): number => audioRms(audio, time - 0.015, time + 0.015);
    const fullAudio = audioAt(0.7);
    expect(fullAudio).toBeGreaterThan(0.1);
    expect(audioRms(audio, 0, 0.01) / fullAudio).toBeLessThan(0.05);
    expect(audioAt(0.15) / fullAudio).toBeCloseTo(0.15 / 0.35, 1);
    expect(audioAt(1) / fullAudio).toBeCloseTo(1, 1);
    expect(audioAt(2.5) / fullAudio).toBeCloseTo(0.5, 1);
    expect(audioRms(audio, duration - 0.02, duration) / fullAudio).toBeLessThan(0.015);
    // The same timestamps must have the same gain in the delivered picture and sound.
    for (const time of [0.15, 2, 2.5, 3.5]) {
      expect(Math.abs(videoAt(time) / fullVideo - audioAt(time) / fullAudio)).toBeLessThan(0.035);
    }
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", outputPath,
    ], { encoding: "utf8" });
    expect(probe.status).toBe(0);
    const streams = (JSON.parse(probe.stdout) as { streams: Array<{ duration: string }> }).streams;
    for (const stream of streams) expect(Number(stream.duration)).toBeCloseTo(duration, 3);
  }, 15_000);

  test("renderVideo forwards explicit zero fades at an excerpt start", async () => {
    const outputPath = join(directory, "no-fades.mp4");
    const result = await renderVideo({
      audioPath, outputPath, config, start: 2, duration: 0.21, overwrite: true,
      fadeInSeconds: 0, fadeOutSeconds: 0,
    }, analysis);
    expect(result.frames).toBe(5);
    expect(result.duration).toBe(0.25);
    const video = decodeVideo(outputPath);
    expect(video[0]).toBeGreaterThan(4);
    expect(video[video.byteLength - 3]).toBeGreaterThan(4);
    const audio = decodeAudioSamples(outputPath);
    expect(audioRms(audio, 0.025, 0.075)).toBeGreaterThan(0.1);
    expect(audioRms(audio, 0.175, 0.225)).toBeGreaterThan(0.1);
  }, 15_000);

  test("short clips fit asymmetric fades proportionally while ordinary renders retain equal fades", () => {
    expect(resolveFadeDurations(2, 3)).toEqual({ fadeIn: 1, fadeOut: 1 });
    const fitted = resolveFadeDurations(2, 3, 0.35, 3);
    expect(fitted.fadeIn + fitted.fadeOut).toBeCloseTo(2, 12);
    expect(fitted.fadeOut / fitted.fadeIn).toBeCloseTo(3 / 0.35, 12);
    expect(resolveFadeDurations(10, 3, 0)).toEqual({ fadeIn: 0, fadeOut: 3 });
  });

  test("rejects invalid timing and fades before overwriting an existing file", async () => {
    const outputPath = join(directory, "keep.mp4");
    await writeFile(outputPath, "keep this output");
    const request: RenderRequest = { audioPath, outputPath, config, start: 2, duration: 1, overwrite: true };
    const cases: Array<{ patch: Partial<RenderRequest>; error: string }> = [
      ...[NaN, Infinity, -Infinity, -1].map((start) => ({ patch: { start }, error: "Start time must be a finite number" })),
      ...[NaN, Infinity, -Infinity, 0, -1].map((duration) => ({ patch: { duration }, error: "Render duration must be a finite number" })),
      ...[NaN, Infinity, -1, 30.1].flatMap((fade) => [
        { patch: { fadeInSeconds: fade }, error: "fadeInSeconds must be a finite number between 0 and 30" },
        { patch: { fadeOutSeconds: fade }, error: "fadeOutSeconds must be a finite number between 0 and 30" },
      ]),
    ];
    for (const { patch, error } of cases) {
      await expect(renderVideo({ ...request, ...patch }, analysis)).rejects.toThrow(error);
      expect(await readFile(outputPath, "utf8")).toBe("keep this output");
    }
    const untouchedDirectory = join(directory, "not-created");
    await expect(FfmpegEncoder.create({
      audioPath, outputPath: join(untouchedDirectory, "video.mp4"), config, start: 2,
      duration: 1, frameCount: fps, inputWidth: width, inputHeight: height,
      overwrite: true, fadeOutSeconds: NaN,
    })).rejects.toThrow("fadeOutSeconds must be a finite number");
    await expect(access(untouchedDirectory)).rejects.toThrow();
  });
});
