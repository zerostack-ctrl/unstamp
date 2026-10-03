export interface Preset {
  text?: string;
  angle: number | 'auto';
  colour: 'white' | 'black' | 'auto';
  opacity?: number;
  corner?: 'tl' | 'tr' | 'bl' | 'br';
  tiled?: boolean;
  transparent?: boolean;
  notch?: boolean;
}

export const PRESETS: Record<string, Preset> = {
  sora: { text: 'Sora', angle: -30, colour: 'white', opacity: 25, corner: 'br', transparent: true },
  veo: { text: 'Veo', angle: -30, colour: 'white', opacity: 30, corner: 'br', transparent: true },
  gemini: { text: 'Gemini', angle: 0, colour: 'white', opacity: 40, corner: 'br', transparent: true },
  dalle: { text: 'DALL·E', angle: 0, colour: 'white', opacity: 35, corner: 'br', transparent: true },
  midjourney: { text: 'Midjourney', angle: 0, colour: 'white', opacity: 20, corner: 'bl', transparent: true },
  synthid: { angle: 'auto', colour: 'auto', notch: true },
};

export type PresetName = keyof typeof PRESETS;