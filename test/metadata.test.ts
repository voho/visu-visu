import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudioMetadata } from "../src/audio/metadata.js";

let directory: string;

function fixture(name: string, metadata: string[] = []): string {
  const path = join(directory, name);
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=0.05:sample_rate=24000",
    "-c:a", "flac", ...metadata, path,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not create metadata fixture: ${result.stderr}`);
  return path;
}

function isolatedRead(path: string, executableDirectory: string): { status: number | null; stdout: string; stderr: string } {
  const source = new URL("../src/audio/metadata.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, [
    "-e",
    `import { readAudioMetadata } from ${JSON.stringify(source)};
try { console.log(JSON.stringify(await readAudioMetadata(process.argv[1]))); }
catch (error) { console.error(error.message); process.exitCode = 1; }`,
    path,
  ], { encoding: "utf8", env: { ...process.env, PATH: executableDirectory } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visu-visu-metadata-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("audio metadata", () => {
  test("reads real tagged audio with Unicode, normalized whitespace, and shell metacharacters in its filename", async () => {
    const path = fixture("song $(touch metadata-command) ; 夜.flac", [
      "-metadata", "TiTlE=  Noc\t nad  městem  ",
      "-metadata", "ARTIST=  Žofie\n  &  星  ",
    ]);
    expect(await readAudioMetadata(path)).toEqual({ title: "Noc nad městem", artist: "Žofie & 星" });
  });

  test("prefers nonempty format title and artist over audio stream tags", async () => {
    const path = fixture("format-first.mka", [
      "-metadata", "title=Format Title", "-metadata", "artist=Format Artist",
      "-metadata:s:a:0", "title=Stream Title", "-metadata:s:a:0", "artist=Stream Artist",
    ]);
    expect(await readAudioMetadata(path)).toEqual({ title: "Format Title", artist: "Format Artist" });
  });

  test("falls back to audio stream tags when format values are blank or absent", async () => {
    const path = fixture("stream-fallback.mka", [
      "-metadata", "title=  ", "-metadata", "artist=\t ",
      "-metadata:s:a:0", "TITLE=Stream Night", "-metadata:s:a:0", "ARTIST=Stream Artist",
    ]);
    expect(await readAudioMetadata(path)).toEqual({ title: "Stream Night", artist: "Stream Artist" });
  });

  test("uses album_artist only after actual track-artist tags are exhausted", async () => {
    const album = fixture("album-artist.flac", [
      "-metadata", "ALBUM_ARTIST=  Ensemble  夜 ",
    ]);
    expect(await readAudioMetadata(album)).toEqual({ artist: "Ensemble 夜" });
    const track = fixture("track-artist.mka", [
      "-metadata", "album_artist=Album Ensemble", "-metadata:s:a:0", "artist=Track Soloist",
    ]);
    expect(await readAudioMetadata(track)).toEqual({ artist: "Track Soloist" });
    const streamAlbum = fixture("stream-album.mka", [
      "-metadata:s:a:0", "ALBUM_ARTIST=Stream Ensemble",
    ]);
    expect(await readAudioMetadata(streamAlbum)).toEqual({ artist: "Stream Ensemble" });
  });

  test("returns no invented credits for untagged audio or blank tags", async () => {
    expect(await readAudioMetadata(fixture("Unknown Artist - Fake Title.flac"))).toEqual({});
    expect(await readAudioMetadata(fixture("blank.flac", [
      "-metadata", "title= \t ", "-metadata", "artist= \n ", "-metadata", "album_artist= ",
    ]))).toEqual({});
  });

  test("reports missing and invalid audio files clearly", async () => {
    await expect(readAudioMetadata(join(directory, "missing.flac"))).rejects.toThrow("Could not read audio metadata");
    const invalid = join(directory, "invalid.txt");
    await writeFile(invalid, "This is not an audio file.");
    await expect(readAudioMetadata(invalid)).rejects.toThrow("ffprobe could not read audio metadata");
  });

  test("explains how to fix unavailable ffprobe", async () => {
    const emptyBin = join(directory, "empty-bin");
    await mkdir(emptyBin);
    const result = isolatedRead(fixture("unavailable.flac"), emptyBin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ffprobe was not found on PATH; install FFmpeg with ffprobe");
  });

  test("rejects malformed ffprobe JSON with a focused error", async () => {
    const fakeBin = join(directory, "fake-bin");
    await mkdir(fakeBin);
    const fakeProbe = join(fakeBin, "ffprobe");
    await writeFile(fakeProbe, "#!/bin/sh\nprintf '%s\\n' '{broken'\n");
    await chmod(fakeProbe, 0o755);
    const result = isolatedRead(fixture("malformed.flac"), fakeBin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ffprobe returned malformed metadata JSON");
  });
});
