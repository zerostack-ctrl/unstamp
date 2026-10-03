export function bindShortcuts({ onDetect, onRemove, maskEditor, palette }) {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); palette.open(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); maskEditor.undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); maskEditor.redo(); }
    if (e.key === 'd') onDetect();
    if (e.key === 'r') onRemove();
  });
}
