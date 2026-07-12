import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeAudio } from "../src/audio/analyze.js";
import { decodeAudio } from "../src/audio/decode.js";
import { parseProjectConfig } from "../src/config.js";
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
      output: { width: 160, height: 160, fps: 12, crf: 30, preset: "ultrafast" },
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

    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames,duration,width,height,r_frame_rate",
        "-of",
        "json",
        outputPath,
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0) throw new Error(`Could not probe rendered fixture: ${probe.stderr}`);
    const parsed = JSON.parse(probe.stdout) as {
      streams?: Array<{
        nb_read_frames?: string;
        duration?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
      }>;
    };
    const stream = parsed.streams?.[0];
    expect(stream?.nb_read_frames).toBe("7");
    expect(Number(stream?.duration)).toBeCloseTo(7 / 12, 5);
    expect(stream?.width).toBe(160);
    expect(stream?.height).toBe(160);
    expect(stream?.r_frame_rate).toBe("12/1");
  });
});
