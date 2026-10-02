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

async function decodePcm(absolutePath: string, channels: number): Promise<Buffer> {
  return await new Promise<Buffer>((accept, reject) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", absolutePath,
      "-vn", "-ac", String(channels), "-ar", String(ANALYSIS_SAMPLE_RATE),
      "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? accept(Buffer.concat(chunks))
      : reject(new Error(`FFmpeg could not decode the audio${stderr.trim() ? `: ${stderr.trim()}` : ""}`)));
  });
}

export async function decodeAudio(audioPath: string): Promise<AudioPcm> {
  const absolutePath = resolve(audioPath);
  await access(absolutePath);
  // Keep the established mono decode byte-for-byte: source hashes, preset
  // choices and foreground motion must not depend on adding a stereo readout.
  const [mono, stereo, sourceFileHash] = await Promise.all([
    decodePcm(absolutePath, 1), decodePcm(absolutePath, 2), hashFile(absolutePath),
  ]);
  if (!mono.length || mono.length % 4 || stereo.length !== mono.length * 2) {
    throw new Error("The input did not contain complete mono and stereo audio streams");
  }
  const samples = new Float32Array(mono.buffer.slice(mono.byteOffset, mono.byteOffset + mono.byteLength));
  const interleaved = new Float32Array(stereo.buffer.slice(stereo.byteOffset, stereo.byteOffset + stereo.byteLength));
  const left = new Float32Array(samples.length), right = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    left[index] = interleaved[index * 2]!;
    right[index] = interleaved[index * 2 + 1]!;
  }
  return {
    samples, channels: { left, right }, sampleRate: ANALYSIS_SAMPLE_RATE,
    duration: samples.length / ANALYSIS_SAMPLE_RATE,
    sourceHash: createHash("sha256").update(mono).digest("hex"), sourceFileHash,
  };
}
