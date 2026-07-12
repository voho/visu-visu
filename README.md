# visu-visu

`visu-visu` turns a song into a deterministic, audio-reactive music video. It analyzes the full track first, then renders every video frame from absolute time, cached features, and a seeded visual plan.

The initial preset is **Monochrome Signal Dream**: a slow grayscale noise-and-bokeh field, a mirrored spectral ribbon, layered waveform echoes, restrained typography, bloom, vignette, and grain. Loudness controls exposure and breathing, bass expands the bokeh, mids move the atmosphere, treble sharpens detail, and spectral flux drives brief onset accents.

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

The default is `1920×1280` at 30 fps. This deliberately interprets “Full HD + 3:2” as a Full-HD-width, 3:2 frame. Standard Full HD is 16:9, so use either of these when that is the intended format:

```sh
bun run render -- ./song.mp3 --resolution fullhd --ratio 16:9
bun run render -- ./song.mp3 --size 1920x1080
```

For a quick, eight-second draft:

```sh
bun run preview -- ./song.mp3 --overwrite
```

The preview script renders at `960×640` with a faster encode preset. Set `--start 45` to inspect a later section.

## Deterministic two-stage processing

Analysis is an explicit, reusable artifact:

```sh
bun run analyze -- ./song.flac --output ./song.analysis.json

bun run render -- ./song.flac \
  --analysis ./song.analysis.json \
  --seed charcoal-17 \
  --output ./renders/song.mp4
```

The analysis contains time-indexed RMS, peak, a log-frequency spectrum, bass/mid/treble energy, spectral centroid, spectral flux, onset strength, and waveform samples. Track-level percentiles normalize these values before rendering.

Cached analysis is bound to the exact source file as well as its decoded PCM. The renderer rejects a cache paired with another audio file, malformed feature values, unsupported versions, or inconsistent frame counts. JSON caches are capped at 128 MiB in this first format; longer-form sets should currently be analyzed as part of the render instead of saved.

With the same decoded audio, settings, seed, renderer version, and runtime environment, the renderer generates the same RGBA frame sequence. The automatic seed is derived from decoded PCM and output settings. An explicit `--seed` makes visual exploration intentional and repeatable. System font rasterization and native codec implementations can still produce small byte-level differences across operating systems.

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
    "height": 1280,
    "fps": 30,
    "crf": 18,
    "preset": "medium"
  },
  "text": {
    "title": "",
    "artist": ""
  },
  "visual": {
    "seed": "auto",
    "intensity": 1,
    "bokehCount": 48,
    "spectrumBands": 64,
    "grain": 0.035,
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

Run `bun src/cli.ts --help` for every option.

## Pipeline

```text
song
  └─ FFmpeg decode → mono 24 kHz PCM
       └─ deterministic offline analysis → optional .analysis.json
            └─ absolute-time, seeded Canvas2D renderer → RGBA frames
                 └─ FFmpeg H.264 + original audio AAC → .mp4
```

The renderer never reads wall-clock time and never calls `Math.random()`. Background objects have fixed seeded identities and analytic motion, while waveform trails are earlier analysis samples rather than stateful feedback. This keeps seeking and parallel frame rendering possible later.

See [docs/architecture.md](./docs/architecture.md) for module boundaries and the intended studio evolution.

## Development

```sh
bun run typecheck
bun test
bun run check
```

Tests cover the FFT, normalized analysis, strict cache validation, configuration, seeded randomness, repeatable RGBA rendering, and an FFmpeg/ffprobe A/V integration render. A practical smoke test is a short preview followed by:

```sh
ffprobe -v error -show_streams -show_format ./renders/example.mp4
```

Full-resolution rendering is intentionally offline and CPU-heavy. Start with the preview preset while tuning a seed, title, and composition, then run the final encode.
