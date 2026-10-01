import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import { analyzeAudio } from "../audio/analyze.js";
import { assertFfmpegAvailable, decodeAudio } from "../audio/decode.js";
import { readAudioMetadata } from "../audio/metadata.js";
import { deriveMusicMotion } from "../render/music-motion.js";
import { lightingAt } from "../render/lighting.js";
import { surfaceFeatureSamples, SURFACE_FEATURE_BANDS } from "../render/surface-signal.js";
import { deriveSceneDynamics, SCENE_LAYER_NAMES } from "../render/scene-dynamics.js";
import { frozenCloudAt, frozenCloudPlan, FROZEN_CLOUD_LIFETIME, type FrozenCloudCapture, type FrozenCloudEvent } from "../render/frozen-cloud.js";
import type { AudioAnalysis } from "../types.js";
import { prepareArtwork } from "../render/artwork.js";
import { randomPalette, type ScenePalette } from "../render/palette.js";
import type { MaterialMap } from "../render/material.js";
import { audioFieldAt } from "../render/audio-field.js";

export const LIGHTING_FEATURE_BANDS = SURFACE_FEATURE_BANDS;
export const LIGHTING_TIMELINE_STRIDE = 36 + LIGHTING_FEATURE_BANDS * 4 + 5 + SCENE_LAYER_NAMES.length * 2;
const HELP = `Live resonance preview\n\nUsage: bun run lighting:preview -- <song> [options]\n\n  --image <path>      Optional cover artwork\n  --title <text>      Track title (defaults to tags or filename)\n  --artist <text>     Artist credit (defaults to audio tags)\n  --port <number>     Local port (default: 4180)\n  --seed <text>       Deterministic lighting seed\n  --low-flash         Reduce fast light accents\n  --help             Show this help\n\nStarts a local WebGL sculpture with music-driven materials, filaments, and lights.\nUse render/clip to export the complete video scene as MP4.\n`;

export interface LightingPreviewOptions {
  audioPath: string;
  imagePath?: string;
  title?: string;
  artist?: string;
  port: number;
  seed?: string;
  lowFlash: boolean;
}

