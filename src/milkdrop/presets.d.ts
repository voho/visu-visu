export type MilkdropPresetId='vortex'|'ribbons'|'cosmic-dust'|'fog-tunnel'|'julia-fractal'|'plasma'|'folded-tunnel'|'moebius'|'mandelbox-explorer'|'tunnel-race'|'fractal-descent';
export const MILKDROP_PRESETS: readonly {readonly id:MilkdropPresetId;readonly name:string;readonly family:string}[];
export const MILKDROP_DEFAULT_PRESET_IDS: readonly MilkdropPresetId[];
export function milkdropPreset(id:string): Record<string,unknown>;
