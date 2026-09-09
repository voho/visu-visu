export interface PreviewCamera { x: number; y: number; roll: number; zoom: number; creditFloor: number; creditCeiling: number }
export function createSculptureSampler(values: ArrayLike<number>): (u: number, v: number) => [number, number, number];
export function preparePreviewCamera(timeline: Float32Array, profile: {duration: number; fps: number; frameCount: number; stride: number}): void;
export function setPreviewHero(width: number, height: number, creditTop: number): void;
export function previewCamera(values: ArrayLike<number>, width: number, height: number): PreviewCamera;