export function parseLightingPreviewArgs(args: string[]): LightingPreviewOptions | null {
  const { values, positionals } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    allowPositionals: true,
    strict: true,
    options: {
      image: { type: "string" }, title: { type: "string" }, artist: { type: "string" },
      port: { type: "string" }, seed: { type: "string" }, "low-flash": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return null;
  if (positionals.length !== 1) throw new Error("Provide one song path. Use --help for usage.");
  const port = values.port === undefined ? 4180 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  if (values.seed !== undefined && !values.seed.trim()) throw new Error("--seed cannot be empty");
  return {
    audioPath: resolve(positionals[0]!), port, lowFlash: values["low-flash"] ?? false,
    ...(values.image !== undefined ? { imagePath: resolve(values.image) } : {}),
    ...(values.title !== undefined ? { title: values.title } : {}),
    ...(values.artist !== undefined ? { artist: values.artist } : {}),
    ...(values.seed !== undefined ? { seed: values.seed } : {}),
  };
}

export interface LightingPreviewProfile {
  title: string;
  artist: string;
  duration: number;
  fps: number;
  frameCount: number;
  stride: number;
  hasArtwork: boolean;
  palette: ScenePalette;
  lowFlash?: boolean;
  seed?: string;
  ghosts?: LightingGhostSchedule;
}

export interface LightingGhostSchedule {
  lifetime: number;
  envelopeFps: number;
  events: readonly FrozenCloudCapture[];
  envelope: Array<Pick<FrozenCloudEvent, "scale" | "opacity" | "blur" | "dissolve">>;
}

/** The browser samples the exact shared optical curve instead of reimplementing it. */
export function buildLightingGhostSchedule(analysis: AudioAnalysis): LightingGhostSchedule {
  const envelopeFps = 30;
  const envelope = Array.from({ length: Math.ceil(FROZEN_CLOUD_LIFETIME * envelopeFps) + 1 }, (_, index) => {
    const event = frozenCloudAt({ id: 0, captureTime: 0, strength: 1 }, Math.min(index / envelopeFps, FROZEN_CLOUD_LIFETIME - 1e-8))!;
    return { scale: event.scale, opacity: index / envelopeFps >= FROZEN_CLOUD_LIFETIME ? 0 : event.opacity, blur: event.blur, dissolve: event.dissolve };
  });
  return { lifetime: FROZEN_CLOUD_LIFETIME, envelopeFps, events: frozenCloudPlan(analysis), envelope };
}

/** Compact deterministic uniforms; playback/seek time comes from the audio element. */
export async function prepareLightingPalette(imagePath: string | undefined, seed: string): Promise<ScenePalette> {
  const artwork = await prepareArtwork(imagePath, 1920, 1080);
  return artwork?.palette ?? randomPalette(seed);
}

/** Data maps are made from the unmasked source image, never its darkened backdrop. */
export function encodeLightingMaterialMaps(material: MaterialMap): ReadonlyMap<string, Uint8Array> {
  const { width, height } = material;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(width, height);
  const assets = new Map<string, Uint8Array>();
  for (const kind of ["normal", "roughness"] as const) {
    for (let index = 0; index < width * height; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = kind === "normal" ? material.normals[index * 3 + channel]! * 0.5 + 0.5 : material.roughness[index]!;
        pixels.data[index * 4 + channel] = Math.round(Math.max(0, Math.min(1, value)) * 255);
      }
      pixels.data[index * 4 + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    assets.set(`/object-${kind}.png`, canvas.toBuffer("image/png"));
  }
  return assets;
}

export function buildLightingTimeline(analysis: AudioAnalysis, seed: string, lowFlash = false, palette: ScenePalette = randomPalette(seed)): Float32Array {
  const output = new Float32Array(analysis.frames.length * LIGHTING_TIMELINE_STRIDE);
  for (let index = 0; index < analysis.frames.length; index += 1) {
    const time = index / analysis.fps;
    const motion = deriveMusicMotion(analysis, time);
    const dynamics = deriveSceneDynamics(analysis, time);
    const paletteHue = palette.anchorHue + dynamics.drift.clock * 22 + dynamics.cloud.energy * 18
      + dynamics.body.energy * 24 + dynamics.detail.energy * 36 + dynamics.spark.energy * 12;
    const lightMotion = { ...motion, bassEnergy: dynamics.body.energy, midEnergy: dynamics.detail.energy,
      trebleEnergy: dynamics.spark.energy, bassPulse: dynamics.impact.energy,
      treblePulse: dynamics.spark.energy, sustain: dynamics.cloud.energy };
    const state = lightingAt(lightMotion, time, seed, paletteHue, lowFlash, analysis.frames[index]!.spectrum, palette);
    let offset = index * LIGHTING_TIMELINE_STRIDE;
    for (const value of [motion.slowTime, motion.fastTime, motion.bassEnergy, motion.midEnergy,
      motion.trebleEnergy, motion.bassPulse, motion.treblePulse, motion.sustain,
      ...state.ambient, state.exposure]) output[offset++] = value;
    for (const light of state.lights) {
      for (const value of [...light.position, ...light.color, light.intensity, light.falloff]) output[offset++] = value;
    }
    const samples = surfaceFeatureSamples(analysis.frames[index]!);
    output.set(samples, offset);
    offset += samples.length;
    if (state.spectrum) {
      output.set(state.spectrum.values, offset);
      output[offset + 32] = state.spectrum.rotation[0];
      output[offset + 33] = state.spectrum.rotation[1];
      output[offset + 34] = state.spectrum.strength;
    } else {
      output[offset + 32] = 1;
    }
    offset += 35;
    for (const name of SCENE_LAYER_NAMES) {
      output[offset++] = dynamics[name].energy;
      output[offset++] = dynamics[name].clock;
    }
    const field = audioFieldAt(analysis, time);
    output[offset++] = field.fast;
    output[offset++] = field.slow;
    output.set(field.spectrum, offset);
  }
  return output;
}

/** Supports one inclusive HTTP byte range, including suffix and open-ended requests. */
export function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    return { start: Math.max(0, size - count), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(size - 1, requestedEnd) };
}

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

/** Files are explicit routes only; requested paths never become filesystem paths. */
export function createLightingPreviewHandler(
  profile: LightingPreviewProfile,
  timeline: Float32Array,
  files: ReadonlyMap<string, string>,
  assets: ReadonlyMap<string, Uint8Array> = new Map(),
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (!localHosts.has(url.hostname)) return new Response("Local preview only", { status: 403, headers: RESPONSE_HEADERS });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { ...RESPONSE_HEADERS, Allow: "GET, HEAD" } });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
    if (url.pathname === "/profile.json") {
      return new Response(request.method === "HEAD" ? null : JSON.stringify(profile), {
        headers: { ...RESPONSE_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/timeline.f32") {
      return new Response(request.method === "HEAD" ? null : timeline, {
        headers: { ...RESPONSE_HEADERS, "Content-Type": "application/octet-stream", "Content-Length": String(timeline.byteLength) },
      });
    }
    const asset = assets.get(url.pathname);
    if (asset) return new Response(request.method === "HEAD" ? null : asset, {
      headers: { ...RESPONSE_HEADERS, "Content-Type": "image/png", "Content-Length": String(asset.byteLength) },
    });
    const path = files.get(url.pathname);
    if (!path) return new Response("Not found", { status: 404, headers: RESPONSE_HEADERS });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Preview asset missing", { status: 404, headers: RESPONSE_HEADERS });
    const headers = { ...RESPONSE_HEADERS, "Content-Type": file.type || "application/octet-stream", "Accept-Ranges": "bytes" };
    const requestedRange = request.headers.get("Range");
    if (requestedRange) {
      const range = parseByteRange(requestedRange, file.size);
      if (!range) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${file.size}` } });
      return new Response(request.method === "HEAD" ? null : file.slice(range.start, range.end + 1), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`, "Content-Length": String(range.end - range.start + 1) },
      });
    }
    return new Response(request.method === "HEAD" ? null : file, { headers: { ...headers, "Content-Length": String(file.size) } });
  };
}

