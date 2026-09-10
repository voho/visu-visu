import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { smoothstep } from "../math/random.js";
import { sampleMaterial, type MaterialMap, type MaterialSample } from "./material.js";
import { shadeSurface, type LightingState, type Rgb } from "./lighting.js";
import type { SafeLayout } from "./layout.js";

/**
 * Low-resolution diffuse texture light underneath the sharp sculpture and
 * text. No-cover mode only: it lights the seeded material's bed, and it stays
 * because removing it moves the nebula frame by ~3 levels on average.
 */
export class MaterialLightLayer {
  private readonly canvas: Canvas;
  private readonly samples: MaterialSample[];
  private readonly masks: Float32Array;
  private readonly positions: Float32Array;
  private readonly creditBottom: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    material: MaterialMap,
    layout: SafeLayout,
  ) {
    this.creditBottom = layout.graphTop;
    const scale = Math.min(1, 192 / Math.max(width, height));
    const w = Math.max(24, Math.round(width * scale));
    const h = Math.max(24, Math.round(height * scale));
    this.canvas = createCanvas(w, h);
    this.masks = new Float32Array(w * h);
    this.positions = new Float32Array(w * h * 2);
    this.samples = Array.from({ length: w * h }, (_, index) => {
      const u = (index % w + 0.5) / w;
      const v = (Math.floor(index / w) + 0.5) / h;
      const x = (u - 0.5) * 2;
      const y = (0.5 - v) * 2;
      this.positions[index * 2] = x;
      this.positions[index * 2 + 1] = y;
      const textClear = smoothstep(layout.graphTop / height - 0.01, layout.graphTop / height + 0.065, v);
      const edges = 1 - smoothstep(0.65, 1.3, Math.hypot(x, y));
      this.masks[index] = textClear * edges * (1 - smoothstep(0.9, 1, v));
      return sampleMaterial(material, u * 1.8, v * 1.8);
    });
  }

  draw(output: SKRSContext2D, lights: LightingState, strength: number): void {
    if (!Number.isFinite(strength) || !(strength > 0)) return;
    strength = Math.min(1, strength);
    const context = this.canvas.getContext("2d");
    const image = context.createImageData(this.canvas.width, this.canvas.height);
    const rgb: Rgb = [0, 0, 0];
    for (let index = 0; index < this.samples.length; index += 1) {
      const sample = this.samples[index]!;
      if (this.masks[index]! <= 0 || sample.a <= 0) continue;
      shadeSurface(lights, this.positions[index * 2]!, this.positions[index * 2 + 1]!,
        (sample.height - 0.5) * 0.07, sample, rgb);
      const at = index * 4;
      image.data[at] = Math.round(Math.sqrt(rgb[0]) * 255);
      image.data[at + 1] = Math.round(Math.sqrt(rgb[1]) * 255);
      image.data[at + 2] = Math.round(Math.sqrt(rgb[2]) * 255);
      image.data[at + 3] = Math.round(255 * this.masks[index]! * sample.a * strength * 0.1);
    }
    context.putImageData(image, 0, 0);
    output.save();
    // Keep the credits quiet in final canvas space.
    output.beginPath();
    output.rect(0, this.creditBottom, this.width, this.height - this.creditBottom);
    output.clip();
    output.globalCompositeOperation = "screen";
    output.filter = "none";
    output.drawImage(this.canvas, 0, 0, this.width, this.height);
    output.restore();
  }
}
