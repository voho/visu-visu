export type MilkdropPresetId='vortex'|'ribbons'|'cosmic-dust'|'fog-tunnel'|'julia-fractal'|'plasma'|'folded-tunnel'|'moebius';
export const MILKDROP_PRESETS: readonly {readonly id:MilkdropPresetId;readonly name:string;readonly family:string}[];
export function milkdropPreset(id:string): Record<string,unknown>;
