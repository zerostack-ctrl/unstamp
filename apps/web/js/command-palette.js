export class CommandPalette {
  constructor(dialog) {
    this.dlg = dialog;
    this.input = dialog.querySelector('#palette-input');
    this.list = dialog.querySelector('#palette-list');
    this.commands = [];
    this.matches = [];
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    dialog.addEventListener('click', (e) => { if (e.target === dialog) this.close(); });
  }

  register(cmds) { this.commands = cmds; }

  open() {
    this.dlg.showModal();
    this.input.value = '';
    this.render();
    this.input.focus();
  }

  close() { this.dlg.close(); }

  render() {
    const q = this.input.value.toLowerCase();
    this.matches = this.commands.filter((c) => c.label.toLowerCase().includes(q));
    this.list.innerHTML = this.matches
      .map((c, i) => `<li data-i="${i}" class="${i === 0 ? 'active' : ''}">${c.label}<span>${c.hint || ''}</span></li>`)
      .join('');
    this.list.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => { this.matches[+li.dataset.i].run(); this.close(); });
    });
  }

  onKey(e) {
    if (e.key === 'Escape') return this.close();
    if (e.key === 'Enter' && this.matches[0]) { this.matches[0].run(); this.close(); }
  }
}
