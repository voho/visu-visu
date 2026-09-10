import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCanvas } from "@napi-rs/canvas";

const execute = promisify(execFile);
const cli = resolve(import.meta.dir, "../src/cli.ts");
const fps = 60;
const duration = 30;
const sampleRate = 24_000;
const smallWidth = 360;
const smallHeight = 640;
let directory: string;
let audioPath: string;
let outputPath: string;
let imagePath: string;

async function textCommand(command: string, args: string[], timeout = 30_000): Promise<string> {
  return (await execute(command, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

async function bytesCommand(command: string, args: string[]): Promise<Buffer> {
  return (await execute(command, args, { encoding: "buffer", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-visu-clip-e2e-"));
  audioPath = join(directory, "song with drop.wav");
  outputPath = join(directory, "portrait clip.mp4");
  imagePath = join(directory, "busy cover.png");
  const cover = createCanvas(512, 512);
  const context = cover.getContext("2d");
  for (let y = 0; y < 512; y += 16) {
    for (let x = 0; x < 512; x += 16) {
      context.fillStyle = ((x + y) / 16) % 2 ? "#ffffff" : "#ee4b17";
      context.fillRect(x, y, 16, 16);
    }
  }
  context.font = "bold 74px sans-serif";
  context.fillStyle = "#ffffff";
  context.fillText("COVER ART", 8, 230);
  await Bun.write(imagePath, cover.toBuffer("image/png"));
  // A known musical structure gives the CLI a real choice: quiet lead-in, a
  // sustained bass-heavy drop at 9s, and release at 28s. No cached analysis or
  // injected render frames: decoding, selection, rendering and muxing all run.
  await textCommand("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='(0.65*sin(2*PI*60*t)+0.2*sin(2*PI*440*t)+0.1*sin(2*PI*2500*t))*if(lt(t,9),0.08,if(lt(t,28),0.8,0.15))':s=24000:d=42",
    "-metadata", "title=RESONANCE", "-metadata", "artist=VISU VISU",
    "-c:a", "pcm_s16le", audioPath,
  ]);
}, 30_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function rms(samples: Buffer, start: number, end: number): number {
  const first = Math.round(start * sampleRate);
  const last = Math.min(Math.round(end * sampleRate), samples.length / 4);
  let sum = 0;
  for (let index = first; index < last; index += 1) sum += samples.readFloatLE(index * 4) ** 2;
  return Math.sqrt(sum / Math.max(1, last - first));
}

interface TextRegion {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function textInk(frame: Buffer, region: TextRegion): { pixels: number[]; height: number; width: number; left: number; right: number; top: number; bottom: number; centerX: number; centerY: number } {
  const pixels: number[] = [];
  const rows: number[] = [];
  let left = smallWidth;
  let right = 0;
  for (let y = region.top; y < region.bottom; y += 1) {
    let rowPixels = 0;
    for (let x = region.left; x < region.right; x += 1) {
      const index = (y * smallWidth + x) * 3;
      if (Math.min(frame[index]!, frame[index + 1]!, frame[index + 2]!) > 170) {
        pixels.push(index);
        rowPixels += 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    // Ignore isolated stars when measuring the height of the letter forms.
    if (rowPixels >= 5) rows.push(y);
  }
  const top = rows[0] ?? region.top;
  const bottom = rows.at(-1) ?? top;
  return { pixels, height: rows.length ? bottom - top + 1 : 0, width: right - left + 1,
    left, right, top, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

function coverInk(frame: Buffer, region: TextRegion): { pixels: number; left: number; right: number; top: number; bottom: number } {
  const columns = new Uint16Array(smallWidth);
  const rows = new Uint16Array(smallHeight);
  let pixels = 0;
  for (let y = region.top; y < region.bottom; y++) for (let x = region.left; x < region.right; x++) {
    const index = (y * smallWidth + x) * 3;
    const r = frame[index]!, g = frame[index + 1]!, b = frame[index + 2]!;
    // The fixture's orange checks distinguish the ungraded thumbnail from white
    // credit ink and from the cover room behind the credits: the room caps
    // every channel at 215 and sits under the credit shade, so only the sharp
    // thumbnail keeps the source's full orange.
    if (r > 220 && r > g * 1.35 && b < 180) {
      pixels++;
      columns[x] = columns[x]! + 1;
      rows[y] = rows[y]! + 1;
    }
  }
  // A few stray orange pixels (a tracer, a hit lift) must not stretch the box:
  // the thumbnail is the block whose rows and columns are densely orange.
  const dense = (counts: Uint16Array, start: number, end: number): [number, number] => {
    let first = end, last = start;
    for (let index = start; index < end; index++) if (counts[index]! >= 6) { first = Math.min(first, index); last = Math.max(last, index); }
    return [first, last];
  };
  const [left, right] = dense(columns, region.left, region.right);
  const [top, bottom] = dense(rows, region.top, region.bottom);
  return { pixels, left, right, top, bottom };
}

function textBands(frame: Buffer, region: TextRegion): TextRegion[] {
  const bands: TextRegion[] = [];
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

function inkBrightness(frame: Buffer, pixels: number[]): number {
  return pixels.reduce((sum, index) => sum + (frame[index]! + frame[index + 1]! + frame[index + 2]!) / 3, 0)
    / Math.max(1, pixels.length);
}

describe("portrait clip end to end", () => {
  test("runs the clip CLI through a complete 30-second music-reactive MP4 export", async () => {
    const args = [cli, "clip", audioPath, "--output", outputPath, "--seed", "clip-e2e", "--image", imagePath, "--lighting", "0.8"];
    const plan = JSON.parse(await textCommand(process.execPath, [...args, "--dry-run"])) as {
      start: number; end: number; drop: number; dropOffset: number;
      duration: number; renderedDuration: number; width: number; height: number; fps: number;
      fadeInSeconds: number; fadeOutSeconds: number; reason: string; title: string; artist: string;
    };
    expect(plan).toMatchObject({ width: 1080, height: 1920, fps, duration, renderedDuration: duration,
      reason: "drop", title: "RESONANCE", artist: "VISU VISU", fadeInSeconds: 0.35, fadeOutSeconds: 3 });
    expect(plan.start).toBeCloseTo(6, 1);
    expect(plan.drop).toBeCloseTo(9, 1);
    expect(plan.dropOffset).toBeCloseTo(3, 8);
    expect(plan.end - plan.start).toBe(duration);
    expect(await access(outputPath).then(() => true, () => false)).toBe(false);

    // Only the internal drawing scale is reduced to bound E2E runtime. Delivery
    // keeps the command's default Full HD60 profile and all 1,800 scene frames.
    const log = await textCommand(process.execPath, [...args, "--render-scale", "0.25"], 360_000);
    expect(log).toContain("270x480 internal");
    expect(log).toContain("30.00s, 1800 frames");

    const probe = JSON.parse(await textCommand("ffprobe", [
      "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", outputPath,
    ])) as { streams: Array<Record<string, string | number>>; format: { duration: string; tags: Record<string, string> } };
    const video = probe.streams.find((stream) => stream.codec_type === "video")!;
    const audio = probe.streams.find((stream) => stream.codec_type === "audio")!;
    expect(video).toMatchObject({ codec_name: "h264", profile: "High", width: 1080, height: 1920,
      r_frame_rate: "60/1", avg_frame_rate: "60/1", nb_read_frames: "1800", pix_fmt: "yuv420p",
      color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
    expect(audio).toMatchObject({ codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2 });
    expect(Number(video.duration)).toBe(duration);
    expect(Math.abs(Number(audio.duration) - duration)).toBeLessThan(0.002);
    expect(Number(probe.format.duration)).toBe(duration);
    expect(probe.format.tags).toMatchObject({ title: "RESONANCE", artist: "VISU VISU" });
    const mp4 = await readFile(outputPath);
    expect(mp4.indexOf("moov")).toBeGreaterThan(0);
    expect(mp4.indexOf("moov")).toBeLessThan(mp4.indexOf("mdat"));

    // Lossy encoding can give repeated source pictures different hashes. Measure
    // actual motion in an active passage: duplicated 30fps frames alternate tiny
    // and large steps, while continuous 60fps motion has similar adjacent steps.
    const motion = await bytesCommand("ffmpeg", [
      "-v", "error", "-ss", "7", "-i", outputPath, "-t", "8", "-map", "0:v:0",
      "-vf", "crop=690:576:130:576,scale=96:80:flags=area,format=gray",
      "-fps_mode", "passthrough", "-f", "rawvideo", "-",
    ]);
    const planeBytes = 96 * 80;
    expect(motion.length).toBe(8 * fps * planeBytes);
    const motionRatios: number[] = [];
    for (let frame = 2; frame < 8 * fps; frame += 1) {
      let adjacent = 0;
      let twoFrames = 0;
      for (let pixel = 0; pixel < planeBytes; pixel += 1) {
        const current = motion[frame * planeBytes + pixel]!;
        adjacent += Math.abs(current - motion[(frame - 1) * planeBytes + pixel]!);
        twoFrames += Math.abs(current - motion[(frame - 2) * planeBytes + pixel]!);
      }
      if (twoFrames / planeBytes > 0.1) motionRatios.push(adjacent / twoFrames);
    }
    expect(motionRatios.length).toBeGreaterThan(300);
    motionRatios.sort((left, right) => left - right);
    expect(motionRatios[Math.floor((motionRatios.length - 1) * 0.25)]).toBeGreaterThan(0.25);

    const samples = await bytesCommand("ffmpeg", [
      "-v", "error", "-i", outputPath, "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate),
      "-f", "f32le", "-",
    ]);
    expect(samples.length / 4 / sampleRate).toBeGreaterThanOrEqual(duration - 0.002);
    const quiet = rms(samples, 2, 2.1);
    const loud = rms(samples, 6, 6.1);
    expect(quiet).toBeGreaterThan(0.01);
    expect(loud / quiet).toBeGreaterThan(8);
    let audibleDrop = -1;
    // The drop lands three seconds in; search from well before it.
    for (let time = 1.5; time < 6; time += 0.025) {
      if (rms(samples, time, time + 0.025) > (quiet + loud) / 2) { audibleDrop = time; break; }
    }
    expect(Math.abs(audibleDrop - plan.dropOffset)).toBeLessThan(0.1);

    const indices = [0, 9, 30, 120, 1620, 1710, 1770, 1799];
    const frames = await bytesCommand("ffmpeg", [
      "-v", "error", "-i", outputPath, "-map", "0:v:0", "-vf",
      `select='${indices.map((index) => `eq(n,${index})`).join("+")}',scale=${smallWidth}:${smallHeight}`,
      "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ]);
    const frameBytes = smallWidth * smallHeight * 3;
    expect(frames.length).toBe(indices.length * frameBytes);
    const frameAt = (position: number): Buffer => frames.subarray(position * frameBytes, (position + 1) * frameBytes);
    const creditRegion = { left: 43, right: 317, top: 108, bottom: 182 };
    const thumbnail = coverInk(frameAt(3), creditRegion);
    expect(thumbnail.pixels).toBeGreaterThan(180);
    expect(thumbnail.right - thumbnail.left + 1).toBeGreaterThan(32);
    expect(thumbnail.bottom - thumbnail.top + 1).toBeGreaterThan(32);
    // Exclude every checkerboard pixel before measuring the two text lines.
    const bands = textBands(frameAt(3), { ...creditRegion, left: thumbnail.right + 4 });
    expect(bands).toHaveLength(2);
    const title = textInk(frameAt(3), bands[0]!);
    const artist = textInk(frameAt(3), bands[1]!);
    // Check rendered ink, not just metadata: both credits must be visible and
    // large enough at phone-preview size. No golden image or fixed font face.
    expect(title.pixels.length).toBeGreaterThan(250);
    expect(title.height).toBeGreaterThanOrEqual(20);
    expect(title.width).toBeGreaterThan(100);
    expect(artist.pixels.length).toBeGreaterThan(150);
    expect(artist.height).toBeGreaterThanOrEqual(12);
    expect(artist.width).toBeGreaterThan(70);
    expect(Math.abs(title.left - artist.left)).toBeLessThan(3);
    expect(Math.min(title.left, artist.left) - thumbnail.right).toBeGreaterThan(4);
    const groupRight = Math.max(title.right, artist.right);
    expect(Math.abs((thumbnail.left + groupRight) / 2 - smallWidth / 2)).toBeLessThan(3);
    const textCenterY = (title.top + artist.bottom) / 2;
    const coverCenterY = (thumbnail.top + thumbnail.bottom) / 2;
    expect(Math.abs(textCenterY - coverCenterY)).toBeLessThan(3);
    expect(thumbnail.bottom - thumbnail.top + 1).toBeGreaterThanOrEqual(artist.bottom - title.top + 1 - 2);
    const fullLight = inkBrightness(frameAt(3), artist.pixels);
    const tail = rms(samples, 26, 26.1);
    for (const [position, time, expectedGain, referenceAudio] of [
      [1, 0.15, 0.15 / 0.35, quiet],
      [5, 28.5, 0.5, tail],
      [6, 29.5, 1 / 6, tail],
    ] as const) {
      const pictureGain = inkBrightness(frameAt(position), artist.pixels) / fullLight;
      const audioGain = rms(samples, time - 0.015, time + 0.015) / referenceAudio;
      expect(Math.abs(pictureGain - expectedGain)).toBeLessThan(0.06);
      expect(Math.abs(audioGain - expectedGain)).toBeLessThan(0.06);
      expect(Math.abs(pictureGain - audioGain)).toBeLessThan(0.06);
    }
    expect(inkBrightness(frameAt(0), artist.pixels)).toBeLessThan(2);
    expect(inkBrightness(frameAt(7), artist.pixels) / fullLight).toBeLessThan(0.02);
    expect(rms(samples, duration - 0.02, duration) / tail).toBeLessThan(0.015);
  }, 420_000);
});
