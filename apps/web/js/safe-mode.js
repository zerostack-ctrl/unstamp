export async function detectFaces(bitmap) {
  if (!('FaceDetector' in window)) return [];
  try {
    const fd = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
    const faces = await fd.detect(bitmap);
    return faces.map((f) => ({
      x: f.boundingBox.x,
      y: f.boundingBox.y,
      width: f.boundingBox.width,
      height: f.boundingBox.height,
      padding: Math.max(f.boundingBox.width, f.boundingBox.height) * 0.3,
    }));
  } catch { return []; }
}

export function carveOut(mask, W, H, regions) {
  for (const r of regions) {
    const x0 = Math.max(0, r.x - r.padding);
    const y0 = Math.max(0, r.y - r.padding);
    const x1 = Math.min(W, r.x + r.width + r.padding);
    const y1 = Math.min(H, r.y + r.height + r.padding);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = 0;
  }
}
