import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { MILKDROP_PRESETS } from "../src/milkdrop/presets.js";

const execute = promisify(execFile);
const cli = resolve(import.meta.dir, "../src/cli.ts");
const width = 640, height = 360, fps = 60, duration = 3, sampleRate = 24_000;
export const PROMO_E2E_TIMEOUT = 330_000;
let directory: string, audioPath: string, imagePath: string;

async function command(executable: string, args: string[], timeout = 30_000) {
  try {
    return await execute(executable, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const failure = error as Error & { stderr?: string; stdout?: string };
    throw new Error(`${failure.message}\n${failure.stderr ?? ""}\n${failure.stdout ?? ""}`, { cause: error });
  }
}

async function bytes(args: string[]): Promise<Buffer> {
  return (await execute("ffmpeg", ["-v", "error", ...args], {
    encoding: "buffer", timeout: 90_000, maxBuffer: 64 * 1024 * 1024,
  })).stdout;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-promo-e2e-"));
  audioPath = join(directory, "untagged song.wav");
  imagePath = join(directory, "orange and cream cover.png");
  const canvas = createCanvas(480, 480), context = canvas.getContext("2d");
  for (let y = 0; y < 480; y += 60) for (let x = 0; x < 480; x += 60) {
    context.fillStyle = ((x + y) / 60) % 2 ? "#fff0d6" : "#ee4b17";
    context.fillRect(x, y, 60, 60);
  }
  // A dark asymmetric mark distinguishes the actual cover from a flat swatch.
  context.fillStyle = "#572b16";
  context.fillRect(60, 60, 60, 180);
  context.fillRect(60, 180, 180, 60);
  await Bun.write(imagePath, canvas.toBuffer("image/png"));
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='(0.55*sin(2*PI*60*t)+0.22*sin(2*PI*440*t)+0.12*sin(2*PI*2500*t)+0.07*sin(2*PI*7300*t))*if(lt(t,8.5),0.1,0.8)':s=24000:d=12",
    "-map_metadata", "-1", "-c:a", "pcm_s16le", audioPath]);
}, 30_000);

