export interface PreviewCamera { x: number; y: number; roll: number; zoom: number }
export function previewCamera(values: ArrayLike<number>, width: number, height: number): PreviewCamera;
