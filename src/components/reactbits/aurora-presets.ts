/** Color presets for the AuroraBlur adaptation. Plain module so server components can import them. */

export type AuroraLayer = { color: string; speed: number; intensity: number };
export type SkyLayer = { color: string; blend: number };

/** BTC palette: sky and blue ribbons over a navy sky. */
export const BTC_AURORA_LAYERS: AuroraLayer[] = [
  { color: "#22a4dc", speed: 0.32, intensity: 0.55 },
  { color: "#0d66a5", speed: 0.15, intensity: 0.45 },
  { color: "#5cbde6", speed: 0.2, intensity: 0.2 },
  { color: "#1479be", speed: 0.07, intensity: 0.25 },
];

export const BTC_AURORA_SKY: SkyLayer[] = [
  { color: "#06223b", blend: 0.55 },
  { color: "#0b3d66", blend: 0.45 },
];

/**
 * Softer preset for short banners (dashboard, 404). The aurora layers are additive, so in a
 * wide, short canvas the default intensities saturate toward cyan; these keep the banner in
 * BTC blues with enough contrast for white text.
 */
export const BTC_AURORA_BANNER: { layers: AuroraLayer[]; skyLayers: SkyLayer[]; bloomIntensity: number; brightness: number; verticalFade: number; noiseScale: number } = {
  layers: [
    { color: "#22a4dc", speed: 0.3, intensity: 0.32 },
    { color: "#0d66a5", speed: 0.14, intensity: 0.4 },
    { color: "#5cbde6", speed: 0.2, intensity: 0.1 },
    { color: "#1479be", speed: 0.07, intensity: 0.2 },
  ],
  skyLayers: [
    { color: "#0b3d66", blend: 0.7 },
    { color: "#0b4f84", blend: 0.35 },
  ],
  bloomIntensity: 1.1,
  brightness: 0.9,
  verticalFade: 0.9,
  noiseScale: 2.4,
};
