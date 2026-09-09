# Architecture

The first milestone is a deterministic batch renderer. A future local studio should orchestrate this core rather than create a second rendering path.

## Boundaries

### 1. Decode

[`src/audio/decode.ts`](../src/audio/decode.ts) asks FFmpeg for mono, 24 kHz, 32-bit floating-point PCM. Hashing decoded PCM means container metadata does not affect the automatic visual seed.

### 2. Analyze

[`src/audio/analyze.ts`](../src/audio/analyze.ts) calculates fixed-rate feature frames. A 2048-sample Hann window feeds an in-repository radix-2 FFT. Logarithmic frequency bands and track-wide percentile normalization turn source-dependent magnitudes into stable `0..1` control signals.

The analysis stage owns signal processing and temporal smoothing. RMS attack and release coefficients account for elapsed time, preserving their response across output frame rates. Analysis defaults to 60 feature frames per second to match the 60 fps output. Analysis caches remain version **2**; older versions and caches sampled at another output frame rate must be regenerated.

[`src/audio/onsets.ts`](../src/audio/onsets.ts) extracts shared onset events from normalized analysis and queries them by absolute time. Flat or clipped peaks produce one event at their leading edge; the initial FFT comparison against silence is excluded. The conductor uses fixed-time event envelopes for rhythm activity and beat decay.

### Highlight selection and metadata

The `clip` CLI subcommand shares decoding, analysis and `renderVideo()` with ordinary renders. [`src/audio/clip.ts`](../src/audio/clip.ts) exposes the pure `selectClip(analysis, options)` API. Prefix integrals of bass-weighted energy allow time-based pre-hit, attack and post-hit windows to be scored in linear time. A candidate needs a sharp rise and sustained contrast; isolated impulses and gradual intro ramps are rejected. Context weighting favors usable lead-in and post-drop music. With no distinct drop, the highest mean-energy window wins, with deterministic earliest ties.

`ClipSelection` records source `start`, `end`, `duration`, optional `drop` and `dropOffset`, a selection `reason`, and a heuristic `score`. Default duration is 30 seconds and lead-in five seconds. Manual `drop` overrides the detector. Frame-aligned starts and durations keep normal delivery within the requested limit; short sources retain their available audio and the render core pads only a fractional final video frame. A drop near EOF shortens the clip while preserving lead-in. Selection never slices the analysis, so the visual renderer continues on the original absolute song timeline.

[`src/audio/metadata.ts`](../src/audio/metadata.ts) reads structured FFprobe tags using an argument array. Explicit CLI text and config text take priority, then format/audio-stream tags supply normalized title and artist values; album artist is a fallback. Clip export requires an artist credit. The portrait layout retains the same large, horizontally centered title and artist type and safe zones as full-song rendering.

`clip --dry-run` validates the analysis/source relationship and prints the selection, delivery profile, frame-quantized duration and effective fades as JSON without starting an encoder. The clip profile defaults to native 1080×1920 at 60 fps and final encoding, with independent 0.35-second entrance and three-second exit fades. Near source boundaries, the entrance is capped at the drop offset and the exit leaves a brief full-volume post-drop hold; dry-run and encoding receive the same effective fades. Normal render defaults remain unchanged.

### 3. Plan and render

[`src/render/renderer.ts`](../src/render/renderer.ts) draws the **Resonance** preset using named seeded streams for harmonic filaments, radial nebula lobes, bokeh, stardust, depth glints, orbital ribbon and vortex plans, onset accents, and grain. Object properties are generated once or derived from an event's stable analysis-frame index. Positions are analytic functions of absolute time and integrated musical time, so frame `n` is independent of frames `0..n-1`.

[`src/render/music-motion.ts`](../src/render/music-motion.ts) exposes `deriveMusicMotion(analysis, time)`. It derives independently normalized bass, mid and treble envelopes, bass and treble transient pulses, and a sustained energy envelope. Attack and release rates use elapsed seconds. Cached scalar prefix integrals and analytic integration inside each analysis interval produce `slowTime` and `fastTime`; motion accelerates with musical energy without accumulating mutable render state or changing position abruptly. Direct seeks and sequential rendering follow the same path, and transient pulses never precede their analysis timestamps.

