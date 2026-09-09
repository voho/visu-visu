export { selectClip } from "./audio/clip.js";
export type { ClipSelection, ClipOptions } from "./audio/clip.js";
export { readAudioMetadata } from "./audio/metadata.js";
export { analyzeAudio, frameAt } from "./audio/analyze.js";
export { loadAnalysis, saveAnalysis } from "./audio/cache.js";
export { assertFfmpegAvailable, decodeAudio, hashFile } from "./audio/decode.js";
export {
  DEFAULT_CONFIG,
  dimensionsFor,
  loadProjectConfig,
  parseProjectConfig,
  parseRatio,
  parseSize,
  renderDimensions,
  resolveArtworkPath,
} from "./config.js";
export { RealFft } from "./math/fft.js";
export { createRandom, deriveSeed, hashString } from "./math/random.js";
export { deriveVisualState } from "./render/conductor.js";
export type { VisualState } from "./render/conductor.js";
export { renderVideo } from "./render/render.js";
export { VisualizerRenderer } from "./render/renderer.js";
export { prepareArtwork, drawArtwork, deriveArtworkMotion } from "./render/artwork.js";
export type { PreparedArtwork, ArtworkMotion } from "./render/artwork.js";
export { createSafeLayout, safeGraphRadius } from "./render/layout.js";
export type { SafeLayout } from "./render/layout.js";
export type * from "./types.js";
