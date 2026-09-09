# Flowing silk material

The renderer uses a restrained silk/mineral relief with colored, moving lights. This directory contains actual matching maps, not decorative stand-ins:

| File | Purpose |
| --- | --- |
| `silk-height-source.png` | Original AI-generated grayscale relief source, with embedded provenance preserved. |
| `silk-height.png` | Periodic 512 × 512 scalar height after processing. |
| `silk-albedo.png` | Neutral pearl base color derived from the same height. |
| `silk-normal.png` | Tangent-space normals from central height gradients. |
| `silk-roughness.png` | Roughness derived from height and slope. |
| `silk-height.ts` | Area-averaged 128 × 128 height bytes for synchronous runtime loading. |
| `material.json` | Resolution, seed, map names, and normal convention. |

The source was generated with OpenAI image generation for this project on 2026-09-09. The prompt requested a tileable grayscale height source with shallow organic flowing silk/mineral ridges and fine striations, with no objects, lettering, or baked lighting. The original image is a height *design*, not a measured physical surface. The complete [source prompt and generation record](./source-prompt.md) is included beside the maps.

The generated image is not assumed to be seamless. A cosine feather joins its relief to deterministic periodic harmonics at every boundary, preserving a continuous repeating surface. All downstream maps come from this one scalar field. Normals use **+X right, +Y up, +Z toward the viewer**, encoded as `RGB = normal × 0.5 + 0.5`; use the green channel unchanged with an OpenGL normal convention. Normal and roughness textures are data, not sRGB colors. Normalize sampled normals after interpolation.

Regenerate from the committed source:

```sh
bun run materials
```

The command deterministically writes the four PNGs, packed height source, and metadata. It preserves the original source image. Optional `--source`, `--out-dir`, `--size 128..2048`, and `--seed` flags select another local source, output location, resolution, or seed. `--procedural` creates a source-independent harmonic material. The bundled dimensions are 512²; runtime materials are capped at 256² and default to 128² to keep per-frame sampling inexpensive.

Runtime construction performs no image decoding or file reads. A seed selects a stable placement in the bundled height field. `createProceduralHeight` provides an independent deterministic fallback. Cover artwork can also supply a soft artistic relief through `createMaterialFromRgba`: it blurs alpha-weighted luminance once, preserves the original color and transparency, clamps at image boundaries, and uses lower normal strength and higher roughness. That cover relief is not physical depth estimation.

The scene recolors procedural albedo with `recolorMaterial` using colors extracted from the full cover, or a seeded random palette when no cover is supplied. Height, normals and roughness retain their detail. The same palette supplies the moving lights, so the bundled albedo's original pigment cannot introduce unrelated colors into an artwork-based scene. Normal-map inspection still shows diagnostic RGB directions.

When a cover is present, the object itself uses the complete photograph as its texture, with separate luminance-derived normal and roughness maps. This object material has no background crop, vignette or credit mask. Mirrored UVs keep the image attached across the closed surface, and neutral diffuse illumination preserves its actual pigment while palette-colored reflections respond to music. The procedural material remains available for the surrounding atmosphere and for songs without artwork.