[`src/render/music-effects.ts`](../src/render/music-effects.ts) maps this motion through `deriveMusicEffects(motion, lowFlash)` to zoom, rotation, hue shift, saturation, chromatic dispersion and glow. Its `frequencyResponse(energy, bandPosition)` gives low frequencies greater spatial influence than equal high-frequency amplitudes. Bass and kicks drive the largest deformations and camera pulses, mids influence slow rotation, and highs produce smaller rapid detail. Low-flash mode limits transient light accents while retaining expressive low-frequency movement.

[`src/render/resonance.ts`](../src/render/resonance.ts) builds 72 flowing filaments with 241 points each, including the repeated closing point. The slow musical clock changes the aperture and tube proportions from an open ring toward an orb, introduces a three-lobed radial contour and bends the volume into a plasma knot. Opposing horizontal/vertical stretch and broad 3D precession change its silhouette as it turns through perspective. Normalized bass energy and causal bass transients drive the largest broad folds; mids have a smaller influence on tube shape and flow; treble energy and pulses add fine ripples on the fast clock. Frequency-weighted spectral bands and low waveform harmonics supply further detail. The projected sculpture is fitted as a whole, and point depth separates front and back drawing passes. Fast tracers follow its contours; local energy controls their brightness. The renderer sweeps the field through saturated cool and warm palettes, with pearl highlights and hue shifts driven by sustained musical time and frequency energy. A sparse contour echo sampled 180 ms earlier adds decaying trails without retaining a previous framebuffer.

[`src/render/frozen-cloud.ts`](../src/render/frozen-cloud.ts) plans sparse, bass-weighted sculpture captures with at least 2.8 seconds between events, a six-second lifetime and at most three live clouds. Each event fixes the sculpture's geometry, camera and colors at its capture timestamp. [`src/render/frozen-cloud-layer.ts`](../src/render/frozen-cloud-layer.ts) renders a small snapshot surface from that timestamp and caches it by source analysis and event identity; it is not sampled from whichever frame happened to render previously. Absolute event age controls a slow scale change from 1 to 1.7, increasing blur, dissolution and decreasing opacity. The faint clouds are composited behind the live sculpture with a mask above the graph region to protect the credits. Forward, reverse and direct seeks therefore recreate the same frozen impression and fade.

[`src/render/artwork.ts`](../src/render/artwork.ts) prepares a local PNG, JPEG, WebP or AVIF image once, before the encoder opens. `--image` overrides `visual.imagePath`; a relative CLI path resolves from the working directory, while a relative config path resolves beside its JSON file. Empty `imagePath` leaves the procedural scene unchanged. SVG, URLs and data URLs are not accepted.

The preparation stage downsamples, desaturates, blurs and reduces contrast to turn source detail into a restrained peripheral texture. Quiet masks protect the upper title and artist region and the central hero geometry. A separate feathered vignette reduces image alpha by up to 58% toward the corners, independently of the scene's final vignette. A dominant source hue contributes to the sculpture's palette without replacing music-reactive hue changes and transient accents. The renderer consumes the prepared surface and palette through `PreparedArtwork`, keeping image loading and processing outside the per-frame drawing loop. The source image is never modified.

The pure `deriveArtworkMotion(time, music)` API computes image scale, hue shift, saturation and opacity. Scale combines slow musical breathing at `1.018 ± 0.009` with an additive bass-pulse zoom of at most `0.012`. Normalized bass, mid and treble energy contribute `−14°`, `+5°` and `+2.6°` respectively to the continuous hue shift, preserving the strongest response for bass. Their saturation contributions are 4.5%, 3% and 1.5%, capped together at a 9% boost. Opacity ranges from 0.63 to 0.72 with sustained energy and does not flash on beat impulses. These transforms derive directly from absolute musical time and envelopes, so repeated seeks agree.

[`src/render/supernova.ts`](../src/render/supernova.ts) exposes `novaEventsAt(analysis, time, seed, lowFlash)`. A plan cached per analysis detects positive bass and high-frequency changes against the preceding frame, with track-relative transient sensitivity and an absolute noise floor. It skips the initial FFT and never exposes an event before its timestamp. Bass events produce stronger, larger supernovas with a 0.75-second refractory period; smaller flares have a 0.3-second refractory period. Scheduling allows at most four live events and reserves a voice for bass, preserving an existing afterglow until it expires instead of truncating live tails.

