export class MaskEditor {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.tool = 'brush';
    this.brushSize = 40;
    this.undoStack = [];
    this.redoStack = [];
    this.drawing = false;
    this.mask = null;
    this.enabled = false;
  }

  reset(W, H) {
    this.overlay.width = W;
    this.overlay.height = H;
    this.mask = new Float32Array(W * H);
    this.undoStack = [];
    this.redoStack = [];
    this.enabled = true;
    this.render();
  }

  disable() {
    this.enabled = false;
    this.mask = null;
    // Clear the overlay
    this.ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  pushUndo() {
    if (!this.mask) return;
    this.undoStack.push(new Float32Array(this.mask));
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.mask || !this.undoStack.length) return;
    this.redoStack.push(new Float32Array(this.mask));
    this.mask = this.undoStack.pop();
    this.render();
  }

  redo() {
    if (!this.mask || !this.redoStack.length) return;
    this.undoStack.push(new Float32Array(this.mask));
    this.mask = this.redoStack.pop();
    this.render();
  }

  clear() {
    if (!this.mask) return;
    this.pushUndo();
    this.mask.fill(0);
    this.render();
  }

  loadMaskFromHit(hit) {
    if (!this.mask) return;
    this.pushUndo();
    const { x, y, width, height, angle } = hit;
    const W = this.overlay.width;
    const H = this.overlay.height;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const a = (-angle * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const rad = Math.max(width, height) * 0.75;
    const x0 = Math.max(0, Math.floor(cx - rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const x1 = Math.min(W, Math.ceil(cx + rad));
    const y1 = Math.min(H, Math.ceil(cy + rad));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const dx = px - cx;
        const dy = py - cy;
        const rx = dx * cos - dy * sin;
        const ry = dx * sin + dy * cos;
        if (Math.abs(rx) <= width / 2 + 3 && Math.abs(ry) <= height / 2 + 3) {
          this.mask[py * W + px] = 1;
        }
      }
    }
    this.render();
  }

  paint(x, y, radius, value) {
    if (!this.mask) return;                  // ← the fix
    const W = this.overlay.width;
    const H = this.overlay.height;
    const r2 = radius * radius;
    for (let j = -radius; j <= radius; j++) {
      for (let i = -radius; i <= radius; i++) {
        const d2 = i * i + j * j;
        if (d2 > r2) continue;
        const px = x + i;
        const py = y + j;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const k = py * W + px;
        const falloff = 1 - Math.sqrt(d2) / radius;
        this.mask[k] = Math.max(0, Math.min(1, this.mask[k] * (1 - value * falloff) + value * falloff));
      }
    }
  }

  render() {
    if (!this.mask) return;                  // ← the fix
    const W = this.overlay.width;
    const H = this.overlay.height;
    const img = this.ctx.createImageData(W, H);
    for (let i = 0; i < this.mask.length; i++) {
      const j = i * 4;
      img.data[j] = 255;
      img.data[j + 1] = 60;
      img.data[j + 2] = 60;
      img.data[j + 3] = Math.min(255, this.mask[i] * 128);
    }
    this.ctx.putImageData(img, 0, 0);
  }

  toMask() {
    return this.mask;
  }

  bind() {
    const pt = (e) => {
      const r = this.overlay.getBoundingClientRect();
      const x = (e.clientX - r.left) * (this.overlay.width / r.width);
      const y = (e.clientY - r.top) * (this.overlay.height / r.height);
      return [Math.round(x), Math.round(y)];
    };

    // Only paint when we have a real mask and the editor is enabled
    const guard = () => this.enabled && this.mask != null;

    this.overlay.addEventListener('pointerdown', (e) => {
      if (!guard()) return;
      this.drawing = true;
      this.pushUndo();
      const [x, y] = pt(e);
      const v = this.tool === 'eraser' ? 0 : 1;
      this.paint(x, y, this.brushSize / 2, v);
      this.render();
    });

    this.overlay.addEventListener('pointermove', (e) => {
      if (!guard() || !this.drawing) return;
      const [x, y] = pt(e);
      const v = this.tool === 'eraser' ? 0 : 1;
      this.paint(x, y, this.brushSize / 2, v);
      this.render();
    });

    window.addEventListener('pointerup', () => { this.drawing = false; });
  }
}