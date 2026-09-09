import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AudioMetadata {
  title?: string;
  artist?: string;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTags(value: unknown): Map<string, string> {
  const tags = new Map<string, string>();
  if (!isRecord(value)) return tags;
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") continue;
    const normalized = rawValue.normalize("NFC").replace(/\s+/g, " ").trim();
    if (normalized) tags.set(key.trim().toLowerCase(), normalized);
  }
  return tags;
}

/** Reads song tags without involving a shell or deriving credits from a filename. */
export async function readAudioMetadata(path: string): Promise<AudioMetadata> {
  const absolutePath = resolve(path);
  try {
    await access(absolutePath, constants.R_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read audio metadata from ${absolutePath}: ${message}`);
  }

  let stdout: string;
  try {
    const result = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "format_tags:stream_tags",
      "-of", "json",
      absolutePath,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as Error & { code?: string | number; stderr?: string };
    if (failure.code === "ENOENT") {
      throw new Error("ffprobe was not found on PATH; install FFmpeg with ffprobe to read song title and artist tags");
    }
    const detail = failure.stderr?.trim() || failure.message || String(error);
    throw new Error(`ffprobe could not read audio metadata from ${absolutePath}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`ffprobe returned malformed metadata JSON for ${absolutePath}`);
  }
  if (!isRecord(parsed) || (parsed.streams !== undefined && !Array.isArray(parsed.streams))) {
    throw new Error(`ffprobe returned malformed metadata JSON for ${absolutePath}`);
  }
  const format = normalizedTags(isRecord(parsed.format) ? parsed.format.tags : undefined);
  // -select_streams a excludes video tags, including attached cover artwork.
  const streams = Array.isArray(parsed.streams)
    ? parsed.streams.filter(isRecord).map((stream) => normalizedTags(stream.tags))
    : [];
  const firstStreamTag = (name: string): string | undefined =>
    streams.map((tags) => tags.get(name)).find((value) => value !== undefined);
  const title = format.get("title") ?? firstStreamTag("title");
  const artist = format.get("artist") ?? firstStreamTag("artist")
    ?? format.get("album_artist") ?? firstStreamTag("album_artist");
  const result: AudioMetadata = {};
  if (title) result.title = title;
  if (artist) result.artist = artist;
  return result;
}
