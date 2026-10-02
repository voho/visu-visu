import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import type { AudioAnalysis, RenderRequest } from "../types.js";
import type { PreparedArtwork } from "../render/artwork.js";
import type { RenderProgress, RenderResult } from "../render/render.js";
import { FfmpegEncoder } from "../render/encoder.js";
import { VisualizerRenderer } from "../render/renderer.js";
import { PromoRenderer, createPromoLayout } from "../render/promo.js";
import { createSafeLayout, creditLockupEllipse } from "../render/layout.js";
import { randomPalette } from "../render/palette.js";
import { deriveMusicMotion } from "../render/music-motion.js";
import { deriveSceneDynamics } from "../render/scene-dynamics.js";
import { MILKDROP_DEFAULT_PRESET_IDS, MILKDROP_PRESETS } from "./presets.js";
import { planMilkdrop } from "./plan.js";
import { launchMilkdropChrome } from "./chrome.js";

/** Never download or attach to the user's existing browser session. */
export function milkdropBrowserPath(): string {
  const configured = process.env.VISU_CHROME_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`VISU_CHROME_PATH does not exist: ${configured}`);
    return configured;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter((path): path is string => Boolean(path)).map(path => resolve(path, "Google/Chrome/Application/chrome.exe")),
  ];
  const browser = candidates.find(path => existsSync(path));
  if (!browser) throw new Error("MilkDrop needs Chrome or Chromium with WebGL2. Install Chrome or set VISU_CHROME_PATH to its executable.");
  return browser;
}

/** Butterchurn's FFT assumes 44.1 kHz and consumes real stereo PCM windows. */
async function decodeStereo(path: string, start: number, duration: number): Promise<Buffer> {
  return await new Promise<Buffer>((accept, reject) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    const child = spawn("ffmpeg", ["-v", "error", "-ss", String(start), "-i", path, "-t", String(duration),
      "-vn", "-ac", "2", "-ar", "44100", "-f", "f32le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? accept(Buffer.concat(chunks))
      : reject(new Error(`MilkDrop audio decoding failed: ${stderr.trim()}`)));
  });
}

interface PreparedRender {
  duration: number;
  totalFrames: number;
  seed: string;
  renderSize: { width: number; height: number };
  artwork: PreparedArtwork | undefined;
}

