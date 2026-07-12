import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProjectConfig } from "./types.js";

export const DEFAULT_CONFIG: ProjectConfig = {
  version: 1,
  output: {
    width: 1920,
    height: 1080,
    fps: 30,
    renderScale: 1,
    crf: 8,
    preset: "slow",
    fadeSeconds: 3,
  },
  text: {
    title: "",
    artist: "",
  },
  visual: {
    seed: "auto",
    intensity: 1,
    bokehCount: 48,
    spectrumBands: 64,
    grain: 0.018,
    vignette: 0.28,
    lowFlash: true,
  },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  const parsed = finiteNumber(value, fallback, label);
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function integer(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  const parsed = boundedNumber(value, fallback, label, min, max);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function stringValue(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  if (!isRecord(value)) throw new Error("Configuration must be a JSON object");
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`Unsupported configuration version: ${String(value.version)}`);
  }

  const output = value.output === undefined ? {} : value.output;
  const text = value.text === undefined ? {} : value.text;
  const visual = value.visual === undefined ? {} : value.visual;

  if (!isRecord(output)) throw new Error("output must be an object");
  if (!isRecord(text)) throw new Error("text must be an object");
  if (!isRecord(visual)) throw new Error("visual must be an object");

  const preset = stringValue(
    output.preset,
    DEFAULT_CONFIG.output.preset,
    "output.preset",
  );
  const allowedPresets = ["ultrafast", "veryfast", "fast", "medium", "slow"] as const;
  if (!allowedPresets.some((candidate) => candidate === preset)) {
    throw new Error(`output.preset must be one of ${allowedPresets.join(", ")}`);
  }

  const width = integer(output.width, DEFAULT_CONFIG.output.width, "output.width", 160, 7680);
  const height = integer(output.height, DEFAULT_CONFIG.output.height, "output.height", 160, 7680);
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error("output.width and output.height must be even for H.264 encoding");
  }

  return {
    version: 1,
    output: {
      width,
      height,
      fps: integer(output.fps, DEFAULT_CONFIG.output.fps, "output.fps", 12, 60),
      renderScale: boundedNumber(
        output.renderScale,
        DEFAULT_CONFIG.output.renderScale,
        "output.renderScale",
        0.25,
        1,
      ),
      crf: integer(output.crf, DEFAULT_CONFIG.output.crf, "output.crf", 0, 51),
      preset: preset as ProjectConfig["output"]["preset"],
      fadeSeconds: boundedNumber(
        output.fadeSeconds,
        DEFAULT_CONFIG.output.fadeSeconds,
        "output.fadeSeconds",
        0,
        30,
      ),
    },
    text: {
      title: stringValue(text.title, DEFAULT_CONFIG.text.title, "text.title").trim(),
      artist: stringValue(text.artist, DEFAULT_CONFIG.text.artist, "text.artist").trim(),
    },
    visual: {
      seed: stringValue(visual.seed, DEFAULT_CONFIG.visual.seed, "visual.seed").trim() || "auto",
      intensity: boundedNumber(
        visual.intensity,
        DEFAULT_CONFIG.visual.intensity,
        "visual.intensity",
        0,
        2,
      ),
      bokehCount: integer(
        visual.bokehCount,
        DEFAULT_CONFIG.visual.bokehCount,
        "visual.bokehCount",
        0,
        160,
      ),
      spectrumBands: integer(
        visual.spectrumBands,
        DEFAULT_CONFIG.visual.spectrumBands,
        "visual.spectrumBands",
        16,
        128,
      ),
      grain: boundedNumber(visual.grain, DEFAULT_CONFIG.visual.grain, "visual.grain", 0, 0.2),
      vignette: boundedNumber(
        visual.vignette,
        DEFAULT_CONFIG.visual.vignette,
        "visual.vignette",
        0,
        0.8,
      ),
      lowFlash: booleanValue(visual.lowFlash, DEFAULT_CONFIG.visual.lowFlash, "visual.lowFlash"),
    },
  };
}

export async function loadProjectConfig(configPath?: string): Promise<ProjectConfig> {
  if (!configPath) return parseProjectConfig(DEFAULT_CONFIG);
  const absolutePath = resolve(configPath);
  let contents: string;
  try {
    contents = await readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read config ${absolutePath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse config ${absolutePath}: ${message}`);
  }
  return parseProjectConfig(parsed);
}

export function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid size "${value}". Use WIDTHxHEIGHT, for example 1920x1080.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const parsed = parseProjectConfig({ output: { width, height } });
  return { width: parsed.output.width, height: parsed.output.height };
}

export function parseRatio(value: string): number {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid ratio "${value}". Use WIDTH:HEIGHT, for example 3:2.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  if (!(ratio >= 0.25 && ratio <= 4)) {
    throw new Error("Aspect ratio must be between 1:4 and 4:1");
  }
  return ratio;
}

export function dimensionsFor(
  resolution: string,
  ratio: number,
): { width: number; height: number } {
  const longEdges: Record<string, number> = {
    hd: 1280,
    fullhd: 1920,
    "4k": 3840,
  };
  const longEdge = longEdges[resolution.toLowerCase()];
  if (!longEdge) throw new Error('--resolution must be "hd", "fullhd", or "4k"');
  const even = (value: number): number => Math.max(160, Math.round(value / 2) * 2);
  if (ratio >= 1) return { width: longEdge, height: even(longEdge / ratio) };
  return { width: even(longEdge * ratio), height: longEdge };
}

export function renderDimensions(config: ProjectConfig): { width: number; height: number } {
  const scaled = (value: number): number =>
    Math.max(32, Math.round((value * config.output.renderScale) / 2) * 2);
  return {
    width: scaled(config.output.width),
    height: scaled(config.output.height),
  };
}