afterAll(async () => {
  if (!directory) return;
  if (process.env.VISU_KEEP_E2E === "1") console.log(`Promo E2E artifacts: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
});

interface Region { left: number; right: number; top: number; bottom: number }

function inkBands(frame: Buffer, region: Region): Region[] {
  const bands: Region[] = [];
  for (let y = region.top; y < region.bottom; y++) {
    let count = 0, left = width, right = 0;
    for (let x = region.left; x < region.right; x++) {
      const index = (y * width + x) * 3;
      if (Math.min(frame[index]!, frame[index + 1]!, frame[index + 2]!) > 155) {
        count++; left = Math.min(left, x); right = Math.max(right, x);
      }
    }
    if (count < 5) continue;
    const previous = bands.at(-1);
    if (previous && y - previous.bottom <= 2) {
      previous.bottom = y + 1;
      previous.left = Math.min(previous.left, left);
      previous.right = Math.max(previous.right, right);
    } else bands.push({ left, right, top: y, bottom: y + 1 });
  }
  return bands;
}

function mean(frame: Buffer, region: Region): number {
  let sum = 0, pixels = 0;
  for (let y = region.top; y < region.bottom; y++) for (let x = region.left; x < region.right; x++) {
    const index = (y * width + x) * 3;
    sum += (frame[index]! + frame[index + 1]! + frame[index + 2]!) / 3;
    pixels++;
  }
  return sum / pixels;
}

function rms(samples: Buffer, start: number, end: number): number {
  const first = Math.round(start * sampleRate), last = Math.min(Math.round(end * sampleRate), samples.length / 4);
  let sum = 0;
  for (let index = first; index < last; index++) sum += samples.readFloatLE(index * 4) ** 2;
  return Math.sqrt(sum / Math.max(1, last - first));
}

describe("promo mode end to end", () => {
  test("requires cover, song name and author before creating a video", async () => {
    const fields = ["--image", "--title", "--artist"] as const;
    const values = [imagePath, "NIGHT SIGNAL", "VOHO"];
    for (let omitted = 0; omitted < fields.length; omitted++) {
      const output = join(directory, `missing-${omitted}.mp4`);
      const metadata = fields.flatMap((field, index) => index === omitted ? [] : [field, values[index]!]);
      const child = await execute(process.execPath, [cli, "render", audioPath, "--mode", "promo",
        "--output", output, "--size", "640x360", "--duration", "0.1", ...metadata], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      }).then(result => ({ ...result, failed: false }), error => ({
        failed: true, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""),
      }));
      expect(child.failed).toBe(true);
      expect(child.stdout + child.stderr).toMatch(/promo/i);
      expect(child.stdout + child.stderr).toMatch([/cover|image/i, /title|song/i, /artist|author/i][omitted]!);
      expect(await access(output).then(() => true, () => false)).toBe(false);
    }
  }, 100_000);

  test("renders the Golden gallery with equally prominent credits, live MilkDrop and a reserved spectrum band", async () => {
    const output = join(directory, "promo.mp4");
    // This deliberately omits --engine and --milkdrop-presets: promo must select
    // the real immersive engine itself. No user media or browser mocks are used.
    const result = await command(process.execPath, [cli, "render", audioPath,
      "--mode", "promo", "--image", imagePath, "--title", "NIGHT SIGNAL", "--artist", "VOHO",
      "--output", output, "--size", `${width}x${height}`, "--fps", String(fps), "--start", "7",
      "--duration", String(duration), "--fade", "0", "--seed", "promo-e2e"], 300_000);
    const log = result.stdout + result.stderr;
    expect(log).toMatch(/milkdrop/i);
    const schedules = log.split(/\r?\n/).filter(line => line.startsWith("MilkDrop "));
    expect(schedules).toHaveLength(1);
    const entries = Array.from(schedules[0]!.matchAll(/(\d+\.\d+)s ([\w-]+)/g));
    expect(entries).toHaveLength(1);
    const presetId = entries[0]![2]!;
    expect(["tunnel-race", "mandelbox-explorer"]).toContain(presetId);
    expect(schedules[0]).toBe(`MilkDrop 0.0s ${presetId}`);
    const preset = MILKDROP_PRESETS.find(candidate => candidate.id === presetId);
    expect(preset).toBeDefined();
    expect(log.split(/\r?\n/).filter(line => /^Presets?\s/.test(line))).toEqual([`Preset   ${preset!.name}`]);
    const probe = JSON.parse((await command("ffprobe", ["-v", "error", "-count_frames",
      "-show_streams", "-show_format", "-of", "json", output])).stdout) as {
      streams: Array<Record<string, string | number>>;
      format: { duration: string; tags: Record<string, string> };
    };
    const video = probe.streams.find(stream => stream.codec_type === "video")!;
    const audio = probe.streams.find(stream => stream.codec_type === "audio")!;
    expect(video).toMatchObject({ codec_name: "h264", profile: "High", width, height,
      r_frame_rate: "60/1", avg_frame_rate: "60/1", nb_read_frames: String(fps * duration),
      pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
    expect(audio).toMatchObject({ codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 });
    expect(Number(video.duration)).toBe(duration);
    expect(Math.abs(Number(audio.duration) - duration)).toBeLessThan(0.025);
    expect(Number(probe.format.duration)).toBeCloseTo(duration, 2);
    expect(probe.format.tags).toMatchObject({ title: "NIGHT SIGNAL", artist: "VOHO" });
    const mp4 = await readFile(output);
    expect(mp4.indexOf("moov")).toBeGreaterThan(0);
    expect(mp4.indexOf("moov")).toBeLessThan(mp4.indexOf("mdat"));

    const samples = await bytes(["-i", output, "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-"]);
    const quiet = rms(samples, 0.5, 0.7), loud = rms(samples, 2, 2.2);
    expect(quiet).toBeGreaterThan(0.02);
    expect(loud / quiet).toBeGreaterThan(7.5);
    let drop = -1;
    for (let time = 1; time < 2; time += 0.025) {
      if (rms(samples, time, time + 0.025) > (quiet + loud) / 2) { drop = time; break; }
    }
    expect(Math.abs(drop - 1.5)).toBeLessThan(0.06);

    const frame = await bytes(["-ss", "2", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    expect(frame.length).toBe(width * height * 3);
    await command("ffmpeg", ["-v", "error", "-y", "-ss", "2", "-i", output, "-frames:v", "1", join(directory, "promo.png")]);
    // The orange source checks stay bright only inside the ungraded cover.
    // Measure its real pixels rather than relying on the renderer's layout API.
    const columns = new Uint16Array(width), rows = new Uint16Array(height);
    for (let y = 60; y < 285; y++) for (let x = 20; x < 240; x++) {
      const index = (y * width + x) * 3;
      if (frame[index]! > 220 && frame[index]! > frame[index + 1]! * 1.5 && frame[index + 2]! < 100) {
        columns[x] = columns[x]! + 1; rows[y] = rows[y]! + 1;
      }
    }
    const dense = (counts: Uint16Array) => [...counts.keys()].filter(index => counts[index]! >= 12);
    const coverX = dense(columns), coverY = dense(rows);
    expect(coverX.length).toBeGreaterThan(110);
    expect(coverY.length).toBeGreaterThan(110);
    expect(coverX[0]).toBeGreaterThanOrEqual(30);
    expect(coverX.at(-1)!).toBeLessThan(width * 0.4);
    expect(Math.abs((coverY[0]! + coverY.at(-1)!) / 2 - height / 2)).toBeLessThan(4);
    expect(mean(frame, { left: coverX[0]! + 10, right: coverX.at(-1)! - 10,
      top: coverY[0]! + 10, bottom: coverY.at(-1)! - 10 })).toBeGreaterThan(100);

    // Gallery keeps the two credit lines above the separate right-hand scope.
    // Identify their actual encoded ink, independent of the layout helper.
    const bands = inkBands(frame, { left: coverX.at(-1)! + 12, right: width - 25, top: 75, bottom: 172 });
    expect(bands).toHaveLength(2);
    const title = bands[0]!, artist = bands[1]!;
    const titleHeight = title.bottom - title.top, artistHeight = artist.bottom - artist.top;
    expect(titleHeight).toBeGreaterThanOrEqual(20);
    expect(title.right - title.left).toBeGreaterThan(120);
    expect(artistHeight).toBeGreaterThanOrEqual(20);
    // Serif and sans-serif cap heights differ despite using the same em size.
    expect(artistHeight / titleHeight).toBeGreaterThan(0.8);
    expect(artistHeight / titleHeight).toBeLessThan(1.5);
    expect(artist.right - artist.left).toBeGreaterThan(90);
    expect(Math.abs(title.left - artist.left)).toBeLessThan(4);
    expect(title.top).toBeGreaterThan(height * 0.24);
    expect(artist.bottom).toBeLessThan(height * 0.46);
    expect(artist.top - title.bottom).toBeGreaterThan(7);

    // Away from cover, text, oscilloscope and bars, actual background pixels
    // must animate while keeping their luminance below the foreground cover.
    const background = await bytes(["-ss", "0.5", "-i", output, "-t", "2", "-map", "0:v:0",
      "-vf", "crop=600:70:20:20,scale=160:20:flags=area", "-fps_mode", "passthrough",
      "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    const plane = 160 * 20 * 3;
    expect(background.length).toBe(2 * fps * plane);
    let chromatic = 0, warm = 0, brightness = 0, motion = 0;
    for (let index = 0; index < background.length; index += 3) {
      const r = background[index]!, g = background[index + 1]!, b = background[index + 2]!;
      brightness += (r + g + b) / 3;
      if (Math.max(r, g, b) > 12 && Math.max(r, g, b) - Math.min(r, g, b) > 6) {
        chromatic++; warm += Number(r >= g - 3 && g >= b - 5);
      }
    }
    for (let index = plane; index < background.length; index++) motion += Math.abs(background[index]! - background[index - plane]!);
    expect(chromatic).toBeGreaterThan(1_000);
    expect(warm / chromatic).toBeGreaterThan(0.9);
    expect(brightness / (background.length / 3)).toBeLessThan(60);
    expect(motion / (background.length - plane)).toBeGreaterThan(0.015);

    // The live bars occupy their new band above the player-control reserve.
    // Exact clipping is checked against a flat background in the unit tests;
    // MilkDrop may legitimately illuminate pixels in the reserved margin.
    let baselineInk = 0, barInk = 0;
    for (let y = 275; y < 339; y++) for (let x = 52; x < 588; x++) {
      const index = (y * width + x) * 3;
      if (Math.max(frame[index]!, frame[index + 1]!, frame[index + 2]!) > 70) {
        barInk++; if (y >= 332) baselineInk++;
      }
    }
    expect(baselineInk).toBeGreaterThan(100);
    expect(barInk).toBeGreaterThan(800);
  }, PROMO_E2E_TIMEOUT);
});
