import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadImage } from "@napi-rs/canvas";
import { readAudioMetadata } from "./audio/metadata.js";
import { isThumbnailRaster, renderThumbnail } from "./render/thumbnail.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);

export interface ThumbnailCommandOptions {
  input: string;
  artist?: string;
  title?: string;
  image?: string;
  output?: string;
  outputDir?: string;
  overwrite?: boolean;
}

export interface ThumbnailJob {
  audioPath: string;
  imagePath: string;
  title: string;
  artist: string;
  outputPath: string;
}

function stem(path: string): string {
  return basename(path, extname(path));
}

function credit(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const result = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!result) throw new Error(`--${name} must not be blank`);
  return result;
}

async function coverFor(audioPath: string): Promise<string> {
  const entries = await readdir(dirname(audioPath), { withFileTypes: true });
  const matches = entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink())
    && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())
    && stem(entry.name).normalize("NFC").toLowerCase() === stem(audioPath).normalize("NFC").toLowerCase());
  if (!matches.length) throw new Error(`No matching cover for ${basename(audioPath)}. Add a same-named PNG, JPEG, WebP or AVIF, or use --image for a single song.`);
  if (matches.length > 1) throw new Error(`Ambiguous covers for ${basename(audioPath)}: ${matches.map((entry) => entry.name).join(", ")}. Use --image with a single song.`);
  return join(dirname(audioPath), matches[0]!.name);
}

