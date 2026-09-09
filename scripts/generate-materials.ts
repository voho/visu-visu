import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createMaterialFromHeight, createProceduralHeight } from "../src/render/material.js";

const commandArgs = process.argv.slice(2);
const args = commandArgs[0] === "--" ? commandArgs.slice(1) : commandArgs;
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}
if (args.includes("--help")) {
  console.log("Generate coherent, repeatable silk maps from a local grayscale relief source.\n\nbun scripts/generate-materials.ts [--source image.png] [--out-dir assets/materials] [--size 512] [--seed silk-v1]\n\nOutputs silk-albedo.png, silk-height.png, silk-normal.png, silk-roughness.png, and a packed 128² runtime source silk-height.ts. --procedural generates without an input image.");
  process.exit(0);
}
for (let index = 0; index < args.length; index += 1) {
  const name = args[index]!;
  if (name === "--procedural") continue;
  if (!["--source", "--out-dir", "--size", "--seed"].includes(name)) throw new Error(`Unknown material option: ${name}`);
  index += 1;
}
const sourcePath = resolve(option("--source", "assets/materials/silk-height-source.png"));
const outputPath = resolve(option("--out-dir", "assets/materials"));
const size = Number(option("--size", "512"));
const seed = option("--seed", "silk-v1");
if (!Number.isInteger(size) || size < 128 || size > 2048) throw new Error("--size must be an integer from 128 to 2048");
const heights = createProceduralHeight(seed, size);
if (!args.includes("--procedural")) {
  await access(sourcePath);
  // An explicit existing local path lets the decoder recognize PNG before
  // inspecting AI provenance metadata (which may itself contain SVG text).
  const source = await loadImage(sourcePath);
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.filter = "blur(0.65px)";
  context.drawImage(source, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  // The AI source is not assumed to tile. A cosine window joins it to a
  // genuinely periodic low-frequency field with zero slope at the boundary.
  const feather = (position: number): number => {
    const distance = Math.min(position, 1 - position);
    const t = Math.min(1, distance / 0.14);
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const luminance = (pixels[index * 4]! * 0.2126 + pixels[index * 4 + 1]! * 0.7152 + pixels[index * 4 + 2]! * 0.0722) / 255;
      const weight = feather(x / size) * feather(y / size) * 0.87;
      heights[index] = heights[index]! * (1 - weight) + luminance * weight;
    }
  }
}
const material = createMaterialFromHeight(heights, size, size);
await mkdir(outputPath, { recursive: true });
async function png(name: string, writePixel: (data: Uint8ClampedArray, index: number) => void): Promise<void> {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(size, size);
  for (let index = 0; index < size * size; index += 1) {
    writePixel(pixels.data, index);
    pixels.data[index * 4 + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  await writeFile(join(outputPath, name), canvas.toBuffer("image/png"));
}
await png("silk-albedo.png", (data, index) => {
  for (let channel = 0; channel < 3; channel += 1) data[index * 4 + channel] = material.albedo[index * 4 + channel]!;
});
await png("silk-height.png", (data, index) => {
  data[index * 4] = data[index * 4 + 1] = data[index * 4 + 2] = material.heightMap[index]! * 255;
});
await png("silk-normal.png", (data, index) => {
  for (let channel = 0; channel < 3; channel += 1) data[index * 4 + channel] = (material.normals[index * 3 + channel]! * 0.5 + 0.5) * 255;
});
await png("silk-roughness.png", (data, index) => {
  data[index * 4] = data[index * 4 + 1] = data[index * 4 + 2] = material.roughness[index]! * 255;
});
// Area-average the same scalar field before quantizing: the runtime does not
// import unrelated normals or a resized bitmap with a different relief source.
const packedSize = 128;
const packed: number[] = [];
for (let y = 0; y < packedSize; y += 1) {
  for (let x = 0; x < packedSize; x += 1) {
    const x0 = Math.floor(x * size / packedSize);
    const x1 = Math.max(x0 + 1, Math.floor((x + 1) * size / packedSize));
    const y0 = Math.floor(y * size / packedSize);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * size / packedSize));
    let sum = 0;
    for (let sy = y0; sy < y1; sy += 1) {
      for (let sx = x0; sx < x1; sx += 1) sum += material.heightMap[sy * size + sx]!;
    }
    packed.push(Math.round(sum / ((x1 - x0) * (y1 - y0)) * 255));
  }
}
const rows: string[] = [];
for (let index = 0; index < packed.length; index += 128) rows.push(`  ${packed.slice(index, index + 128).join(",")},`);
await writeFile(join(outputPath, "silk-height.ts"), `// Generated by scripts/generate-materials.ts; do not edit by hand.\nexport const silkHeightSize = ${packedSize};\nexport const silkHeightBytes: readonly number[] = [\n${rows.join("\n")}\n];\n`);
await writeFile(join(outputPath, "material.json"), `${JSON.stringify({
  name: "Flowing silk relief", version: 1, size, packedSize, seed,
  source: args.includes("--procedural") ? "deterministic periodic harmonics" : "silk-height-source.png (AI-generated grayscale relief)",
  normalConvention: "+X right, +Y up, +Z toward viewer; RGB = normal * 0.5 + 0.5",
  normalStrength: 0.1, wrap: "repeat", maps: { albedo: "silk-albedo.png", height: "silk-height.png", normal: "silk-normal.png", roughness: "silk-roughness.png" },
}, null, 2)}\n`);
console.log(`Generated ${size}×${size} albedo, height, normal, and roughness maps plus a ${packedSize}×${packedSize} runtime source in ${outputPath}`);
