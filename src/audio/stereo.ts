import { analyzeAudio } from "./analyze.js";
import { decodeAudio } from "./decode.js";
import type { AudioAnalysis } from "../types.js";

/** Enrich a legacy mono cache from its source without changing its motion data or song identity. */
export async function ensureStereoAnalysis(audioPath: string, analysis: AudioAnalysis): Promise<AudioAnalysis> {
  if (analysis.frames.every(frame => frame.spectrumLeft && frame.spectrumRight)) return analysis;
  const pcm = await decodeAudio(audioPath);
  if (pcm.sourceFileHash !== analysis.sourceFileHash) throw new Error("The analysis was created from a different audio file");
  const stereo = analyzeAudio(pcm, analysis.fps, analysis.spectrumBands);
  if (stereo.frames.length !== analysis.frames.length) throw new Error("Stereo analysis does not match the cached timeline");
  return { ...analysis, frames: analysis.frames.map((frame, index) => ({ ...frame,
    spectrumLeft: stereo.frames[index]!.spectrumLeft!, spectrumRight: stereo.frames[index]!.spectrumRight!,
  })) };
}
