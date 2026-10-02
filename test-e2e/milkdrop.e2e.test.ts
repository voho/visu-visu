import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = resolve(import.meta.dir, "../src/cli.ts");
const fps = 60, duration = 30, sampleRate = 24_000;
const smallWidth = 360, smallHeight = 640;
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
    encoding: "buffer", timeout: 90_000, maxBuffer: 32 * 1024 * 1024,
  })).stdout;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-milkdrop-e2e-"));
  audioPath = join(directory, "song with drop.wav");
  imagePath = join(directory, "orange cover.png");
  const cover = createCanvas(512, 512), context = cover.getContext("2d");
  for (let y = 0; y < 512; y += 16) for (let x = 0; x < 512; x += 16) {
    context.fillStyle = ((x + y) / 16) % 2 ? "#ffffff" : "#ee4b17";
    context.fillRect(x, y, 16, 16);
  }
  context.font = "bold 74px sans-serif"; context.fillStyle = "white";
  context.fillText("COVER ART", 8, 230);
  await Bun.write(imagePath, cover.toBuffer("image/png"));
  await command("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='(0.65*sin(2*PI*60*t)+0.2*sin(2*PI*440*t)+0.1*sin(2*PI*2500*t))*if(lt(t,9),0.08,if(lt(t,28),0.8,0.15))':s=24000:d=42",
    "-metadata", "title=RESONANCE", "-metadata", "artist=VISU VISU", "-c:a", "pcm_s16le", audioPath,
  ]);
}, 30_000);

