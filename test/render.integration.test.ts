import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeAudio } from "../src/audio/analyze.js";
import { decodeAudio } from "../src/audio/decode.js";
import { parseProjectConfig } from "../src/config.js";
import { DELIVERY_AUDIO_BITRATE } from "../src/render/encoder.js";
import { renderVideo } from "../src/render/render.js";
import type { AudioAnalysis } from "../src/types.js";

const directory = join(tmpdir(), `visu-visu-render-test-${process.pid}`);
const audioPath = join(directory, "fixture.wav");
const outputPath = join(directory, "duration.mp4");
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
      "sine=frequency=220:duration=1:sample_rate=24000",
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
  test("quantizes duration to complete frames and muxes matching A/V output", async () => {
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
