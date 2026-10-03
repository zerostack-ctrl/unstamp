import { detectTextWatermark } from '../detect/text.js';
import { detectGeneric } from '../detect/generic.js';
import { findTilePeriod } from '../detect/periodic.js';

self.onmessage = (e) => {
  const { id, payload } = e.data;
  try {
    let hits = [];
    if (payload.text) {
      hits = detectTextWatermark(payload.imageData, payload.text, {
        angle: payload.angleAuto ? null : payload.angle,
        outline: payload.outline,
      });
    } else {
      hits = detectGeneric(payload.imageData);
    }
    if (payload.tiled) {
      const periods = findTilePeriod(payload.imageData);
      for (const h of hits) h.tilePeriods = periods;
    }
    self.postMessage({ id, ok: true, result: hits });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
