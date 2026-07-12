import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AudioPcm } from "../types.js";

const ANALYSIS_SAMPLE_RATE = 24_000;

export async function assertFfmpegAvailable(): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.once("error", () => reject(new Error("FFmpeg was not found on PATH")));
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error("FFmpeg is installed but could not be started"));
    });
  });
}

export async function hashFile(path: string): Promise<string> {
  const absolutePath = resolve(path);
  return await new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function decodeAudio(audioPath: string): Promise<AudioPcm> {
  const absolutePath = resolve(audioPath);
  await access(absolutePath);

  const chunks: Buffer[] = [];
  let stderr = "";
  const sourceFileHashPromise = hashFile(absolutePath);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    absolutePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(ANALYSIS_SAMPLE_RATE),
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "pipe:1",
  ];

  const decodePromise = new Promise<void>((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`FFmpeg could not decode the audio${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
  const [, sourceFileHash] = await Promise.all([decodePromise, sourceFileHashPromise]);

  const pcmBuffer = Buffer.concat(chunks);
  const alignedBytes = pcmBuffer.byteLength - (pcmBuffer.byteLength % 4);
  if (alignedBytes === 0) throw new Error("The input did not contain a decodable audio stream");
  const copied = pcmBuffer.buffer.slice(
    pcmBuffer.byteOffset,
    pcmBuffer.byteOffset + alignedBytes,
  );
  const samples = new Float32Array(copied);
  const sourceHash = createHash("sha256").update(pcmBuffer.subarray(0, alignedBytes)).digest("hex");

  return {
    samples,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    duration: samples.length / ANALYSIS_SAMPLE_RATE,
    sourceHash,
    sourceFileHash,
  };
}
