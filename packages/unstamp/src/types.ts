export type ImageSource = ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export type Phase =
  | 'metadata'
  | 'detect'
  | 'mask'
  | 'inpaint'
  | 'postprocess'
  | 'done';

export type ColourHint = 'auto' | 'white' | 'black' | `#${string}`;

export interface UnstampOptions {
  text?: string;
  template?: ImageSource;
  angle?: number | 'auto';
  transparent?: boolean;
  colour?: ColourHint;
  tiled?: boolean;
  outline?: boolean;
  model?: 'auto' | 'migan' | 'lama' | 'ensemble';
  safeMode?: boolean;
  denoise?: boolean;
  sharpen?: boolean;
  metadata?: boolean;
  onProgress?: (phase: Phase, pct: number) => void;
  ort?: any;
  resolveModelUrl?: (name: 'migan' | 'lama') => string;
}

export interface Detection {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  scale: number;
  score: number;
  region: 'text' | 'blob' | 'template' | 'tiled';
}

export interface Result {
  image: ImageData;
  mask: Float32Array;
  detections: Detection[];
  timings: Partial<Record<Phase, number>>;
}