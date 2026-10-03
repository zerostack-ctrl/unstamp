export class CompareSlider {
  constructor(el) { this.el = el; this.pos = 50; }

  show(beforeBitmap, afterData) {
    this.el.hidden = false;
    this.before = beforeBitmap;
    this.after = afterData;
    this.render();
  }

  render() {
    this.el.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    const after = document.createElement('canvas');
    after.width = this.after.width;
    after.height = this.after.height;
    after.getContext('2d').putImageData(this.after, 0, 0);
    after.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:contain;clip-path:inset(0 0 0 ${this.pos}%)`;
    const before = document.createElement('canvas');
    before.width = this.before.width;
    before.height = this.before.height;
    before.getContext('2d').drawImage(this.before, 0, 0);
    before.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:contain;clip-path:inset(0 ${100 - this.pos}% 0 0)`;
    const handle = document.createElement('div');
    handle.style.cssText = `position:absolute;top:0;bottom:0;left:${this.pos}%;width:2px;background:var(--accent);pointer-events:auto;cursor:ew-resize`;
    wrap.append(before, after, handle);
    this.el.appendChild(wrap);
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => {
        const r = this.el.getBoundingClientRect();
        this.pos = Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100));
        after.style.clipPath = `inset(0 0 0 ${this.pos}%)`;
        before.style.clipPath = `inset(0 ${100 - this.pos}% 0 0)`;
        handle.style.left = `${this.pos}%`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}
