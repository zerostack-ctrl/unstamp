import { detectTextWatermark } from '../detect/text.js';
import { detectGeneric } from '../detect/generic.js';
import { findTilePeriod } from '../detect/periodic.js';
import { detectInImage } from '../detect/auto.js';

self.onmessage = async (e) => {
  const { id, payload } = e.data;

  const emit = (phase, pct, detail) => {
    self.postMessage({ id, type: 'progress', phase, pct, detail });
  };

  try {
    let hits = [];

    if (payload.text && payload.text.trim()) {
      // Explicit text
      hits = detectTextWatermark(payload.imageData, payload.text, {
        angle: payload.angleAuto ? null : payload.angle,
        outline: payload.outline,
        onProgress: emit,
      });
    } else if (payload.autoDetect) {
      // Auto-detect using common-string prefilter + generic blobs
      hits = await detectInImage(payload.imageData, { onProgress: emit });
    } else {
      // Fallback: generic only
      emit('detect', 0.1, 'Scanning for blobs');
      hits = detectGeneric(payload.imageData);
      emit('detect', 1, `Found ${hits.length}`);
    }

    if (payload.tiled) {
      emit('detect', 0.95, 'Analysing tile period');
      const periods = findTilePeriod(payload.imageData);
      for (const h of hits) h.tilePeriods = periods;
    }

    self.postMessage({ id, ok: true, result: hits });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};