import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { planThumbnailJobs } from "../src/thumbnail-command.js";

const cli = resolve(import.meta.dir, "../src/cli.ts");
const directories: string[] = [];

async function fixture(names = ["Night Signal"]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "visu-thumbnail-cli-"));
  directories.push(directory);
  const canvas = createCanvas(80, 80);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ab4d26";
  ctx.fillRect(0, 0, 80, 80);
  ctx.fillStyle = "#163842";
  ctx.fillRect(0, 40, 80, 40);
  for (const name of names) {
    // Explicit credits need only a local song path, never FFprobe or PCM analysis.
    await writeFile(join(directory, `${name}.WAV`), "thumbnail fixture");
    await writeFile(join(directory, `${name}.PNG`), canvas.toBuffer("image/png"));
  }
  return directory;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, "thumbnail", ...args], {
    encoding: "utf8", timeout: 30_000,
    // Deliberately unavailable FFprobe, FFmpeg and Chrome.
    env: { ...process.env, PATH: "/visu-thumbnail-no-external-tools" },
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("thumbnail CLI", () => {
  test("plans same-name covers and preserves artist case without external tools", async () => {
    const directory = await fixture(["Bad Boys", "Event Horizon"]);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "Ignored.wav"), "nested song");
    const jobs = await planThumbnailJobs({ input: directory, artist: "  voho  " });
    expect(jobs.map((job) => [job.title, job.artist])).toEqual([["Bad Boys", "voho"], ["Event Horizon", "voho"]]);
    expect(jobs[0]!.outputPath).toBe(join(directory, "thumbnails", "Bad Boys.youtube.jpg"));
    expect((await readdir(directory)).includes("thumbnails")).toBe(false);
    const single = await planThumbnailJobs({ input: join(directory, "Bad Boys.WAV"), artist: "voho", title: "An Explicit Title" });
    expect(single[0]!.title).toBe("An Explicit Title");
    expect(single[0]!.outputPath).toBe(join(directory, "Bad Boys.youtube.jpg"));
  });

  test("exports a whole folder through the public CLI as upload-size 4K JPEGs", async () => {
    const directory = await fixture(["Bad Boys", "Night Blur"]);
    const result = run(directory, "--artist", "voho");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("2 songs");
    for (const name of ["Bad Boys", "Night Blur"]) {
      const path = join(directory, "thumbnails", `${name}.youtube.jpg`);
      const bytes = await readFile(path);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
      expect(bytes.length).toBeLessThan(2_000_000);
      const image = await loadImage(bytes);
      expect([image.width, image.height]).toEqual([3840, 2160]);
    }
    const rerun = run(directory, "--artist", "voho");
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain("--overwrite");
  }, 30_000);

  test("rejects all known batch errors before creating any outputs", async () => {
    const directory = await fixture(["A First", "Z Last"]);
    await rm(join(directory, "Z Last.PNG"));
    let result = run(directory, "--artist", "voho");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No matching cover");
    expect((await readdir(directory)).includes("thumbnails")).toBe(false);
    await writeFile(join(directory, "Z Last.PNG"), "broken image");
    result = run(directory, "--artist", "voho");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a raster image");
    expect((await readdir(directory)).includes("thumbnails")).toBe(false);
    await writeFile(join(directory, "Z Last.PNG"), `${" ".repeat(1500)}<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>`);
    result = run(directory, "--artist", "voho");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be a raster image");
    expect((await readdir(directory)).includes("thumbnails")).toBe(false);
    await copyFile(join(directory, "A First.PNG"), join(directory, "Z Last.PNG"));
    await mkdir(join(directory, "thumbnails"));
    await writeFile(join(directory, "thumbnails", "Z Last.youtube.jpg"), "already present");
    result = run(directory, "--artist", "voho");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(await readdir(join(directory, "thumbnails"))).toEqual(["Z Last.youtube.jpg"]);
  });

  test("rejects later batch destination symlinks before writing earlier songs", async () => {
    const directory = await fixture(["A First", "Z Last"]);
    const outputDirectory = join(directory, "thumbnails");
    const output = join(outputDirectory, "Z Last.youtube.jpg");
    const existingTarget = join(directory, "existing-target.jpg");
    await mkdir(outputDirectory);
    await writeFile(existingTarget, "unchanged target");
    for (const target of [existingTarget, join(directory, "missing-target.jpg")]) {
      await symlink(target, output);
      const result = run(directory, "--artist", "voho", "--overwrite");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must not be a symbolic link");
      expect(await readdir(outputDirectory)).toEqual(["Z Last.youtube.jpg"]);
      expect(await readFile(existingTarget, "utf8")).toBe("unchanged target");
      await rm(output);
    }
  });

  test("rejects ambiguous covers and provides explicit single-song overrides", async () => {
    const directory = await fixture();
    const audio = join(directory, "Night Signal.WAV");
    const canvas = createCanvas(40, 40);
    const alternate = join(directory, "night signal.JPEG");
    await writeFile(alternate, canvas.toBuffer("image/jpeg"));
    await expect(planThumbnailJobs({ input: audio, artist: "voho" })).rejects.toThrow("Ambiguous covers");
    const jobs = await planThumbnailJobs({ input: audio, artist: "voho", image: alternate, outputDir: join(directory, "custom") });
    expect(jobs[0]!.imagePath).toBe(alternate);
    expect(jobs[0]!.outputPath).toBe(join(directory, "custom", "Night Signal.youtube.jpg"));
  });

  test("never overwrites source covers even through symlinks or hard links", async () => {
    const directory = await fixture();
    const canvas = createCanvas(40, 40);
    const image = join(directory, "cover.jpg");
    await writeFile(image, canvas.toBuffer("image/jpeg"));
    const audio = join(directory, "Night Signal.WAV");
    const symbolic = join(directory, "symbolic.jpg"), hard = join(directory, "hard.jpg");
    await symlink(image, symbolic);
    await link(image, hard);
    for (const output of [image, symbolic, hard]) {
      await expect(planThumbnailJobs({ input: audio, artist: "voho", image, output, overwrite: true })).rejects.toThrow("replace an input");
    }
  });

  test("rejects conflicting options, blank credits and unexpected positionals", async () => {
    const directory = await fixture();
    for (const args of [["--title", "Wrong"], ["--image", "cover.png"], ["--output", "out.jpg"]]) {
      const result = run(directory, "--artist", "voho", ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("only valid for a single song");
    }
    const audio = join(directory, "Night Signal.WAV");
    await expect(planThumbnailJobs({ input: audio, artist: " " })).rejects.toThrow("must not be blank");
    await expect(planThumbnailJobs({ input: audio, artist: "voho", output: "x.png" })).rejects.toThrow(".jpg or .jpeg");
    await expect(planThumbnailJobs({ input: audio, artist: "voho", output: "x.jpg", outputDir: "other" })).rejects.toThrow("either --output");
    expect(run(audio, "another.wav", "--artist", "voho").status).toBe(1);
    expect(run("--help").stdout).toContain("Thumbnail options");
  });
});
