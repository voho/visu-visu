import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { createRandom, deriveSeed, lerp, smoothstep } from "../math/random.js";
import type { AudioAnalysis } from "../types.js";
import { cloudEventsAt } from "./frozen-cloud.js";
import type { SafeLayout } from "./layout.js";

interface Snapshot {
  canvas: Canvas;
  noise: Float32Array;
}

/** Small, immutable sculpture captures; only their optical treatment ages. */
export class FrozenCloudLayer {
  private readonly snapshots = new Map<number, Snapshot>();
  private analysis: AudioAnalysis | undefined;
  private readonly scratch: Canvas;
  private readonly composite: Canvas;
  private readonly mask = createCanvas(80, 80);
  private readonly smallWidth: number;
  private readonly smallHeight: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly layout: SafeLayout,
    private readonly seed: string,
  ) {
    this.smallWidth = Math.max(64, Math.round(width / 4));
    this.smallHeight = Math.max(40, Math.round(height / 4));
    this.scratch = createCanvas(this.smallWidth, this.smallHeight);
    this.composite = createCanvas(this.smallWidth, this.smallHeight);
  }

  draw(
    output: SKRSContext2D,
    analysis: AudioAnalysis,
    time: number,
    capture: (context: SKRSContext2D, captureTime: number) => void,
  ): void {
    if (this.analysis !== analysis) {
      this.snapshots.clear();
      this.analysis = analysis;
    }
    const events = cloudEventsAt(analysis, time);
    const active = new Set(events.map((event) => event.id));
    for (const id of this.snapshots.keys()) if (!active.has(id)) this.snapshots.delete(id);
    if (!events.length) return;
    const layer = this.composite.getContext("2d");
    layer.clearRect(0, 0, this.smallWidth, this.smallHeight);
    const scratch = this.scratch.getContext("2d");
    const mask = this.mask.getContext("2d");
    const scaleX = this.smallWidth / this.width;
    const scaleY = this.smallHeight / this.height;
    const radius = Math.min(this.layout.width / 2,
      this.layout.horizon - this.layout.graphTop,
      this.layout.graphBottom - this.layout.horizon);

    for (const event of events) {
      let snapshot = this.snapshots.get(event.id);
      if (!snapshot) {
        const canvas = createCanvas(this.smallWidth, this.smallHeight);
        const context = canvas.getContext("2d");
        context.scale(scaleX, scaleY);
        capture(context, event.captureTime);
        snapshot = { canvas, noise: this.createNoise(event.id) };
        this.snapshots.set(event.id, snapshot);
      }
      // Smooth spatial erosion opens patches in the frozen contour. The noise
      // never scrolls or changes seed, so the captured form truly stays still.
      const pixels = mask.createImageData(80, 80);
      const threshold = event.dissolve * 0.86 - 0.12;
      for (let index = 0; index < snapshot.noise.length; index += 1) {
        pixels.data[index * 4 + 3] = Math.round(255 * smoothstep(
          threshold, threshold + 0.2, snapshot.noise[index]!,
        ));
      }
      mask.putImageData(pixels, 0, 0);
      scratch.clearRect(0, 0, this.smallWidth, this.smallHeight);
      scratch.drawImage(snapshot.canvas, 0, 0);
      scratch.save();
      scratch.globalCompositeOperation = "destination-in";
      scratch.drawImage(this.mask, 0, 0, this.smallWidth, this.smallHeight);
      scratch.restore();

      layer.save();
      layer.globalCompositeOperation = "screen";
      layer.globalAlpha = event.opacity;
      layer.filter = `blur(${Math.max(0.6, event.blur * radius * scaleX)}px)`;
      const centerX = this.layout.centerX * scaleX;
      const centerY = this.layout.horizon * scaleY;
      layer.translate(centerX, centerY);
      layer.scale(event.scale, event.scale);
      layer.drawImage(this.scratch, -centerX, -centerY);
      layer.restore();
    }

    // Fog can spread beyond the graph, but fades away before the credits.
    layer.save();
    layer.globalCompositeOperation = "destination-in";
    const protection = layer.createLinearGradient(0, 0, 0, this.smallHeight);
    protection.addColorStop(0, "transparent");
    protection.addColorStop(this.layout.graphTop / this.height - 0.025, "transparent");
    protection.addColorStop(this.layout.graphTop / this.height + 0.06, "white");
    protection.addColorStop(0.85, "white");
    protection.addColorStop(1, "transparent");
    layer.fillStyle = protection;
    layer.fillRect(0, 0, this.smallWidth, this.smallHeight);
    layer.restore();
    output.save();
    output.globalCompositeOperation = "screen";
    output.drawImage(this.composite, 0, 0, this.width, this.height);
    output.restore();
  }

  private createNoise(id: number): Float32Array {
    const random = createRandom(deriveSeed(this.seed, `frozen-cloud:${id}`));
    const coarse = Float32Array.from({ length: 81 }, () => random());
    const fine = Float32Array.from({ length: 289 }, () => random());
    const sample = (grid: Float32Array, side: number, x: number, y: number): number => {
      const u = x * (side - 1), v = y * (side - 1);
      const ix = Math.floor(u), iy = Math.floor(v);
      const fx = smoothstep(0, 1, u - ix), fy = smoothstep(0, 1, v - iy);
      const at = (dx: number, dy: number): number => grid[Math.min(side - 1, iy + dy) * side + Math.min(side - 1, ix + dx)]!;
      return lerp(lerp(at(0, 0), at(1, 0), fx), lerp(at(0, 1), at(1, 1), fx), fy);
    };
    return Float32Array.from({ length: 6400 }, (_, index) => {
      const x = (index % 80) / 79, y = Math.floor(index / 80) / 79;
      return sample(coarse, 9, x, y) * 0.7 + sample(fine, 17, x, y) * 0.3;
    });
  }
}
