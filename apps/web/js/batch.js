export async function runBatch(state) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    if (!confirm(`Process ${files.length} images? They will download as a ZIP.`)) return;

    const zip = new JSZip();
    for (const f of files) {
      try {
        const bitmap = await createImageBitmap(f);
        const c = document.createElement('canvas');
        c.width = bitmap.width;
        c.height = bitmap.height;
        c.getContext('2d').drawImage(bitmap, 0, 0);
        const id = c.getContext('2d').getImageData(0, 0, c.width, c.height);

        const { detectTextWatermark } = await import('./detect/text.js');
        const { detectGeneric } = await import('./detect/generic.js');
        const { alphaInvert } = await import('./inpaint/alpha-invert.js');

        const hits = state.watermarkText
          ? detectTextWatermark(id, state.watermarkText, {
              angle: state.watermarkAngleAuto ? null : state.watermarkAngle,
              outline: state.watermarkOutline,
            })
          : detectGeneric(id);

        if (!hits[0]) { console.warn('no watermark in', f.name); continue; }

        const mask = new Float32Array(c.width * c.height);
        for (const h of hits.slice(0, 1)) {
          for (let j = 0; j < h.height; j++) {
            for (let i = 0; i < h.width; i++) {
              const px = h.x + i;
              const py = h.y + j;
              if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
              mask[py * c.width + px] = 1;
            }
          }
        }

        const out = alphaInvert(id, mask);
        const oc = document.createElement('canvas');
        oc.width = out.width;
        oc.height = out.height;
        oc.getContext('2d').putImageData(out, 0, 0);
        const blob = await new Promise((r) => oc.toBlob(r, 'image/png'));
        zip.file(f.name.replace(/\.[^.]+$/, '') + '_unstamped.png', blob);
      } catch (e) {
        console.error('batch failed for', f.name, e);
      }
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'unstamp-batch.zip';
    a.click();
    URL.revokeObjectURL(url);
  };
  input.click();
}
