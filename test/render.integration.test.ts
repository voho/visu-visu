import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeAudio } from "../src/audio/analyze.js";
import { decodeAudio } from "../src/audio/decode.js";
import { parseProjectConfig } from "../src/config.js";
import { DELIVERY_AUDIO_BITRATE, FfmpegEncoder } from "../src/render/encoder.js";
import { renderVideo } from "../src/render/render.js";
import type { AudioAnalysis } from "../src/types.js";

const directory = join(tmpdir(), `visu-visu-render-test-${process.pid}`);
const audioPath = join(directory, "fixture.wav");
const outputPath = join(directory, "duration.mp4");
const fadeOutputPath = join(directory, "fade.mp4");
let analysis: AudioAnalysis;

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  const fixture = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=7:sample_rate=24000",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ],
    { encoding: "utf8" },
  );
  if (fixture.status !== 0) throw new Error(`Could not create FFmpeg fixture: ${fixture.stderr}`);
  analysis = analyzeAudio(await decodeAudio(audioPath), 12, 16);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("video render integration", () => {
  test("quantizes duration, fades both ends, and muxes matching A/V output", async () => {
    const config = parseProjectConfig({
      output: { width: 160, height: 160, fps: 12 },
      visual: { spectrumBands: 16, bokehCount: 4, grain: 0 },
    });
    const result = await renderVideo(
      {
        audioPath,
        outputPath,
        config,
        start: 0,
        duration: 0.51,
        overwrite: true,
      },
      analysis,
    );
    expect(result.frames).toBe(7);
    expect(result.duration).toBeCloseTo(7 / 12, 8);
    expect(result.renderWidth).toBe(160);
    expect(result.renderHeight).toBe(160);

    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_frames",
        "-show_entries",
        "stream=codec_name,codec_type,profile,pix_fmt,has_b_frames,refs,nb_read_frames,duration,width,height,r_frame_rate,bit_rate,sample_rate,channels,color_range,color_space,color_transfer,color_primaries:frame=key_frame,pict_type",
        "-of",
        "json",
        outputPath,
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) throw new Error(`Could not probe rendered fixture: ${probe.stderr}`);
    const parsed = JSON.parse(probe.stdout) as {
      streams?: Array<{
        codec_name?: string;
        codec_type?: string;
        profile?: string;
        pix_fmt?: string;
        has_b_frames?: number;
        refs?: number;
        nb_read_frames?: string;
        duration?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        bit_rate?: string;
        sample_rate?: string;
        channels?: number;
        color_range?: string;
        color_space?: string;
        color_transfer?: string;
        color_primaries?: string;
      }>;
      frames?: Array<{
        key_frame?: number;
        pict_type?: string;
      }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
    expect(video?.nb_read_frames).toBe("7");
    expect(Number(video?.duration)).toBeCloseTo(7 / 12, 3);
    expect(video?.width).toBe(160);
    expect(video?.height).toBe(160);
    expect(video?.r_frame_rate).toBe("12/1");
    expect(video?.profile).toBe("High");
    expect(video?.pix_fmt).toBe("yuv420p");
    expect(video?.has_b_frames).toBe(2);
    expect(video?.refs).toBe(4);
    expect(video?.color_range).toBe("tv");
    expect(video?.color_space).toBe("bt709");
    expect(video?.color_transfer).toBe("bt709");
    expect(video?.color_primaries).toBe("bt709");
    expect(audio?.codec_name).toBe("aac");
    expect(audio?.profile).toBe("LC");
    expect(audio?.sample_rate).toBe("48000");
    expect(audio?.channels).toBe(2);
    expect(DELIVERY_AUDIO_BITRATE).toBeGreaterThanOrEqual(320_000);
    expect(Number(audio?.bit_rate)).toBeGreaterThan(0);

    const videoFrames = (parsed.frames ?? []).filter((frame) => frame.pict_type !== undefined);
    expect(
      videoFrames.flatMap((frame, index) => (frame.key_frame === 1 ? [index] : [])),
    ).toEqual([0, 6]);
    let consecutiveBFrames = 0;
    let maximumBFrames = 0;
    for (const frame of videoFrames) {
      consecutiveBFrames = frame.pict_type === "B" ? consecutiveBFrames + 1 : 0;
      maximumBFrames = Math.max(maximumBFrames, consecutiveBFrames);
    }
    expect(maximumBFrames).toBeLessThanOrEqual(2);

  });

  test("encodes complete three-second picture and silence fades", async () => {
    const width = 160;
    const height = 160;
    const fps = 12;
    const duration = 6.5;
    const frameCount = duration * fps;
    const config = parseProjectConfig({
      output: {
        width,
        height,
        fps,
        renderScale: 0.5,
        crf: 30,
        preset: "ultrafast",
        fadeSeconds: 3,
      },
      visual: { spectrumBands: 16, bokehCount: 0, grain: 0 },
    });
    const encoder = await FfmpegEncoder.create({
      audioPath,
      outputPath: fadeOutputPath,
      config,
      start: 0.5,
      duration,
      frameCount,
      inputWidth: width,
      inputHeight: height,
      overwrite: true,
    });
    const whiteFrame = Buffer.alloc(width * height * 4, 255);
    for (let index = 0; index < frameCount; index += 1) await encoder.write(whiteFrame);
    await encoder.finish();

    const decodedVideo = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        fadeOutputPath,
        "-map",
        "0:v:0",
        "-vf",
        "scale=32:32",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    if (decodedVideo.status !== 0) {
      throw new Error(`Could not decode fade video: ${decodedVideo.stderr.toString()}`);
    }
    const frameBytes = 32 * 32 * 3;
    expect(decodedVideo.stdout.byteLength).toBe(frameBytes * frameCount);
    const frameMean = (frameIndex: number): number => {
      const start = frameIndex * frameBytes;
      let sum = 0;
      for (let index = start; index < start + frameBytes; index += 1) {
        sum += decodedVideo.stdout[index] ?? 0;
      }
      return sum / frameBytes;
    };
    const middleMean = frameMean(Math.round(3.25 * fps));
    expect(frameMean(0)).toBeLessThan(2);
    expect(middleMean).toBeGreaterThan(240);
    expect(frameMean(frameCount - 1)).toBeLessThan(12);
    const videoFadeInRatio = frameMean(Math.round(1.5 * fps)) / middleMean;
    const videoFadeOutRatio = frameMean(Math.round(5 * fps)) / middleMean;
    expect(videoFadeInRatio).toBeGreaterThan(0.35);
    expect(videoFadeInRatio).toBeLessThan(0.65);
    expect(videoFadeOutRatio).toBeGreaterThan(0.35);
    expect(videoFadeOutRatio).toBeLessThan(0.65);

    const decodedAudio = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        fadeOutputPath,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    if (decodedAudio.status !== 0) {
      throw new Error(`Could not decode fade audio: ${decodedAudio.stderr.toString()}`);
    }
    const sampleCount = Math.floor(decodedAudio.stdout.byteLength / 4);
    const rms = (start: number, end: number): number => {
      let squareSum = 0;
      for (let index = start; index < end; index += 1) {
        const sample = decodedAudio.stdout.readFloatLE(index * 4);
        squareSum += sample * sample;
      }
      return Math.sqrt(squareSum / Math.max(1, end - start));
    };
    const sampleRate = 48_000;
    const windowSamples = Math.round(0.2 * sampleRate);
    const windowAt = (seconds: number): number => {
      const center = Math.round(seconds * sampleRate);
      return rms(center - windowSamples / 2, center + windowSamples / 2);
    };
    const middleRms = windowAt(3.25);
    expect(middleRms).toBeGreaterThan(0.02);
    expect(rms(0, windowSamples) / middleRms).toBeLessThan(0.1);
    expect(rms(sampleCount - windowSamples, sampleCount) / middleRms).toBeLessThan(0.1);
    const audioFadeInRatio = windowAt(1.5) / middleRms;
    const audioFadeOutRatio = windowAt(5) / middleRms;
    expect(audioFadeInRatio).toBeGreaterThan(0.35);
    expect(audioFadeInRatio).toBeLessThan(0.65);
    expect(audioFadeOutRatio).toBeGreaterThan(0.35);
    expect(audioFadeOutRatio).toBeLessThan(0.65);
  });

  test("rejects analysis sampled at a different output frame rate", async () => {
    const config = parseProjectConfig({
      output: { width: 160, height: 160, fps: 24 },
      visual: { spectrumBands: 16, bokehCount: 0, grain: 0 },
    });
    await expect(
      renderVideo(
        {
          audioPath,
          outputPath: join(directory, "mismatched-fps.mp4"),
          config,
          start: 0,
          duration: 0.25,
          overwrite: true,
        },
        analysis,
      ),
    ).rejects.toThrow("Analysis uses 12 fps but the project requests 24 fps");
  });
});
