import { state, persist } from './state.js';

export function mountUI({ onFile, onDetect, onRemove, onDownload, onPreset }) {
  const $ = (id) => document.getElementById(id);
  const drop = $('drop');
  const fileIn = $('file');
  const stage = $('stage');

  $('btnBrowse').onclick = () => fileIn.click();
  fileIn.onchange = (e) => e.target.files[0] && onFile(e.target.files[0]);

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });

  $('btnDetect').onclick = onDetect;
  $('btnRemove').onclick = onRemove;
  $('btnDownload').onclick = onDownload;
  $('btnUndo').onclick = () => dispatchEvent(new CustomEvent('unstamp:undo'));
  $('btnRedo').onclick = () => dispatchEvent(new CustomEvent('unstamp:redo'));
  $('btnClear').onclick = () => dispatchEvent(new CustomEvent('unstamp:clear'));

  $('preset').onchange = (e) => onPreset(e.target.value);
  $('watermark-text').oninput = (e) => { state.watermarkText = e.target.value; persist(); };
  $('watermark-colour').onchange = (e) => { state.watermarkColour = e.target.value; persist(); };
  $('watermark-angle').oninput = (e) => {
    state.watermarkAngle = +e.target.value;
    $('angle-out').textContent = e.target.value + '°';
    persist();
  };
  $('watermark-angle-auto').onchange = (e) => {
    state.watermarkAngleAuto = e.target.checked;
    $('angle-out').textContent = e.target.checked ? 'auto' : state.watermarkAngle + '°';
    persist();
  };
  $('watermark-tiled').onchange = (e) => { state.watermarkTiled = e.target.checked; persist(); };
  $('watermark-outline').onchange = (e) => { state.watermarkOutline = e.target.checked; persist(); };
  $('watermark-transparent').onchange = (e) => { state.watermarkTransparent = e.target.checked; persist(); };
  $('strip-metadata').onchange = (e) => { state.stripMetadata = e.target.checked; persist(); };
  $('safe-mode').onchange = (e) => { state.safeMode = e.target.checked; persist(); };
  $('model').onchange = (e) => { state.model = e.target.value; persist(); };
  $('post-denoise').onchange = (e) => { state.postDenoise = e.target.checked; persist(); };
  $('post-sharpen').onchange = (e) => { state.postSharpen = e.target.checked; persist(); };

  $('template-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) state.templateImage = await createImageBitmap(f);
  };

  $('brush-size').oninput = (e) => {
    dispatchEvent(new CustomEvent('unstamp:brush', { detail: +e.target.value }));
    $('brush-out').textContent = e.target.value;
  };

  document.querySelectorAll('.toolbar button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.toolbar button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      dispatchEvent(new CustomEvent('unstamp:tool', { detail: b.dataset.tool }));
    };
  });

  return {
    showStage() { drop.hidden = true; stage.hidden = false; },
    busy(on) { document.body.classList.toggle('busy', on); },
    setDownloadEnabled(on) { $('btnDownload').disabled = !on; },
    syncFromState() {
      $('watermark-text').value = state.watermarkText || '';
      $('watermark-colour').value = state.watermarkColour || 'auto';
      $('watermark-angle').value = state.watermarkAngle || 0;
      $('watermark-angle-auto').checked = !!state.watermarkAngleAuto;
      $('watermark-tiled').checked = !!state.watermarkTiled;
      $('watermark-outline').checked = !!state.watermarkOutline;
      $('watermark-transparent').checked = !!state.watermarkTransparent;
      $('model').value = state.model || 'auto';
    },
    renderCandidates(hits) {
      const t = $('thumbs');
      t.innerHTML = '';
      hits.forEach((h, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'thumb' + (i === 0 ? ' active' : '');
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 64, 64);
        ctx.strokeStyle = '#7c9cff'; ctx.lineWidth = 2;
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
