import { state, persist } from './state.js';

export function mountUI({ onFile, onDetect, onRemove, onDownload, onPreset }) {
  const $ = (id) => document.getElementById(id);

  // Null-safe binders — never throw if an element is missing
  const bind = (id, event, fn) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
    return el;
  };
  const bindProp = (id, prop, fn) => {
    const el = $(id);
    if (el) el[prop] = fn;
    return el;
  };
  const setText = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };

  const drop = $('drop');
  const fileIn = $('file');
  const stage = $('stage');

  // ── Drop zone ─────────────────────────────────────────────────────────
  if (drop && fileIn) {
    bindProp('btnBrowse', 'onclick', () => fileIn.click());
    fileIn.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) onFile(f);
    });
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('dragover');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
      const f = e.dataTransfer.files?.[0];
      if (f) onFile(f);
    });
  }

  // ── Main actions ──────────────────────────────────────────────────────
  bindProp('btnDetect', 'onclick', onDetect);
  bindProp('btnRemove', 'onclick', onRemove);
  bindProp('btnDownload', 'onclick', onDownload);
  bindProp('btnUndo', 'onclick', () => dispatchEvent(new CustomEvent('unstamp:undo')));
  bindProp('btnRedo', 'onclick', () => dispatchEvent(new CustomEvent('unstamp:redo')));
  bindProp('btnClear', 'onclick', () => dispatchEvent(new CustomEvent('unstamp:clear')));

  // ── Preset (optional — only if present in the DOM) ────────────────────
  bind('preset', 'change', (e) => onPreset?.(e.target.value));

  // ── Watermark fields ──────────────────────────────────────────────────
  bind('watermark-text', 'input', (e) => {
    state.watermarkText = e.target.value;
    persist();
  });
  bind('watermark-colour', 'change', (e) => {
    state.watermarkColour = e.target.value;
    persist();
  });
  bind('watermark-angle', 'input', (e) => {
    state.watermarkAngle = +e.target.value;
    setText('angle-out', e.target.value + '°');
    persist();
  });
  bind('watermark-angle-auto', 'change', (e) => {
    state.watermarkAngleAuto = e.target.checked;
    setText('angle-out', e.target.checked ? 'auto' : state.watermarkAngle + '°');
    persist();
  });
  bind('watermark-tiled', 'change', (e) => {
    state.watermarkTiled = e.target.checked;
    persist();
  });
  bind('watermark-outline', 'change', (e) => {
    state.watermarkOutline = e.target.checked;
    persist();
  });
  bind('watermark-transparent', 'change', (e) => {
    state.watermarkTransparent = e.target.checked;
    persist();
  });
  bind('strip-metadata', 'change', (e) => {
    state.stripMetadata = e.target.checked;
    persist();
  });
  bind('safe-mode', 'change', (e) => {
    state.safeMode = e.target.checked;
    persist();
  });
  bind('model', 'change', (e) => {
    state.model = e.target.value;
    persist();
  });
  bind('post-denoise', 'change', (e) => {
    state.postDenoise = e.target.checked;
    persist();
  });
  bind('post-sharpen', 'change', (e) => {
    state.postSharpen = e.target.checked;
    persist();
  });

  // ── Template upload (optional) ────────────────────────────────────────
  bind('template-file', 'change', async (e) => {
    const f = e.target.files?.[0];
    if (f) state.templateImage = await createImageBitmap(f);
  });

  // ── Brush ─────────────────────────────────────────────────────────────
  bind('brush-size', 'input', (e) => {
    dispatchEvent(new CustomEvent('unstamp:brush', { detail: +e.target.value }));
    setText('brush-out', e.target.value);
  });

  // ── Toolbar buttons ───────────────────────────────────────────────────
  document.querySelectorAll('.toolbar button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.toolbar button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      dispatchEvent(new CustomEvent('unstamp:tool', { detail: b.dataset.tool }));
    };
  });

  // ── Exposed API ───────────────────────────────────────────────────────
  return {
    showStage() {
      if (drop) drop.hidden = true;
      if (stage) stage.hidden = false;
    },
    busy(on) {
      document.body.classList.toggle('busy', on);
    },
    setDownloadEnabled(on) {
      const el = $('btnDownload');
      if (el) el.disabled = !on;
    },
    syncFromState() {
      const set = (id, val) => { const el = $(id); if (el) el.value = val; };
      const check = (id, val) => { const el = $(id); if (el) el.checked = !!val; };
      set('watermark-text', state.watermarkText || '');
      set('watermark-colour', state.watermarkColour || 'auto');
      set('watermark-angle', state.watermarkAngle || 0);
      check('watermark-angle-auto', state.watermarkAngleAuto);
      check('watermark-tiled', state.watermarkTiled);
      check('watermark-outline', state.watermarkOutline);
      check('watermark-transparent', state.watermarkTransparent);
      set('model', state.model || 'auto');
    },
    renderCandidates(hits) {
      const t = $('thumbs');
      if (!t) return;
      t.innerHTML = '';
      hits.forEach((h, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'thumb' + (i === 0 ? ' active' : '');
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#333';
        ctx.fillRect(0, 0, 64, 64);
        ctx.strokeStyle = '#7c9cff';
        ctx.lineWidth = 2;
        const ar = h.width / h.height;
        const dw = ar > 1 ? 60 : 60 * ar;
        const dh = ar > 1 ? 60 / ar : 60;
        ctx.strokeRect((64 - dw) / 2, (64 - dh) / 2, dw, dh);
        wrap.appendChild(c);
        wrap.onclick = () => dispatchEvent(new CustomEvent('unstamp:pickcandidate', { detail: h }));
        t.appendChild(wrap);
      });
    },
  };
}