# visu-visu

`visu-visu` turns a song into a deterministic, audio-reactive music video. It analyzes the full track first, then renders every video frame from absolute time, cached features, and a seeded visual plan.

The initial preset is **Resonance**: a sculpture of 72 harmonic filaments that opens into a ring, closes toward an orb and folds into a flowing plasma knot. Broad 3D precession, flower-like lobes and changing proportions make its silhouette move with the song. Bass and kicks drive the largest folds and camera pulses; mids shape slower flow; high frequencies add smaller, faster ripples. Fast orbiters, contour tracers and glints move against 640 slowly drifting stars, faint orbital ribbon echoes and a soft nebula. Music moves through the scene's palette, changing saturation and bloom, with brief light separation around transients.

Kick-driven supernovas add a local flash, diffraction flares, outward particles and an expanding shockfront that leaves a decaying afterglow. High-frequency hits create smaller, faster flares. The bursts use separate attack and decay times, so sharp accents coexist with slower light trails and continuous sculpture motion. Low-flash mode softens their light while preserving the event timing, expanding geometry and musical movement.

Occasional bass accents also leave a frozen ghost of the sculpture behind the live geometry. Its shape, texture, lighting and camera remain fixed while it gently approaches the viewer, growing to about twice its original size. Each ghost stays recognizable for its first second, then softens and dissolves over 7.5 seconds into a faint cloud. Up to three overlapping impressions add depth while leaving the live sculpture and credits clear. Both exported videos and the live WebGL preview include this object history.

A translucent flowing-silk skin follows the same morphing sculpture as its filaments, using matching texture, normal and roughness maps. The spectrum also becomes a moving band of colored light: surface normals bend its reflections around the sculpture, and roughness softens its highlights. Spectrum and oscilloscope signals shape the relief and fine detail, connecting material, geometry and music. Three moving colored lights add depth: bass drives the broadest, strongest light, mids provide a slower fill, and treble contributes a smaller, quicker rim. Cover art remains recognizable behind the scene, with a deeply darkened region behind the title and artist.

Six independent music responses give the scene different kinds of momentum: slow atmosphere builds and lingers, the sculpture and depth particles follow bass, fine details move with mids, and smaller sparks answer the highs. Soft cloud layers, a contact shadow, local diffraction flares and faint expanding pulses add depth around the material. Each layer has its own continuous motion clock and decay, so quick accents coexist with slower drifting detail while the cover and credits remain readable.

The deterministic conductor compares each section with the track's own energy range, then hands the scene between ambient, build, peak and release modes. Quiet passages leave space around the sculpture; builds add depth and camera motion; peaks increase deformation and light; releases soften the scene. Every layer is derived from absolute time, cached analysis and seeded plans, so the result remains reproducible. Large, high-contrast title and artist typography uses restrained letter spacing and aspect-aware safe zones for TikTok, Instagram, YouTube and Vimeo players.

Title and artist are centered horizontally in the full frame, with their own symmetric text bounds. The sculpture uses a separate safe composition: landscape output reserves the hover-title and player-control bands; square and portrait output also reserve additional bottom space for captions and right-side space for TikTok/Reels action controls.

Every MP4 contains the song as stereo AAC-LC at 48 kHz with a 384 kbps target bitrate.

Picture and audio fade in together from black and silence over the first three seconds, then fade back to black and silence over the final three seconds. The fades happen inside the existing runtime; they do not add silent lead-in or tail time. Outputs shorter than six seconds divide their available duration evenly between the two ramps. Set `--fade 0` to disable them or `--fade <seconds>` to choose another duration.