async function validateCover(imagePath: string): Promise<void> {
  if (!IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())) {
    throw new Error(`Unsupported cover format: ${imagePath}. Use a local PNG, JPEG, WebP or AVIF.`);
  }
  if (!(await stat(imagePath)).isFile()) throw new Error(`Cover is not a file: ${imagePath}`);
  const bytes = await readFile(imagePath);
  if (!isThumbnailRaster(bytes)) {
    throw new Error(`Cover must be a raster image: ${imagePath}`);
  }
  try {
    const image = await loadImage(bytes);
    if (!image.width || !image.height) throw new Error("Image has no pixels");
  } catch (error) {
    throw new Error(`Could not decode cover ${imagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Resolve existing parent symlinks even when the final output does not exist yet. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Validate the entire batch before writing any images. No decoding of song PCM is needed. */
export async function planThumbnailJobs(options: ThumbnailCommandOptions): Promise<ThumbnailJob[]> {
  const input = resolve(options.input);
  const info = await stat(input);
  const batch = info.isDirectory();
  if (!batch && !info.isFile()) throw new Error(`Input is not a song file or folder: ${input}`);
  if (batch && (options.title !== undefined || options.image !== undefined || options.output !== undefined)) {
    throw new Error("Folder thumbnails use per-song names and covers. Use --output-dir; --title, --image and --output are only valid for a single song.");
  }
  if (options.output !== undefined && options.outputDir !== undefined) {
    throw new Error("Use either --output or --output-dir, not both");
  }
  const artist = credit(options.artist, "artist");
  const title = credit(options.title, "title");
  const audioPaths = batch
    ? (await readdir(input, { withFileTypes: true }))
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && extname(entry.name).toLowerCase() === ".wav")
      .map((entry) => join(input, entry.name)).sort()
    : [input];
  if (!audioPaths.length) throw new Error(`No WAV songs found directly in ${input}`);
  const names = new Set<string>();
  const jobs: ThumbnailJob[] = [];
  for (const audioPath of audioPaths) {
    const name = stem(audioPath);
    const nameKey = name.normalize("NFC").toLowerCase();
    if (names.has(nameKey)) throw new Error(`Song filenames collide ignoring case: ${name}`);
    names.add(nameKey);
    if (!(await stat(audioPath)).isFile()) throw new Error(`Song is not a file: ${audioPath}`);
    await access(audioPath, constants.R_OK);
    const metadata = artist === undefined ? await readAudioMetadata(audioPath) : {};
    const resolvedArtist = artist ?? credit(metadata.artist, "artist");
    if (!resolvedArtist) throw new Error(`Artist is required for ${basename(audioPath)}. Pass --artist "Artist Name" or add audio artist tags.`);
    const imagePath = resolve(options.image ?? await coverFor(audioPath));
    await validateCover(imagePath);
    const outputDirectory = resolve(options.outputDir ?? (batch ? join(input, "thumbnails") : dirname(input)));
    const outputPath = resolve(options.output ?? join(outputDirectory, `${name}.youtube.jpg`));
    if (![".jpg", ".jpeg"].includes(extname(outputPath).toLowerCase())) {
      throw new Error(`Thumbnail output must end in .jpg or .jpeg: ${outputPath}`);
    }
    const resolvedTitle = title ?? credit(metadata.title ?? name, "title")!;
    jobs.push({ audioPath, imagePath, title: resolvedTitle, artist: resolvedArtist, outputPath });
  }

  const sourcePaths = new Set<string>();
  const sourceFiles = new Set<string>();
  for (const job of jobs) {
    for (const source of [job.audioPath, job.imagePath]) {
      sourcePaths.add((await canonicalPath(source)).normalize("NFC").toLowerCase());
      const sourceInfo = await stat(source);
      sourceFiles.add(`${sourceInfo.dev}:${sourceInfo.ino}`);
    }
  }
  const destinations = new Set<string>();
  for (const job of jobs) {
    const destination = (await canonicalPath(job.outputPath)).normalize("NFC").toLowerCase();
    if (sourcePaths.has(destination)) throw new Error(`Thumbnail output would replace an input song or cover: ${job.outputPath}`);
    if (destinations.has(destination)) throw new Error(`Thumbnail outputs collide: ${job.outputPath}`);
    destinations.add(destination);
    let outputInfo;
    try { outputInfo = await lstat(job.outputPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (outputInfo) {
      if (outputInfo.isSymbolicLink()) throw new Error(`Thumbnail output must not be a symbolic link: ${job.outputPath}`);
      if (sourceFiles.has(`${outputInfo.dev}:${outputInfo.ino}`)) throw new Error(`Thumbnail output would replace an input song or cover: ${job.outputPath}`);
      if (!outputInfo.isFile()) throw new Error(`Thumbnail output is not a file: ${job.outputPath}`);
      if (!options.overwrite) throw new Error(`Output already exists: ${job.outputPath}. Pass --overwrite to replace it.`);
    }
  }
  return jobs;
}

export async function runThumbnail(args: string[], help: string): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    artist: { type: "string" }, title: { type: "string" }, image: { type: "string" },
    output: { type: "string", short: "o" }, "output-dir": { type: "string" },
    overwrite: { type: "boolean", short: "y" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(help.trim()); return; }
  if (positionals.length !== 1) throw new Error("Provide one song file or folder. Run thumbnail --help for examples.");
  const options: ThumbnailCommandOptions = { input: positionals[0]!, overwrite: values.overwrite ?? false };
  if (values.artist !== undefined) options.artist = values.artist;
  if (values.title !== undefined) options.title = values.title;
  if (values.image !== undefined) options.image = values.image;
  if (values.output !== undefined) options.output = values.output;
  if (values["output-dir"] !== undefined) options.outputDir = values["output-dir"];
  const jobs = await planThumbnailJobs(options);
  console.log(`Thumbnail ${jobs.length} song${jobs.length === 1 ? "" : "s"} · 3840x2160 · JPEG`);
  for (const job of jobs) {
    const result = await renderThumbnail({ imagePath: job.imagePath, title: job.title,
      artist: job.artist, outputPath: job.outputPath, overwrite: options.overwrite ?? false });
    console.log(`Saved     ${result.outputPath} (${(result.bytes / 1_000_000).toFixed(2)} MB)`);
  }
}
