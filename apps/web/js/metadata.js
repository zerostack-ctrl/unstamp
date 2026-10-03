export async function stripMetadata(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) return new Blob([stripJpeg(buf)], { type: 'image/jpeg' });
    if (buf[0] === 0x89 && buf[1] === 0x50) return new Blob([stripPng(buf)], { type: 'image/png' });
    if (buf[0] === 0x52 && buf[1] === 0x49) return new Blob([stripWebp(buf)], { type: 'image/webp' });
  } catch (e) { console.warn('metadata strip failed', e); }
  return file;
}

function stripJpeg(buf) {
  const out = [buf[0], buf[1]];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { out.push(buf[i++]); continue; }
    const m = buf[i + 1];
    if (m === 0xda) { out.push(...buf.slice(i)); break; }
    if (m === 0xd9) { out.push(buf[i], buf[i + 1]); break; }
    if (m >= 0xd0 && m <= 0xd7) { out.push(buf[i], buf[i + 1]); i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    const seg = buf.slice(i + 4, i + 2 + len);
    const drop =
      (m === 0xe1 && (startsWith(seg, 'Exif') || startsWith(seg, 'http://ns.adobe.com/xap'))) ||
      (m === 0xeb && startsWith(seg, 'c2pa')) ||
      m === 0xed || m === 0xee || m === 0xfe;
    if (!drop) out.push(...buf.slice(i, i + 2 + len));
    i += 2 + len;
  }
  return new Uint8Array(out);
}

function stripPng(buf) {
  const out = [137, 80, 78, 71, 13, 10, 26, 10];
  let i = 8;
  const DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);
  while (i + 12 <= buf.length) {
    const len = (buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3];
    const type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
    const end = i + 12 + len;
    if (end > buf.length) break;
    if (!DROP.has(type)) out.push(...buf.slice(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return new Uint8Array(out);
}

function stripWebp(buf) {
  const out = [...buf.slice(0, 12)];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    const size = buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
    const pad = size & 1;
    const end = i + 8 + size + pad;
    if (end > buf.length) break;
    if (type !== 'EXIF' && type !== 'XMP ') out.push(...buf.slice(i, end));
    i = end;
  }
  const u8 = new Uint8Array(out);
  new DataView(u8.buffer).setUint32(4, u8.length - 8, true);
  return u8;
}

const startsWith = (u8, s) => {
  if (u8.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (u8[i] !== s.charCodeAt(i)) return false;
  return true;
};
