const listeners = new Set();

export const state = {
  image: null,
  result: null,
  width: 0,
  height: 0,
  preset: '',
  watermarkText: '',
  watermarkColour: 'auto',
  watermarkAngle: 0,
  watermarkAngleAuto: true,
  watermarkTiled: false,
  watermarkOutline: false,
  watermarkTransparent: true,
  stripMetadata: true,
  safeMode: false,
  templateImage: null,
  model: 'auto',
  postDenoise: true,
  postSharpen: true,

  setImage(bitmap) {
    this.image = bitmap;
    this.width = bitmap.width;
    this.height = bitmap.height;
    this.emit();
  },
  emit() { for (const fn of listeners) fn(this); },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

const PERSIST = [
  'watermarkText', 'watermarkColour', 'watermarkAngle', 'watermarkAngleAuto',
  'watermarkTiled', 'watermarkOutline', 'watermarkTransparent',
  'stripMetadata', 'safeMode', 'model', 'postDenoise', 'postSharpen',
];

export function loadPersisted() {
  try {
    const saved = JSON.parse(localStorage.getItem('unstamp:settings') || '{}');
    for (const k of PERSIST) if (k in saved) state[k] = saved[k];
  } catch {}
}

export function persist() {
  const out = {};
  for (const k of PERSIST) out[k] = state[k];
  localStorage.setItem('unstamp:settings', JSON.stringify(out));
}