Each event returns its stable analysis-frame ID, age, strength, seeded hue/angle/origin, expanding radius and separate flash, flare and afterglow envelopes. Normal flash attacks take 30–45 ms and decay over 120–160 ms; diffraction flares decay over 400–520 ms. Nova afterglow decays over 1.4 seconds, with a smooth final fade before the 2.4-second lifetime ends; small flares end after 1.1 seconds. Strong bass shockfronts approach 2.5 hero radii. The Canvas renderer turns these controls into local kick light, diffraction streaks, outward particles and expanding shockfronts. These accents remain local to their source. Low-flash mode lowers the three light envelopes and lengthens the fast attack/decay, preserving every event's identity, strength, origin, radius and motion. No previous framebuffer or accumulated particle state is needed, so direct, reverse and sequential seeks agree.

[`src/render/reactive-effects.ts`](../src/render/reactive-effects.ts) owns the pure geometry and control math for the faint orbital ribbon echoes, perspective vortex rings, travelling glint poses, and dynamic color grade. Keeping geometry outside Canvas drawing makes bounds, spectrum and waveform response, depth ordering, speed limits, low-flash behavior, and determinism directly testable without brittle pixel snapshots.

[`src/render/conductor.ts`](../src/render/conductor.ts) builds a cached, track-relative energy profile and turns local contrast, rhythm activity, build/drop trend, and beat impulses into continuous ambient, drive, peak, form, and motion controls. It uses bounded analysis windows, including deterministic look-ahead, rather than mutable playback state. A pure choreography map crossfades atmosphere, rings, ribbon, grade, glints, detail and camera across musical sections; low-flash mode caps only fast transient controls.

[`src/render/layout.ts`](../src/render/layout.ts) computes conservative landscape, square, and portrait safe rectangles. Full-bleed atmosphere ignores these bounds. Typography uses a symmetric text rectangle centered at the full frame's `width / 2`, independently of the graph center. Portrait and square graph profiles reserve additional bottom and right space for social-player captions, controls, and action rails.

The Canvas2D scene currently has these layers:

1. a frame-bucketed, quarter-resolution nebula with radial cloud lobes, soft bokeh and dynamic color grade, with optional softened peripheral artwork;
2. low-opacity frozen sculpture clouds, slowly enlarging and dissolving behind the sharp scene;
3. current-frame filament, orbital, onset and supernova emission, plus a sparse 180 ms contour echo, accumulated into a separate quarter-resolution surface;
4. two-pass bloom with music-driven saturation and brief chromatic split, composited over the atmosphere with the same graph camera transform as the sharp scene;
5. 640 slowly drifting full-bleed stardust particles, faint flowing field lines and fast depth glints;
6. back-facing resonance segments and faint orbital ribbon and ring echoes;
7. front-facing resonance segments, fast contour tracers and orbiters, with an aperture that opens and closes as the geometry morphs;
8. onset sparks, local supernova flashes, diffraction flares, outward particles and expanding shockfronts with decaying afterglow, followed by vignette and lower-cadence seeded grain;
9. large, high-contrast title and artist typography, rendered last without a rectangular text panel.

The graph clip spans `y 32–78%` in landscape and `y 30–60%` in portrait and square output. Landscape layouts reserve top and bottom player chrome; portrait and square layouts additionally shift the graph center left and reserve a right action rail. The sculpture and orbital geometry share this graph layout. Typography remains centered in the full video: its separate upper region spans `x 8–92%` for landscape and square, or `x 12–88%` for portrait. Long title and artist strings are measured and uniformly reduced to fit that symmetric safe width.

Short titles use semibold type, with a larger medium-weight artist line and tight tracking. Both stay near white and retain full opacity after a brief entrance; text is never blurred or dimmed during the song. The two lines are sized together to fit the available height, including entrance motion, and remain readable in small landscape and portrait previews.

Slow atmosphere caches check analysis object identity as well as source metadata and the frame bucket. Frozen snapshot caches also respect analysis identity and retain a bounded set of event surfaces; evicted snapshots can be recreated from their capture timestamps. Current emission is rebuilt from scratch on every render. Atmosphere has its own gentle camera drift; bloom is composited separately so it remains aligned with the sculpture during camera motion and direct seeks.

### 4. Encode