afterAll(async () => {
  if (!directory) return;
  if (process.env.VISU_KEEP_E2E === "1") console.log(`MilkDrop E2E artifacts: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
});

function args(output: string): string[] {
  return ["--engine", "milkdrop", "--output", output, "--image", imagePath,
    "--seed", "milkdrop-e2e", "--resolution", "fullhd", "--fps", String(fps), "--render-scale", "0.25"];
}

async function verifyContainer(path: string, width: number, height: number, seconds: number): Promise<void> {
  const probe = JSON.parse((await command("ffprobe", [
    "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path,
  ], 60_000)).stdout) as {
    streams: Array<Record<string, string | number>>;
    format: { duration: string; tags: Record<string, string> };
  };
  const video = probe.streams.find(stream => stream.codec_type === "video")!;
  const audio = probe.streams.find(stream => stream.codec_type === "audio")!;
  expect(video).toMatchObject({ codec_name: "h264", profile: "High", width, height,
    r_frame_rate: "60/1", avg_frame_rate: "60/1", nb_read_frames: String(seconds * fps),
    pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
  expect(audio).toMatchObject({ codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 });
  expect(Number(video.duration)).toBe(seconds);
  expect(Math.abs(Number(audio.duration) - seconds)).toBeLessThan(0.025);
  expect(Number(probe.format.duration)).toBeCloseTo(seconds, 2);
  expect(probe.format.tags).toMatchObject({ title: "RESONANCE", artist: "VISU VISU" });
  const mp4 = await readFile(path);
  expect(mp4.indexOf("moov")).toBeGreaterThan(0);
  expect(mp4.indexOf("moov")).toBeLessThan(mp4.indexOf("mdat"));
}

function rms(samples: Buffer, start: number, end: number): number {
  const first = Math.round(start * sampleRate), last = Math.min(Math.round(end * sampleRate), samples.length / 4);
  let sum = 0;
  for (let index = first; index < last; index++) sum += samples.readFloatLE(index * 4) ** 2;
  return Math.sqrt(sum / Math.max(1, last - first));
}

interface Region { left: number; right: number; top: number; bottom: number }

function thumbnailBounds(frame: Buffer, region: Region): Region & { pixels: number } {
  const columns = new Uint16Array(smallWidth), rows = new Uint16Array(smallHeight);
  let pixels = 0;
  for (let y = region.top; y < region.bottom; y++) for (let x = region.left; x < region.right; x++) {
    const index = (y * smallWidth + x) * 3;
    const r = frame[index]!, g = frame[index + 1]!, b = frame[index + 2]!;
    // The prepared cover room caps its RGB at 215; only the ungraded
    // thumbnail retains the source pigment above that range.
    if (r > 220 && r > g * 1.35 && b < 180) {
      pixels++; columns[x] = columns[x]! + 1; rows[y] = rows[y]! + 1;
    }
  }
  const dense = (counts: Uint16Array, start: number, end: number) => {
    let first = end, last = start;
    for (let index = start; index < end; index++) if (counts[index]! >= 6) {
      first = Math.min(first, index); last = Math.max(last, index);
    }
    return [first, last] as const;
  };
  const [left, right] = dense(columns, region.left, region.right);
  const [top, bottom] = dense(rows, region.top, region.bottom);
  return { pixels, left, right, top, bottom };
}

function textBands(frame: Buffer, region: Region): Region[] {
  const bands: Region[] = [];
  for (let y = region.top; y < region.bottom; y++) {
    let ink = 0;
    for (let x = region.left; x < region.right; x++) {
      const index = (y * smallWidth + x) * 3;
      ink += Number(Math.min(frame[index]!, frame[index + 1]!, frame[index + 2]!) > 170);
    }
    if (ink < 5) continue;
    const previous = bands.at(-1);
    if (previous && y - previous.bottom <= 2) previous.bottom = y + 1;
    else bands.push({ ...region, top: y, bottom: y + 1 });
  }
  return bands;
}

function textInk(frame: Buffer, region: Region) {
  const pixels: number[] = [], rows: number[] = [];
  let left = smallWidth, right = 0;
  for (let y = region.top; y < region.bottom; y++) {
    let count = 0;
    for (let x = region.left; x < region.right; x++) {
      const index = (y * smallWidth + x) * 3;
      if (Math.min(frame[index]!, frame[index + 1]!, frame[index + 2]!) > 170) {
        pixels.push(index); count++; left = Math.min(left, x); right = Math.max(right, x);
      }
    }
    if (count >= 5) rows.push(y);
  }
  const top = rows[0] ?? region.top, bottom = rows.at(-1) ?? top;
  return { pixels, left, right, top, bottom, height: rows.length ? bottom - top + 1 : 0, width: right - left + 1 };
}

const brightness = (frame: Buffer, pixels: number[]) => pixels.reduce((sum, index) =>
  sum + (frame[index]! + frame[index + 1]! + frame[index + 2]!) / 3, 0) / Math.max(1, pixels.length);

describe("MilkDrop engine end to end", () => {
  test("renders landscape through the real browser engine and encodes Full HD60", async () => {
    const output = join(directory, "landscape.mp4");
    // No browser mock and no skip: a missing Chrome installation must fail
    // with the backend's actionable VISU_CHROME_PATH guidance.
    const result = await command(process.execPath, [cli, "render", audioPath, ...args(output),
      "--ratio", "16:9", "--start", "7", "--duration", "3", "--fade", "0.25",
      "--title", "RESONANCE", "--artist", "VISU VISU"], 300_000);
    expect(result.stdout + result.stderr).toMatch(/milkdrop/i);
    await verifyContainer(output, 1920, 1080, 3);
    const frames = await bytes(["-ss", "1", "-i", output, "-t", "1", "-map", "0:v:0",
      "-vf", "crop=1536:432:192:360,scale=96:54,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
    const plane = 96 * 54;
    expect(frames.length).toBe(fps * plane);
    let lit = 0, motion = 0;
    for (let index = 0; index < frames.length; index++) lit += Number(frames[index]! > 12);
    for (let frame = 1; frame < fps; frame++) for (let pixel = 0; pixel < plane; pixel++) {
      motion += Math.abs(frames[frame * plane + pixel]! - frames[(frame - 1) * plane + pixel]!);
    }
    expect(lit / frames.length).toBeGreaterThan(0.05);
    expect(motion / ((fps - 1) * plane)).toBeGreaterThan(0.1);
  }, 330_000);

  test("exports the selected 30-second portrait drop with live motion, cover palette and readable fading credits", async () => {
    const output = join(directory, "portrait clip.mp4");
    const cliArgs = [cli, "clip", audioPath, ...args(output)];
    const plan = JSON.parse((await command(process.execPath, [...cliArgs, "--dry-run"])).stdout) as {
      start: number; end: number; drop: number; dropOffset: number; duration: number; renderedDuration: number;
      width: number; height: number; fps: number; reason: string; title: string; artist: string;
      fadeInSeconds: number; fadeOutSeconds: number; engine: string;
    };
    expect(plan).toMatchObject({ width: 1080, height: 1920, fps, duration, renderedDuration: duration,
      reason: "drop", title: "RESONANCE", artist: "VISU VISU", fadeInSeconds: 0.35, fadeOutSeconds: 3, engine: "milkdrop" });
    expect(plan.start).toBeCloseTo(6, 1);
    expect(plan.drop).toBeCloseTo(9, 1);
    expect(plan.dropOffset).toBeCloseTo(3, 8);
    expect(plan.end - plan.start).toBe(duration);
    const result = await command(process.execPath, cliArgs, 720_000);
    expect(result.stdout + result.stderr).toMatch(/milkdrop/i);
    expect(result.stdout + result.stderr).toContain("1800 frames");
    const schedule = (result.stdout + result.stderr).split("\n").find(line => line.startsWith("MilkDrop ")) ?? "";
    const transitions = Array.from(schedule.matchAll(/(\d+\.\d+)s ([\w-]+)/g));
    expect(transitions.length).toBeGreaterThan(1);
    expect(new Set(transitions.map(item => item[2])).size).toBeGreaterThan(1);
    expect(transitions.some(item => Number(item[1]) > 0 && Number(item[1]) < duration)).toBe(true);
    await verifyContainer(output, 1080, 1920, duration);

    const motion = await bytes(["-ss", "7", "-i", output, "-t", "8", "-map", "0:v:0",
      "-vf", "crop=690:576:130:576,scale=96:80:flags=area,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", "-"]);
    const plane = 96 * 80, ratios: number[] = [];
    expect(motion.length).toBe(8 * fps * plane);
    let activePixels = 0;
    for (let index = 0; index < motion.length; index++) activePixels += Number(motion[index]! > 12);
    expect(activePixels / motion.length).toBeGreaterThan(0.05);
    for (let frame = 2; frame < 8 * fps; frame++) {
      let adjacent = 0, twoFrames = 0;
      for (let pixel = 0; pixel < plane; pixel++) {
        const current = motion[frame * plane + pixel]!;
        adjacent += Math.abs(current - motion[(frame - 1) * plane + pixel]!);
        twoFrames += Math.abs(current - motion[(frame - 2) * plane + pixel]!);
      }
      if (twoFrames / plane > 0.1) ratios.push(adjacent / twoFrames);
    }
    expect(ratios.length).toBeGreaterThan(240);
    ratios.sort((a, b) => a - b);
    expect(ratios[Math.floor((ratios.length - 1) * 0.25)]).toBeGreaterThan(0.25);

    const audio = await bytes(["-i", output, "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-"]);
    expect(audio.length / 4 / sampleRate).toBeGreaterThanOrEqual(duration - 0.002);
    const quiet = rms(audio, 2, 2.1), loud = rms(audio, 6, 6.1);
    expect(quiet).toBeGreaterThan(0.01);
    expect(loud / quiet).toBeGreaterThan(8);
    let drop = -1;
    for (let time = 1.5; time < 6; time += 0.025) {
      if (rms(audio, time, time + 0.025) > (quiet + loud) / 2) { drop = time; break; }
    }
    expect(Math.abs(drop - plan.dropOffset)).toBeLessThan(0.1);

    const indices = [0, 9, 30, 120, 600, 1710, 1770, 1799];
    const pictures = await bytes(["-i", output, "-map", "0:v:0", "-vf",
      `select='${indices.map(index => `eq(n,${index})`).join("+")}',scale=${smallWidth}:${smallHeight}`,
      "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    const frameBytes = smallWidth * smallHeight * 3;
    expect(pictures.length).toBe(indices.length * frameBytes);
    const at = (index: number) => pictures.subarray(index * frameBytes, (index + 1) * frameBytes);
    const creditRegion = { left: 30, right: 330, top: 100, bottom: 190 };
    const thumbnail = thumbnailBounds(at(3), creditRegion);
    expect(thumbnail.pixels).toBeGreaterThan(180);
    expect(thumbnail.right - thumbnail.left + 1).toBeGreaterThan(32);
    expect(thumbnail.bottom - thumbnail.top + 1).toBeGreaterThan(32);
    const bands = textBands(at(3), { ...creditRegion, left: thumbnail.right + 4 });
    expect(bands).toHaveLength(2);
    const title = textInk(at(3), bands[0]!), artist = textInk(at(3), bands[1]!);
    expect(title.pixels.length).toBeGreaterThan(250);
    expect(title.height).toBeGreaterThanOrEqual(20);
    expect(title.width).toBeGreaterThan(100);
    expect(artist.pixels.length).toBeGreaterThan(150);
    expect(artist.height).toBeGreaterThanOrEqual(12);
    expect(artist.width).toBeGreaterThan(70);
    expect(Math.abs(title.left - artist.left)).toBeLessThan(3);
    expect(Math.min(title.left, artist.left) - thumbnail.right).toBeGreaterThan(4);
    expect(Math.abs((thumbnail.left + Math.max(title.right, artist.right)) / 2 - smallWidth / 2)).toBeLessThan(3);
    expect(Math.abs((title.top + artist.bottom - thumbnail.top - thumbnail.bottom) / 2)).toBeLessThan(3);
    expect(thumbnail.bottom - thumbnail.top + 1).toBeGreaterThanOrEqual(artist.bottom - title.top - 1);

    // Exclude credits and the thumbnail: the actual engine's chromatic pixels
    // must follow the orange cover, rather than merely displaying it nearby.
    let chromatic = 0, coverFamily = 0;
    const picture = at(4);
    for (let y = 210; y < 490; y++) for (let x = 30; x < 330; x++) {
      const index = (y * smallWidth + x) * 3;
      const r = picture[index]!, g = picture[index + 1]!, b = picture[index + 2]!;
      const high = Math.max(r, g, b), low = Math.min(r, g, b);
      if (high < 30 || high - low < 18) continue;
      chromatic++;
      coverFamily += Number(r > g && g >= b - 8);
    }
    expect(chromatic).toBeGreaterThan(300);
    expect(coverFamily / chromatic).toBeGreaterThan(0.9);

    const fullLight = brightness(at(3), artist.pixels), tail = rms(audio, 26, 26.1);
    for (const [position, time, expectedGain, referenceAudio] of [
      [1, 0.15, 0.15 / 0.35, quiet], [5, 28.5, 0.5, tail], [6, 29.5, 1 / 6, tail],
    ] as const) {
      const pictureGain = brightness(at(position), artist.pixels) / fullLight;
      const audioGain = rms(audio, time - 0.015, time + 0.015) / referenceAudio;
      expect(Math.abs(pictureGain - expectedGain)).toBeLessThan(0.075);
      expect(Math.abs(audioGain - expectedGain)).toBeLessThan(0.06);
      expect(Math.abs(pictureGain - audioGain)).toBeLessThan(0.075);
    }
    expect(brightness(at(0), artist.pixels)).toBeLessThan(2);
    expect(brightness(at(7), artist.pixels) / fullLight).toBeLessThan(0.025);
    expect(rms(audio, duration - 0.02, duration) / tail).toBeLessThan(0.015);
  }, 780_000);
});