export async function renderMilkdrop(request: RenderRequest, analysis: AudioAnalysis, prepared: PreparedRender,
  onProgress?: (progress: RenderProgress) => void): Promise<RenderResult> {
  const executablePath = milkdropBrowserPath();
  const { duration, totalFrames, seed, renderSize, artwork } = prepared;
  const { width, height } = renderSize, fps = request.config.output.fps;
  const promo = request.config.visual.mode === "promo";
  if (promo && !artwork?.thumbnail) throw new Error("Promo mode requires a cover image.");
  const customPresets = request.config.visual.milkdropPresets ?? [];
  const selected = customPresets.length ? customPresets : promo ? ["tunnel-race", "mandelbox-explorer"] : [];
  const plan = planMilkdrop(analysis, seed, request.start, totalFrames, fps,
    selected.length ? selected : [...MILKDROP_DEFAULT_PRESET_IDS], selected.length > 0);
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "browser.js")], target: "browser", minify: true });
  if (!build.success || !build.outputs[0]) throw new Error(`Could not build MilkDrop runtime: ${build.logs.join("\n")}`);
  const [script, pcm] = await Promise.all([build.outputs[0].arrayBuffer(),
    decodeStereo(request.audioPath, plan.simulationStart, plan.simulationFrames / fps)]);
  if (pcm.length === 0 || pcm.length % 8 !== 0) throw new Error("MilkDrop received incomplete stereo PCM");
  const palette = artwork?.palette ?? randomPalette(seed);
  const renderer = promo ? new PromoRenderer(request.config, renderSize, artwork!)
    : new VisualizerRenderer(request.config, seed, renderSize, artwork);
  const background = createCanvas(width, height), backgroundContext = background.getContext("2d");
  const cover = promo ? undefined : artwork?.canvas.toBuffer("image/png");
  const layout = createSafeLayout(width, height), ellipse = creditLockupEllipse(layout, width, height);
  const promoLayout = createPromoLayout(width, height);
  const features = Array.from({ length: plan.simulationFrames }, (_, frame) => {
    const time = plan.simulationStart + frame / fps;
    const motion = deriveMusicMotion(analysis, time), dynamics = deriveSceneDynamics(analysis, time);
    return [dynamics.body.energy * (0.3 + 0.7 * motion.bassEnergy),
      dynamics.detail.energy * (0.5 + 0.5 * motion.midEnergy), dynamics.spark.energy * (0.5 + 0.5 * motion.trebleEnergy),
      motion.sustain, dynamics.impact.energy];
  });
  const prefix = `/${crypto.randomUUID()}`;
  let encoder: FfmpegEncoder | undefined, browser: Awaited<ReturnType<typeof launchMilkdropChrome>> | undefined, received = 0, startedAt = 0;
  let writing = false;
  let origin = "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>MilkDrop export</title></head><body><script src="${prefix}/browser.js"></script></body></html>`;
  // A private ephemeral loopback server provides assets and bounds encoder
  // backpressure to one raw frame. No media leaves the local machine.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: width * height * 4 + 1024,
    idleTimeout: 120,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const requestOrigin = req.headers.get("origin");
      if (!path.startsWith(prefix + "/") || (requestOrigin && requestOrigin !== origin)) return new Response("Not found", { status: 404 });
      if (req.method === "POST" && path.startsWith(`${prefix}/frame/`)) {
        if (!encoder || writing || path !== `${prefix}/frame/${received}` || received >= totalFrames) return new Response("Unexpected frame", { status: 409 });
        writing = true;
        try {
          const frame = Buffer.from(await req.arrayBuffer());
          if (frame.length !== width * height * 4) return new Response("Incomplete RGBA frame", { status: 400 });
          backgroundContext.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.byteLength), width, height), 0, 0);
          const composite = renderer.render(analysis, request.start + received / fps, background);
          await encoder.write(composite);
          received++;
          onProgress?.({ frame: received, totalFrames, elapsedSeconds: (performance.now() - startedAt) / 1000 });
          return new Response(null, { status: 204 });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
        } finally { writing = false; }
      }
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (path === `${prefix}/index.html`) return new Response(html, { headers: { "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'" } });
      if (path === `${prefix}/browser.js`) return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (path === `${prefix}/pcm`) return new Response(pcm, { headers: { "Content-Type": "application/octet-stream" } });
      if (path === `${prefix}/cover.png` && cover) return new Response(cover, { headers: { "Content-Type": "image/png" } });
      return new Response("Not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    browser = await launchMilkdropChrome(executablePath, `${origin}${prefix}/index.html`);
    const job = { base: origin + prefix, width, height, fps, seed, start: request.start, totalFrames,
      sourceDuration: analysis.duration, ...plan, sampleRate: 44100, palette: palette.colors,
      lowFlash: request.config.visual.lowFlash, hasArtwork: Boolean(cover), intensity: request.config.visual.intensity,
      credit: promo ? { cx: (promoLayout.text.x + promoLayout.text.width / 2) / width, cy: 0.5, rx: 0.30, ry: 0.14 }
        : { cx: ellipse.x, cy: ellipse.y, rx: ellipse.rx, ry: ellipse.ry }, features };
    Object.assign(job, { hero: promo ? {
      cx: (promoLayout.cover.x + promoLayout.cover.size / 2) / width, cy: 0.5,
      rx: promoLayout.cover.size / width * 0.6, ry: promoLayout.cover.size / height * 0.6,
    } : { cx: layout.centerX / width, cy: layout.horizon / height,
      rx: layout.width / width * 0.48, ry: (layout.graphBottom - layout.graphTop) / height * 0.45 } });
    await browser.evaluate(`window.milkdrop.init(${JSON.stringify(job)})`);
    // GPU initialization and input validation finish before opening the output.
    encoder = await FfmpegEncoder.create({ audioPath: request.audioPath, outputPath: request.outputPath,
      config: request.config, start: request.start, duration,
      ...(request.fadeInSeconds === undefined ? {} : { fadeInSeconds: request.fadeInSeconds }),
      ...(request.fadeOutSeconds === undefined ? {} : { fadeOutSeconds: request.fadeOutSeconds }),
      frameCount: totalFrames, inputWidth: width, inputHeight: height, overwrite: request.overwrite });
    console.log(`MilkDrop ${plan.schedule.map(item => `${Math.max(0, (item.frame - plan.outputStartFrame) / fps).toFixed(1)}s ${item.preset}`).join(" → ")}`);
    if (selected.length) console.log(`Presets  ${selected.map(id => MILKDROP_PRESETS.find(preset => preset.id === id)!.name).join(" → ")}`);
    startedAt = performance.now();
    await browser.evaluate("window.milkdrop.renderAll()");
    if (received !== totalFrames) throw new Error(`MilkDrop produced ${received} of ${totalFrames} frames`);
    await encoder.finish();
    return { duration, frames: totalFrames, seed, renderWidth: width, renderHeight: height };
  } catch (error) {
    encoder?.abort();
    throw error;
  } finally {
    try { await browser?.close(); } finally { server.stop(true); }
  }
}
