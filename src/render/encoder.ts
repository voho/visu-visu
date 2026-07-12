import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { once } from "node:events";
import type { ProjectConfig } from "../types.js";

export const DELIVERY_AUDIO_BITRATE = 384_000;

interface EncoderOptions {
  audioPath: string;
  outputPath: string;
  config: ProjectConfig;
  start: number;
  duration: number;
  frameCount: number;
  inputWidth: number;
  inputHeight: number;
  overwrite: boolean;
}

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class FfmpegEncoder {
  private readonly child: ChildProcess;
  private readonly exitPromise: Promise<ExitStatus>;
  private stderr = "";
  private inputError: Error | undefined;
  private finished = false;

  private constructor(child: ChildProcess) {
    this.child = child;
    this.exitPromise = new Promise<ExitStatus>((resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-24_000);
    });
    child.stdin?.on("error", (error: Error) => {
      this.inputError = error;
    });
  }

  static async create(options: EncoderOptions): Promise<FfmpegEncoder> {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    if (!options.overwrite) {
      try {
        await access(outputPath);
        throw new Error(`Output already exists: ${outputPath}. Pass --overwrite to replace it.`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Output already exists:")) throw error;
      }
    }
    const { output } = options.config;
    const gopFrames = Math.max(1, Math.round(output.fps / 2));
    const args = [
      "-hide_banner",
      options.overwrite ? "-y" : "-n",
      "-loglevel",
      "warning",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      `${options.inputWidth}x${options.inputHeight}`,
      "-framerate",
      String(output.fps),
      "-i",
      "pipe:0",
    ];

    if (options.start > 0) args.push("-ss", options.start.toFixed(6));
    args.push("-i", resolve(options.audioPath));
    args.push(
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-t",
      options.duration.toFixed(6),
      "-frames:v",
      String(options.frameCount),
    );
    args.push(
      "-vf",
      `scale=${output.width}:${output.height}:flags=lanczos+accurate_rnd+full_chroma_int:in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p,setsar=1`,
    );
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      output.preset,
      "-tune",
      "animation",
      "-crf",
      String(output.crf),
      "-profile:v",
      "high",
      "-g",
      String(gopFrames),
      "-keyint_min",
      String(gopFrames),
      "-sc_threshold",
      "0",
      "-bf",
      "2",
      "-refs",
      "4",
      "-pix_fmt",
      "yuv420p",
      "-x264-params",
      "open-gop=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited",
      "-color_range",
      "tv",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-aac_coder",
      "twoloop",
      "-aac_ms",
      "0",
      "-b:a",
      `${DELIVERY_AUDIO_BITRATE / 1000}k`,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
    );
    if (options.config.text.title) args.push("-metadata", `title=${options.config.text.title}`);
    if (options.config.text.artist) args.push("-metadata", `artist=${options.config.text.artist}`);
    args.push(outputPath);

    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    const encoder = new FfmpegEncoder(child);
    await new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
    });
    return encoder;
  }

  async write(frame: Buffer): Promise<void> {
    if (this.finished) throw new Error("Cannot write to a finished encoder");
    const input = this.child.stdin;
    if (!input || input.destroyed) {
      return this.throwInputError("FFmpeg closed its input early");
    }
    try {
      if (!input.write(frame)) {
        const result = await Promise.race([
          once(input, "drain").then(() => "drain" as const),
          this.exitPromise.then(() => "exit" as const),
        ]);
        if (result === "exit") await this.throwInputError("FFmpeg closed its input early");
      }
      if (this.inputError) await this.throwInputError("FFmpeg rejected frame input");
    } catch {
      await this.throwInputError("FFmpeg rejected frame input");
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.child.stdin?.end();
    const { code, signal } = await this.exitPromise;
    if (code !== 0) {
      throw new Error(this.errorMessage(`FFmpeg exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    }
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.child.stdin?.destroy();
    this.child.kill("SIGTERM");
  }

  private errorMessage(prefix: string): string {
    const detail = this.stderr.trim();
    return detail ? `${prefix}: ${detail}` : prefix;
  }

  private async throwInputError(prefix: string): Promise<never> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await this.exitPromise;
    }
    const message = this.errorMessage(prefix);
    if (this.stderr.trim() || !this.inputError) throw new Error(message);
    throw new Error(`${message}: ${this.inputError.message}`);
  }
}
