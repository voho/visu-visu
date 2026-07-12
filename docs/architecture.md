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

The Canvas2D scene currently has these layers:

1. quarter-resolution fog and soft bokeh background;
2. exposure breathing and an atmospheric horizon;
3. mirrored spectral ribbon and fine spectrum strokes;
4. present and delayed waveform lines;
5. title, artist, seed, and time typography;
6. onset exposure accent, vignette, and seeded grain.

### 4. Encode

[`src/render/encoder.ts`](../src/render/encoder.ts) streams raw RGBA frames to FFmpeg with backpressure. FFmpeg encodes H.264 video, seeks the original source audio to the same start time, encodes AAC, and muxes an MP4 with fast-start metadata.

Requested durations are converted to a whole frame count once, before rendering and encoding. The reported duration, FFmpeg limit, and video frame count therefore share one value. Source-file hash verification lives in the render core, so library callers receive the same cache/audio mismatch protection as the CLI.

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