async function assertFile(path: string, label: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} was not found or is not a readable file: ${path}`);
  }
}

async function main(): Promise<void> {
  const options = parseLightingPreviewArgs(process.argv.slice(2));
  if (!options) { process.stdout.write(HELP); return; }
  await assertFile(options.audioPath, "Song");
  if (options.imagePath) await assertFile(options.imagePath, "Cover artwork");
  await assertFfmpegAvailable();
  console.log("Analyzing music for synchronized lighting…");
  const [pcm, tags] = await Promise.all([decodeAudio(options.audioPath), readAudioMetadata(options.audioPath)]);
  const analysis = analyzeAudio(pcm, 60, 64);
  const seed = options.seed ?? analysis.sourceHash.slice(0, 16);
  const artwork = await prepareArtwork(options.imagePath, 1920, 1080);
  const palette = artwork?.palette ?? randomPalette(seed);
  const assets = artwork?.objectMaterial ? encodeLightingMaterialMaps(artwork.objectMaterial) : new Map<string, Uint8Array>();
  const timeline = buildLightingTimeline(analysis, seed, options.lowFlash, palette);
  const files = new Map<string, string>([
    ["/", resolve(import.meta.dir, "lighting.html")],
    ["/lighting.js", resolve(import.meta.dir, "lighting.js")],
    ["/lighting-mesh.js", resolve(import.meta.dir, "lighting-mesh.js")],
    ["/lighting-ghosts.js", resolve(import.meta.dir, "lighting-ghosts.js")],
    ["/lighting-audio-field.js", resolve(import.meta.dir, "lighting-audio-field.js")],
    ["/lighting-camera.js", resolve(import.meta.dir, "lighting-camera.js")],
    ["/lighting-glow.js", resolve(import.meta.dir, "lighting-glow.js")],
    ["/lighting-particles.js", resolve(import.meta.dir, "lighting-particles.js")],
    ["/lighting-lensing.js", resolve(import.meta.dir, "lighting-lensing.js")],
    ["/lighting-fragments.js", resolve(import.meta.dir, "lighting-fragments.js")],
    ["/lighting-flow.js", resolve(import.meta.dir, "lighting-flow.js")],
    ["/render/surface-fragments.js", resolve(import.meta.dir, "../render/surface-fragments.js")],
    ["/render/spectral-flow.js", resolve(import.meta.dir, "../render/spectral-flow.js")],
    ["/audio-field-geometry.js", resolve(import.meta.dir, "../render/audio-field-geometry.js")],
    ["/audio", options.audioPath],
    ["/albedo.png", resolve(import.meta.dir, "../../assets/materials/silk-albedo.png")],
    ["/normal.png", resolve(import.meta.dir, "../../assets/materials/silk-normal.png")],
    ["/roughness.png", resolve(import.meta.dir, "../../assets/materials/silk-roughness.png")],
  ]);
  if (options.imagePath) files.set("/artwork", options.imagePath);
  for (const [route, path] of files) await assertFile(path, `Preview asset ${route}`);
  const profile: LightingPreviewProfile = {
    title: options.title ?? tags.title ?? basename(options.audioPath, extname(options.audioPath)),
    artist: options.artist ?? tags.artist ?? "", duration: analysis.duration,
    fps: analysis.fps, frameCount: analysis.frames.length, stride: LIGHTING_TIMELINE_STRIDE,
    palette, seed, hasArtwork: Boolean(options.imagePath), lowFlash: options.lowFlash, ghosts: buildLightingGhostSchedule(analysis),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port, fetch: createLightingPreviewHandler(profile, timeline, files, assets) });
  console.log(`Live resonance preview: ${server.url}\n${profile.title}${profile.artist ? ` — ${profile.artist}` : ""}\nPress Ctrl+C to stop.`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.stop(true); process.exit(0); });
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