Final renders default to native **1920×1080 at 60 fps**, encoded as H.264 High Profile at CRF 18 with the `fast` preset, a 16 Mbps video ceiling and a 32 Mbit buffer. MP4 faststart, yuv420p pixels, BT.709 color, two B-frames and a closed half-second GOP provide an upload format with controlled file size. The 16 Mbps ceiling is this project's quality choice; [YouTube's recommended upload settings](https://support.google.com/youtube/answer/1722171) give 12 Mbps as the 1080p high-frame-rate reference. Use `--quality master` for an optional CRF 8, `slow`, uncapped archive copy.

## Showcase

[![Resonance generated from the loop fixture](./docs/showcase-loop.png)](./test-e2e/loop.mp4)

[Watch the generated Full HD60 MP4](./test-e2e/loop.mp4) · [Source WAV fixture](./test-e2e/loop.wav)

Regenerate the committed native 1920×1080, 60 fps showcase with `bun run showcase:loop`. Run `bun run showcase:portrait` for a 1080×1920, 60 fps version in `renders/resonance-portrait-60.mp4`. Both display **RESONANCE** and **VISU VISU**. The six-second fixture uses short 0.5-second edge fades so its visuals remain useful as a demo; normal renders retain the three-second production default.

## Quick start

Requirements:

- [Bun](https://bun.sh/) 1.3 or newer
- `ffmpeg` and `ffprobe` on `PATH`, with H.264 (`libx264`) and AAC support

Install and render:

```sh
bun install
bun run render -- ./song.mp3 \
  --title "Night Signal" \
  --artist "Artist Name" \
  --output ./renders/night-signal.mp4
```

The default is native Full HD at 60 fps with the compact upload profile. Choose landscape for YouTube or portrait for TikTok:

```sh
bun run render -- ./song.mp3 --size 1920x1080 --fps 60 --quality final --output ./renders/youtube.mp4
bun run render -- ./song.mp3 --size 1080x1920 --fps 60 --quality final --output ./renders/tiktok.mp4
```

For a quick, eight-second draft:

```sh
bun run preview -- ./song.mp3 --overwrite
```

The preview script still writes a `1920×1080` delivery file, but renders its Canvas scene at half scale and uses a faster quality profile. Set `--start 45` to inspect a later section.

## Input artwork

Pass a local PNG, JPEG, WebP or AVIF image to supply the scene's colors and artwork background:

```sh
bun run render -- ./song.wav --image ./cover.jpg \
  --title "Night Signal" --artist "Artist Name" \
  --output ./renders/night-signal.mp4

bun run clip -- ./song.wav --image ./cover.jpg --artist "Artist Name"
```

The image retains visible color and recognizable detail across the scene, with gentle softening and controlled contrast. A deeply darkened, feathered band behind the title and artist keeps the credits readable, while a lighter mask lets the cover remain visible through and around the sculpture. A separate image vignette fades the corners into the background. Slow breathing combines with a small, bass-triggered zoom of up to 1.2%, giving the image a restrained beat response without flashing its opacity.

The artwork also supplies a soft normal map from blurred, alpha-weighted luminance. This is an artistic relief, not physical depth estimation. Moving lights reveal restrained surface detail while preserving the cover colors, transparency, credit mask and vignette. The lighting layer leaves room around the credits and the sculpture.

The complete image supplies one shared palette before it is cropped for the output aspect ratio. The sculpture, material, spectrum lights, flares, particles, clouds, shadows and credit tint all use those source colors or neutral shades. Music changes their balance, brightness and saturation within that palette. A monochrome cover produces a monochrome visualization; a cover with one hue keeps that hue throughout the scene. The artwork's own color treatment stays restrained and preserves its hues. Transparent pixels do not contribute colors, and the source file is not modified.

Without artwork, the renderer creates a varied palette from the visual seed. Reusing the same seed repeats its colors; choosing another seed explores a different palette. The illuminated WebGL preview follows the same palette policy as exported videos.

Use `visual.imagePath` to store the image in a project config. Relative paths in that field resolve beside the config file; relative `--image` paths resolve from the current working directory and override the config value. Leave `imagePath` empty to use the procedural atmosphere alone. SVG and image URLs are not supported. Reproducible artwork renders require the same image bytes as well as the same audio and visual settings.

## Textures and reactive lighting

The committed [material assets](./assets/materials/README.md) include a 512 × 512 albedo texture, height map, tangent-space normal map and roughness map. They come from one AI-generated grayscale relief source, processed into a seamless repeating surface. Runtime material color follows the scene palette while retaining the surface detail. The normal map changes how moving lights meet the surface; roughness controls the width of its highlights. The analyzed spectrum also illuminates the surface as a reflected band of palette colors. Its appearance follows each surface normal and the viewing direction; rougher areas spread the highlight. Low frequencies produce broader, stronger light, while high frequencies contribute narrower detail. Spectrum and signed waveform signals also perturb relief and shape fine reflections across the material skin. A packed 128 × 128 height field keeps runtime construction synchronous and inexpensive.

Lighting defaults to `0.65`. Use `--lighting 0..1` on `render` or `clip`, or set `visual.lighting` in your config:

```sh
bun run render -- ./song.wav --image ./cover.png --lighting 0.8
bun run clip -- ./song.wav --artist "Artist Name" --lighting 0.45
```

`--lighting 0` disables this material lighting. The three point lights and reflected spectrum follow absolute musical time and frequency envelopes, so direct seeks recreate the same light positions and highlights. Low-flash mode reduces fast light accents while retaining their motion. Large, centered title and artist text is drawn after lighting and remains unaffected by it.

Regenerate all maps deterministically from the committed source:

```sh
bun run materials
# Optional: generate a separate procedural material without an image source.
bun run materials -- --procedural --out-dir ./renders/procedural-material
```

See the [material notes](./assets/materials/README.md) for source provenance, map conventions and custom source options. Regeneration preserves the source image.

## Live visualization preview

Explore the flowing sculpture, material maps and music-driven lights with a local WebGL preview:

```sh
bun run lighting:preview -- ./song.wav --image ./cover.png \
  --title "Night Signal" --artist "Artist Name" --low-flash
```

Open the printed local address, normally `http://127.0.0.1:4180`. Play or seek the song to explore a folded ring that opens, closes and bends into a knot, combining a translucent normal-mapped skin with luminous filaments and traveling tracers. Bass accents leave frozen ghosts that approach the viewer and dissolve into mist behind the moving object. Slowly warped clouds, several particle depths, a soft shadow and local flare pulses surround the sculpture, with subtle camera and cover drift, beat zoom and gradual changes within the cover's palette. The spectrum itself lights the folds through their surface normals, while spectrum and oscilloscope signals also shape the sculpture and sharper accents. Switch between **Illuminated**, **Texture**, **Normal map** and **Roughness** views to inspect the same moving geometry; the normal-map view uses diagnostic RGB to show direction. The page draws at the browser's refresh cadence and reports its measured frame rate. Use `--port` to choose a different local port and `--seed` for repeatable light placement and a repeatable palette when no cover is supplied.

The WebGL preview combines the visualizer's flowing geometry with the material, lighting and frozen-history effects. Its GPU mesh uses 64 filaments with 192 segments each; exported videos use the offline 72-filament Canvas scene and full export composition. Use `render` or `clip` to create MP4s. The preview and export share musical signals, ghost capture timing and fade curves, with different mesh densities and drawing paths rather than pixel-identical frames. Audio and optional artwork are served locally; the server binds to `127.0.0.1`.

## Smoke renders

For a quick smoke test, one command writes a 640×360 draft with the fixture's short 0.5-second fades to the ignored root-level `loop.mp4`:

```sh
bun run test:loop
```

Use `bun run showcase:loop` when intentionally refreshing the committed Full HD60 showcase, or `bun run showcase:portrait` to generate the vertical version.

For a quick portrait clip smoke render using the real audio fixture:

```sh
bun run test:clip
```

This writes the ignored root-level `clip.mp4` with large **RESONANCE** and **VISU VISU** credits. The fixture is about six seconds long, so the clip uses the whole song with a quick intro and a three-second fade-out. Delivery remains 1080×1920 at 60 fps; preview encoding and a quarter-scale Canvas render keep this smoke test quick.

## Automatic portrait clips

The separate `clip` command selects a highlight and creates a portrait **1080×1920, 60 fps MP4**, using the same music-reactive renderer and upload encoding:

```sh
bun run clip -- ./song.mp3 --title "Night Signal" --artist "Artist Name"
```

By default it looks for a strong, sustained bass-heavy drop, starts about **five seconds before it**, and renders **up to 30 seconds**. The entrance fades in over 0.35 seconds; picture and audio fade out together over the final three seconds. Short artist names remain about 20 px high in a 360-pixel-wide portrait preview. Both credit lines are centered in the full frame, above the visualization.

A loud isolated hit does not count as a drop: selection combines the immediate energy jump, contrast with the preceding section, and sustained energy after the hit. If no distinct drop is found, the command chooses the strongest sustained-energy window instead. This is an audio-feature heuristic; use `--dry-run` to inspect its choice or `--drop` for a known musical timestamp:

```sh
# Read the selected source range, drop offset, effective fades and output profile.
bun run clip -- ./song.mp3 --artist "Artist Name" --dry-run

# Known drop at 1:32.5: start at 1:27.5, with the drop five seconds into the clip.
bun run clip -- ./song.mp3 --artist "Artist Name" --drop 92.5 --output ./renders/short.mp4

# A shorter excerpt, with a different lead-in and end fade.
bun run clip -- ./song.mp3 --artist "Artist Name" --duration 20 --lead-in 4 --fade-out 2
```

Title and artist come from `--title` / `--artist`, then project text settings, then audio tags. A missing title falls back to the filename; if the artist is still missing, the command asks for `--artist` instead of exporting an uncredited clip. Both lines use the existing large, high-contrast typography.

Default output is `<song>.clip.mp4`. Use `--overwrite` to replace an existing file. Clips always use 9:16; `--resolution`, `--fps`, `--render-scale`, `--quality`, `--seed`, `--image`, `--lighting`, `--config`, `--analysis` and `--save-analysis` remain available. The clip profile defaults to Full HD60 and `final` encoding even when the project config uses landscape dimensions or another frame rate. A reused analysis must match the selected frame rate and source file.

A source shorter than the requested clip is used in full. Drops near the beginning get the available lead-in; drops near the end keep the requested lead-in and produce a shorter excerpt. Sources are never looped to fill time. Fades shorten when necessary to keep the chosen drop at full volume, with a brief hold before the end fade. Very short excerpts proportionally fit the entrance and exit fades without overlap. Normal clip durations round down to complete frames; a fractional final source frame can add less than one frame of padded delivery time, reported separately as `renderedDuration` in dry-run JSON. `--duration` accepts at most 30 seconds; omitted lead-in becomes half the duration for clips shorter than ten seconds.

## Deterministic two-stage processing

Analysis is an explicit, reusable artifact:

```sh
bun run analyze -- ./song.flac --output ./song.analysis.json

bun run render -- ./song.flac \
  --analysis ./song.analysis.json \
  --seed charcoal-17 \
  --output ./renders/song.mp4
```

The analysis contains time-indexed RMS, peak, a log-frequency spectrum, bass/mid/treble energy, spectral centroid, spectral flux, onset strength, and waveform samples. Track-level percentiles normalize these values before rendering. RMS attack and release use elapsed time so their response stays consistent across frame rates. Rhythm and beat controls use time-based onset envelopes; a flat onset peak fires once at its leading edge. Separate normalized band envelopes and integrated slow/fast musical time let sustained forms and rapid details respond at different speeds without jumping when the song's energy changes. Supernovas and flares have a cached event plan built from positive frequency-band changes: an event never precedes its audio timestamp, and its expansion and decay depend only on its absolute age.

Cached analysis is bound to the exact source file as well as its decoded PCM. The current analysis version remains **2**; regenerate older versions with `bun run analyze`. A cache must also match the output frame rate, so regenerate a 24 or 30 fps cache for a 60 fps render. The renderer rejects a cache paired with another audio file, malformed feature values, unsupported versions, or inconsistent frame counts. JSON caches are capped at 128 MiB; longer-form sets should currently be analyzed as part of the render instead of saved.

With the same decoded audio, input image bytes (if supplied), bundled material source, settings, seed, renderer version, and runtime environment, the renderer generates the same RGBA frame sequence. The current renderer version is **15**; analysis remains at version **2**. The automatic seed is derived from decoded PCM and output settings. An explicit `--seed` makes visual exploration intentional and repeatable. System font rasterization and native codec implementations can still produce small byte-level differences across operating systems.

## Project configuration

[`visu.config.json`](./visu.config.json) contains the complete initial preset. Pass it explicitly so experiments remain reviewable:

```sh
bun run render -- ./song.wav --config ./visu.config.json
```

```json
{
  "version": 1,
  "output": {
    "width": 1920,
    "height": 1080,
    "fps": 60,
    "renderScale": 1,
    "crf": 18,
    "preset": "fast",
    "maxBitrateMbps": 16,
    "fadeSeconds": 3
  },
  "text": {
    "title": "",
    "artist": ""
  },
  "visual": {
    "seed": "auto",
    "imagePath": "",
    "lighting": 0.65,
    "intensity": 1,
    "bokehCount": 48,
    "spectrumBands": 64,
    "grain": 0.018,
    "vignette": 0.28,
    "lowFlash": true
  }
}
```

Useful output shorthands:

| Command | Result |
| --- | ---: |
| `--resolution hd --ratio 3:2` | `1280×854` |
| `--resolution fullhd --ratio 3:2` | `1920×1280` |
| `--resolution fullhd --ratio 16:9` | `1920×1080` |
| `--resolution fullhd --ratio 9:16` | `1080×1920` |
| `--resolution 4k --ratio 16:9` | `3840×2160` |
| `--size 1080x1080` | exact custom size |

Dimensions are rounded to even pixels for broadly compatible H.264 output.

`--duration` is quantized upward to complete video frames. For example, `0.51` seconds at 12 fps becomes 7 frames and is reported as `0.58` seconds, matching the encoded stream.

`fadeSeconds` controls synchronized picture-to-black and audio-to-silence ramps at both ends. Audio is timestamp-reset after source seeking, padded if frame quantization extends past the available source by a fraction of a frame, and trimmed to the exact video duration before fading.

`renderScale` controls the internal Canvas resolution independently of the encoded resolution. Final quality defaults to `1`, so Full HD is drawn natively at `1920×1080`. Quality presets replace the encoding settings and choose a render scale:

| Quality | Render scale | CRF | H.264 preset | Video ceiling |
| --- | ---: | ---: | --- | ---: |
| `--quality final` | `1` | `18` | `fast` | `16 Mbps` |
| `--quality preview` | `0.5` | `22` | `veryfast` | `8 Mbps` |
| `--quality master` | `1` | `8` | `slow` | uncapped |

All modes retain the configured frame rate, which defaults to 60 fps. An explicit `--render-scale` takes precedence over the preset's scale. The archive mode is lossy CRF encoding and produces larger files than the upload profile.

The optional `output.maxBitrateMbps` config field defaults to `16`, accepts finite values from `0` to `200`, and sets FFmpeg's video VBV ceiling in Mbps. The buffer is twice that value in Mbits; `0` disables the ceiling for uncapped CRF encoding. Actual average bitrate and file size depend on the scene. Omit `--quality` when retaining custom encoding settings from a project config.

## Platform-safe composition

Nebula, bokeh, stardust and glints fill the frame. Processed artwork, a softly lit material atmosphere and dissolving sculpture clouds sit behind the sharp geometry and leave the text area quiet. The sculpture, orbital ribbon echoes and rings use a clipped graph region, while title and artist occupy a separate symmetric safe text region:

| Output shape | Text width | Graph bounds |
| --- | --- | --- |
| Landscape | `x 8–92%` | `x 8–92%`, `y 32–78%` |
| Square | `x 8–92%` | `x 8–80%`, `y 30–60%` |
| Portrait | `x 12–88%` | `x 12–76%`, `y 30–60%` |

Both credit lines share the exact horizontal midpoint of the video. Vertical and square graph bounds reserve extra room for captions, progress controls, and right-side reaction/action buttons. Long title and artist strings are measured, scaled to their symmetric safe width, and clipped to the upper text region as a final guard.

Useful platform renders:

```sh
# TikTok / Instagram Reels / YouTube Shorts
bun run render -- ./song.wav --resolution fullhd --ratio 9:16 --fps 60 --quality final --output ./renders/portrait.mp4

# YouTube / Vimeo landscape
bun run render -- ./song.wav --resolution fullhd --ratio 16:9 --fps 60 --quality final --output ./renders/landscape.mp4
```

The portrait profile fits [TikTok's media transfer specifications](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide), which recommend MP4/H.264 and accept 23–60 fps with each dimension between 360 and 4096 pixels.

Run `bun src/cli.ts --help` for every option.

## Pipeline

```text
song
  └─ FFmpeg decode → mono 24 kHz PCM
       └─ deterministic offline analysis → optional .analysis.json
            └─ absolute-time, seeded Canvas2D renderer → RGBA frames
                 └─ FFmpeg H.264 + original audio AAC → .mp4
```

The offline renderer never reads wall-clock time and never calls `Math.random()`. Filaments, tracers, nebula lobes, bokeh, stardust, glints, orbital effects, onset accents, material placement, moving lights and grain use seeded plans or analytic motion. Slow and fast musical time come from cached prefix integrals of audio envelopes, so speed can react to the song while direct seeking follows the same path. Slow atmosphere is cached in frame-aligned buckets with source-analysis identity checks. Frozen clouds use a sparse bass-event plan: each small cached snapshot is rebuilt from its event's fixed capture time, then zoomed, blurred and dissolved by its absolute age. Bloom is rebuilt for each frame and uses the sculpture's camera transform to stay aligned with the emitting geometry. The conductor and all music-reactive layers read analysis by absolute timestamp, keeping direct seeking deterministic and leaving future parallel frame rendering possible.

See [docs/architecture.md](./docs/architecture.md) for module boundaries and the intended studio evolution.

## Development

```sh
bun run typecheck
bun run test
bun run check
```

`bun run test` runs the regular suite in `test/`; `bun run check` runs type checking and that same suite. Tests cover the FFT, normalized analysis, frame-rate-aware envelopes, onset timing, strict cache validation, adaptive section choreography, slow/fast music motion, frequency-weighted effects, centered credits and aspect-aware graph bounds, changing resonance silhouettes and orbital geometry, supernova causality and decay, frozen-cloud capture timing and deterministic dissolution, artwork preprocessing, vignette, beat zoom, frequency tint and path handling, coherent material generation and normal conventions, wrapped sampling, alpha-preserving cover relief, deterministic light positions, surface-normal-dependent spectrum lighting, six causal spectral/momentum tiers, protected atmosphere composition and bounded shading, low-flash motion preservation, music-reactive grading, configuration, seeded randomness and repeatable RGBA rendering. Real FFmpeg tests encode and decode native landscape and portrait Full HD60 videos, checking each distinct frame, A/V timing, upload codecs and color, bitrate limits and faststart.

Run the longer CLI-to-MP4 clip test separately:

```sh
bun run test:e2e:clip
# All tests in test-e2e/:
bun run test:e2e
```

The automated clip E2E generates a longer audio fixture with a known drop and passes a busy cover image through the public `clip --image` CLI. It checks a 30-second portrait MP4, the drop five seconds into the excerpt, all 1,800 frames at 60 fps, H.264/AAC encoding, matching audio/video duration, song and artist metadata, and decoded picture/audio fades. Both credit lines must remain visible and horizontally centered in a decoded 360-pixel-wide portrait preview with the artwork present. Output uses the default 1080×1920 delivery size with a quarter-scale internal render to limit test time. This verifies full-length clip selection and export; `bun run test:clip` is the shorter, six-second real-audio smoke render for visual inspection. Both require FFmpeg and FFprobe on `PATH`. Bare `bun test` discovers both suites, including the longer E2E.

For a manual output check:

```sh
ffprobe -v error -show_streams -show_format ./renders/example.mp4
```

Start with `bun run test:loop` or the preview preset while tuning a seed, title, and composition. Use final quality for upload and master quality when keeping an additional archive copy.