[`src/render/encoder.ts`](../src/render/encoder.ts) streams raw RGBA frames to FFmpeg with backpressure. FFmpeg applies the Lanczos delivery filter (a spatial resize only when internal and delivery dimensions differ), synchronized picture-to-black and audio-to-silence fades, then encodes H.264 High-profile video with BT.709 metadata, two B-frames, four references, and a fixed closed GOP. It seeks the original source audio to the same start time, resets its local timestamp, pads and trims it to the frame-quantized video duration, encodes stereo AAC-LC at 48 kHz with a 384 kbps target, and muxes an MP4 with fast-start metadata.

Audio is converted to a platform-oriented delivery profile: AAC-LC, stereo, 48 kHz, and 384 kbps. This conversion does not apply loudness normalization. The source audio is always mapped explicitly. Integration tests decode finished picture and PCM data to verify the full three-second fade slopes, black endpoints, silent endpoints, excerpt-local timing, and non-silent midpoint in addition to codec metadata. Additional native Full HD60 landscape and portrait tests count and decode every distinct input frame, check A/V duration within 2 ms, confirm H.264 High/yuv420p/BT.709 and AAC, and verify bitrate settings and faststart in the output file.

The longer clip E2E drives the public CLI with a synthetic song containing a known drop and a busy cover PNG passed through `--image`. It validates the selected lead-in and 30-second portrait export, then decodes a 360-pixel-wide frame to check that both title and artist remain visible and centered despite the artwork. Cadence, A/V timing and source alignment, codecs, metadata and synchronized fades are also checked on the finished MP4.

The optional `RenderRequest.fadeInSeconds` and `fadeOutSeconds` override the two fades independently. Explicit fades are fitted proportionally when their sum exceeds the excerpt duration, so they never overlap. Without overrides the existing symmetric fade and half-duration cap apply. Timing and fades are validated before encoder creation; nonfinite start/duration values are rejected. `validateRenderAnalysis()` shares version, source-hash, band-count and frame-rate validation between encoding and CLI dry runs.

Requested durations are converted to a whole frame count once, before rendering and encoding. The reported duration, FFmpeg limit, and video frame count therefore share one value. Source-file hash verification lives in the render core, so library callers receive the same cache/audio mismatch protection as the CLI.

The default frame rate is 60 fps. Default and `final` renders work at 100% of the requested width and height, CRF 18 and the `fast` H.264 preset. A default Full HD job draws natively at `1920×1080`; the portrait equivalent is `1080×1920`. The optional `output.maxBitrateMbps` config field defaults to `16` and sets FFmpeg `-maxrate 16M -bufsize 32M`: a 16 Mbps video ceiling with a 32 Mbit buffer. Values from 0 to 200 are accepted; zero disables the ceiling. Actual average bitrate depends on visual complexity.

`--quality preview` selects half scale, CRF 22, `veryfast`, and an 8 Mbps ceiling with a 16 Mbit buffer. `--quality master` selects native scale, CRF 8, `slow`, and uncapped CRF encoding for an optional archive. All quality modes retain the configured frame rate; explicit `--fps` and `--render-scale` overrides take precedence. Omit `--quality` to retain custom encoding settings from the project config.

The upload choices follow [YouTube's recommended MP4/H.264/AAC settings](https://support.google.com/youtube/answer/1722171). Its 1080p high-frame-rate reference is 12 Mbps; this project's 16 Mbps ceiling allows additional headroom and is not a platform requirement. The Full HD60 portrait profile also fits [TikTok's media transfer specifications](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide): MP4/H.264, 23–60 fps, and dimensions from 360 to 4096 pixels.

## Reproducibility contract

A render plan is identified by:

- decoded PCM hash;
- input artwork bytes, when supplied;
- explicit or automatically derived seed;
- analysis and renderer versions;
- output dimensions and frame rate;
- project visual settings;
- absolute frame time.

The current renderer version is **12** and analysis version remains **2**. Composition and motion are reproducible, including frozen-cloud capture selection and prepared artwork. Pixel-identical output is guaranteed within the same pinned native runtime; fonts and codecs may vary slightly across platforms until the project bundles a font and containerizes the render toolchain.

## Intended next milestones

1. A local browser studio for drag/drop audio, seekable preview, seed exploration, and config editing.
2. A worker-thread analysis path with a compact binary cache for very long tracks.
3. Deeper song-structure detection and named, editable visual chapters beyond the current rolling conductor.
4. Optional WebGL layers and motion-blur supersampling while retaining the same analysis/config contract.
5. A bundled open font and golden-frame fixtures for stronger cross-machine reproducibility.
