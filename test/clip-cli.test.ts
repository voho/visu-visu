import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyzeAudio } from "../src/audio/analyze.js";
import { decodeAudio } from "../src/audio/decode.js";
import { saveAnalysis } from "../src/audio/cache.js";

const directory = join(tmpdir(), `visu-visu-clip-cli-${process.pid}`);
const audioPath = join(directory, "drop.wav");
const outputPath = join(directory, "clip.mp4");
const analysisPath = join(directory, "drop.analysis.json");
const cli = resolve(import.meta.dir, "../src/cli.ts");

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, "clip", audioPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  // A real 42-second PCM track: quiet introduction, a sustained bass drop at
  // nine seconds, then a release. Tests exercise decoding and analysis together.
  const fixture = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='(0.65*sin(2*PI*60*t)+0.2*sin(2*PI*440*t)+0.1*sin(2*PI*2500*t))*if(lt(t,9),0.08,if(lt(t,28),0.8,0.15))':s=24000:d=42",
    "-metadata", "title=Night Signal", "-metadata", "artist=Test Artist",
    "-c:a", "pcm_s16le", audioPath,
  ], { encoding: "utf8" });
  if (fixture.status !== 0) throw new Error(fixture.stderr);
  await saveAnalysis(analysisPath, analyzeAudio(await decodeAudio(audioPath), 60, 64));
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("clip CLI", () => {
  test("selects a real sustained drop and reports a Full HD60 portrait plan without encoding", async () => {
    const result = run("--analysis", analysisPath, "--output", outputPath, "--dry-run");
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({
      width: 1080, height: 1920, fps: 60, duration: 30, renderedDuration: 30,
      reason: "drop", title: "Night Signal", artist: "Test Artist",
      fadeInSeconds: 0.35, fadeOutSeconds: 3,
    });
    expect(plan.drop).toBeGreaterThan(8.5);
    expect(plan.drop).toBeLessThan(9.5);
    expect(plan.dropOffset).toBeCloseTo(5, 2);
    expect(plan.end - plan.start).toBe(30);
    expect(await access(outputPath).then(() => true, () => false)).toBe(false);
  });

  test("manual drop preserves lead-in and reaches full volume before a late fadeout", () => {
    const result = run("--analysis", analysisPath, "--drop", "41", "--duration", "3",
      "--lead-in", "1", "--title", "Override", "--artist", "Vojta", "--dry-run");
    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({ reason: "manual", start: 40, duration: 2, end: 42,
      drop: 41, dropOffset: 1, title: "Override", artist: "Vojta" });
    expect(plan.renderedDuration - plan.fadeOutSeconds).toBeGreaterThan(plan.dropOffset);
    expect(plan.fadeInSeconds).toBeLessThan(plan.dropOffset);
    expect(plan.fadeInSeconds).toBeLessThan(plan.fadeOutSeconds);
    const immediate = run("--analysis", analysisPath, "--drop", "0", "--dry-run");
    expect(immediate.status).toBe(0);
    expect(JSON.parse(immediate.stdout)).toMatchObject({ dropOffset: 0, fadeInSeconds: 0 });
  });

  test("clips keep portrait delivery even with a landscape project config", async () => {
    const configPath = join(directory, "landscape.json");
    await writeFile(configPath, JSON.stringify({ output: { width: 1920, height: 1080, fps: 24 },
      text: { artist: "Config Artist" } }));
    const result = run("--analysis", analysisPath, "--config", configPath, "--dry-run");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ width: 1080, height: 1920, fps: 60, artist: "Config Artist" });
  });

  test("rejects unsuitable options, wrong caches and missing artist credit clearly", async () => {
    for (const args of [["--duration", "31"], ["--lead-in", "30"], ["--drop", "NaN"],
      ["--fade-out", "-1"], ["--size", "1920x1080"], ["--start", "10"]]) {
      const result = run(...args, "--dry-run");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error:");
    }
    const wrong = analyzeAudio(await decodeAudio(audioPath), 60, 64);
    wrong.sourceFileHash = "0".repeat(64);
    const wrongPath = join(directory, "wrong.json");
    await saveAnalysis(wrongPath, wrong);
    const mismatch = run("--analysis", wrongPath, "--dry-run");
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("different audio file");
    const untagged = spawnSync(process.execPath, [cli, "clip",
      resolve(import.meta.dir, "../test-e2e/loop.wav"), "--dry-run"], { encoding: "utf8" });
    expect(untagged.status).toBe(1);
    expect(untagged.stderr).toContain('--artist "Artist Name"');
  });
});
