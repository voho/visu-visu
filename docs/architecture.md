# Architecture

The first milestone is a deterministic batch renderer. A future local studio should orchestrate this core rather than create a second rendering path.

## Boundaries

### 1. Decode

[`src/audio/decode.ts`](../src/audio/decode.ts) asks FFmpeg for mono, 24 kHz, 32-bit floating-point PCM. Hashing decoded PCM means container metadata does not affect the automatic visual seed.

### 2. Analyze

[`src/audio/analyze.ts`](../src/audio/analyze.ts) calculates fixed-rate feature frames. A 2048-sample Hann window feeds an in-repository radix-2 FFT. Logarithmic frequency bands and track-wide percentile normalization turn source-dependent magnitudes into stable `0..1` control signals.

The analysis stage owns signal processing and temporal smoothing. The renderer only consumes normalized data.

### 3. Plan and render

[`src/render/renderer.ts`](../src/render/renderer.ts) constructs named seeded streams for fog, bokeh, aurora, sparkles, onset prism events, and grain. Object properties are generated once or derived from an event's stable analysis-frame index. Positions are analytic functions of absolute time, so frame `n` is independent of frames `0..n-1`.

[`src/render/conductor.ts`](../src/render/conductor.ts) turns rolling energy, onset activity, build/drop trend, beat impulses, and a slow structural chapter weight into continuous ambient, drive, peak, form, and motion controls. It uses bounded fixed analysis windows, including deterministic look-ahead, rather than mutable playback state. Those controls crossfade and choreograph existing layers across musical sections instead of leaving every effect equally prominent for the whole track.

[`src/render/layout.ts`](../src/render/layout.ts) computes conservative landscape, square, and portrait safe rectangles. Full-bleed atmosphere ignores these bounds; typography and every graph coordinate are derived from them. Portrait and square profiles reserve additional bottom and right space for social-player captions, controls, and action rails.

The Canvas2D scene currently has these layers:

1. low-resolution rainbow fog, soft prismatic bokeh, and flowing spectral auroras;
2. exposure breathing, atmospheric horizon, treble-reactive sparkles, and camera parallax;
3. beat-triggered shockwaves and onset-seeded curved prism streaks;
4. a conductor-weighted spectral halo and genuinely advancing depth tunnel;
5. mirrored spectral ribbon, frequency-colored strokes, and a morphing orbital waveform;
6. present and delayed rainbow waveform lines with section-dependent trail energy;
7. frequency-colored onset bloom, vignette, and lower-cadence seeded grain;
8. title and artist typography, rendered last for stable legibility.

[`src/render/layout.ts`](../src/render/layout.ts) defines the shared platform-safe rectangle. Landscape layouts reserve top and bottom player chrome; portrait and square layouts additionally shift the content center left and reserve a right action rail. Spectrum, waveform, title, artist, horizon, and onset bloom all consume this one layout, preventing individual layers from drifting back into UI overlays. Long title and artist strings are measured and uniformly reduced to fit inside the safe width.

### 4. Encode

[`src/render/encoder.ts`](../src/render/encoder.ts) streams raw RGBA frames to FFmpeg with backpressure. FFmpeg applies the Lanczos delivery filter (a spatial resize only when internal and delivery dimensions differ), encodes H.264 High-profile video with BT.709 metadata, two B-frames, four references, and a fixed closed GOP, seeks the original source audio to the same start time, encodes stereo AAC-LC at 48 kHz with a 384 kbps target, and muxes an MP4 with fast-start metadata.

Audio is normalized to a platform-oriented delivery profile: AAC-LC, stereo, 48 kHz, and 384 kbps. The source audio is always mapped explicitly, and integration tests probe the finished stream to prevent silent-video regressions.

Requested durations are converted to a whole frame count once, before rendering and encoding. The reported duration, FFmpeg limit, and video frame count therefore share one value. Source-file hash verification lives in the render core, so library callers receive the same cache/audio mismatch protection as the CLI.

Final renders work at 100% of the requested width and height, CRF 8, and the `slow` H.264 preset. A default Full HD job therefore draws at `1920×1080` and reaches encoding without an upscale. This is a near-transparent upload master, not a mathematically lossless codec path. Preview quality uses half scale, CRF 20, and `veryfast` encoding while retaining the requested delivery dimensions.

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
3. Deeper song-structure detection and named, editable visual chapters beyond the current rolling conductor.
4. Optional WebGL layers and motion-blur supersampling while retaining the same analysis/config contract.
5. A bundled open font and golden-frame fixtures for stronger cross-machine reproducibility.
