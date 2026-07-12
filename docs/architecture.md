# Architecture

The first milestone is a deterministic batch renderer. A future local studio should orchestrate this core rather than create a second rendering path.

## Boundaries

### 1. Decode

[`src/audio/decode.ts`](../src/audio/decode.ts) asks FFmpeg for mono, 24 kHz, 32-bit floating-point PCM. Hashing decoded PCM means container metadata does not affect the automatic visual seed.

### 2. Analyze

[`src/audio/analyze.ts`](../src/audio/analyze.ts) calculates fixed-rate feature frames. A 2048-sample Hann window feeds an in-repository radix-2 FFT. Logarithmic frequency bands and track-wide percentile normalization turn source-dependent magnitudes into stable `0..1` control signals.

The analysis stage owns signal processing and temporal smoothing. The renderer only consumes normalized data.

### 3. Plan and render

[`src/render/renderer.ts`](../src/render/renderer.ts) constructs named seeded streams for fog, bokeh, and grain. Object properties are generated once. Positions are analytic functions of absolute time, so frame `n` is independent of frames `0..n-1`.

[`src/render/layout.ts`](../src/render/layout.ts) computes conservative landscape, square, and portrait safe rectangles. Full-bleed atmosphere ignores these bounds; typography and every graph coordinate are derived from them. Portrait and square profiles reserve additional bottom and right space for social-player captions, controls, and action rails.

The Canvas2D scene currently has these layers:

1. low-resolution rainbow fog and soft prismatic bokeh background;
2. exposure breathing and an atmospheric rainbow horizon;
3. mirrored spectral ribbon and frequency-colored spectrum strokes;
4. present and delayed rainbow waveform lines;
5. frequency-colored onset bloom, vignette, and seeded grain;
6. title and artist typography, rendered last for stable legibility.

[`src/render/layout.ts`](../src/render/layout.ts) defines the shared platform-safe rectangle. Landscape layouts reserve top and bottom player chrome; portrait and square layouts additionally shift the content center left and reserve a right action rail. Spectrum, waveform, title, artist, horizon, and onset bloom all consume this one layout, preventing individual layers from drifting back into UI overlays. Long title and artist strings are measured and uniformly reduced to fit inside the safe width.

### 4. Encode

[`src/render/encoder.ts`](../src/render/encoder.ts) streams raw RGBA frames to FFmpeg with backpressure. FFmpeg encodes H.264 video, seeks the original source audio to the same start time, encodes stereo AAC-LC at 48 kHz with a 384 kbps target, and muxes an MP4 with fast-start metadata.

Audio is normalized to a platform-oriented delivery profile: AAC-LC, stereo, 48 kHz, and 384 kbps. The source audio is always mapped explicitly, and integration tests probe the finished stream to prevent silent-video regressions.

Requested durations are converted to a whole frame count once, before rendering and encoding. The reported duration, FFmpeg limit, and video frame count therefore share one value. Source-file hash verification lives in the render core, so library callers receive the same cache/audio mismatch protection as the CLI.

The renderer normally works at half the requested width and height. FFmpeg performs one Lanczos scale to the final output dimensions before H.264 encoding. Soft atmospheric layers therefore avoid expensive full-size blur filters, while `output.renderScale = 1` remains available for native-resolution output.

## Reproducibility contract

A render plan is identified by:

- decoded PCM hash;
- explicit or automatically derived seed;
- analysis and renderer versions;
- output dimensions and frame rate;
- project visual settings;
- absolute frame time.

Composition and motion are reproducible. Pixel-identical output is guaranteed within the same pinned native runtime; fonts and codecs may vary slightly across platforms until the project bundles a font and containerizes the render toolchain.

## Intended next milestones

1. A local browser studio for drag/drop audio, seekable preview, seed exploration, and config editing.
2. A worker-thread analysis path with a compact binary cache for very long tracks.
3. Scene/section detection and smoothly interpolated visual chapters.
4. Optional WebGL layers and motion-blur supersampling while retaining the same analysis/config contract.
5. A bundled open font and golden-frame fixtures for stronger cross-machine reproducibility.
