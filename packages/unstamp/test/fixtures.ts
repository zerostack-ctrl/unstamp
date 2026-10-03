export function makeImage(w: number, h: number, fill = 0): Float32Array {
  const out = new Float32Array(w * h);
  out.fill(fill);
  return out;
}

export function placeText(
  img: Float32Array, iw: number,
  tpl: Float32Array, tw: number, th: number,
  x: number, y: number,
): void {
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      img[(y + j) * iw + (x + i)] = tpl[j * tw + i]!;
    }
  }
}
