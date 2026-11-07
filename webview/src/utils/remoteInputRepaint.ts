let installed: { stop: () => void; request: () => void } | undefined;

/**
 * Remote JCEF can retain deleted glyphs even after its editor DOM is empty.
 * Damage the editor's pixels on editing events without rebuilding its caret/IME geometry.
 */
export function installRemoteInputRepaint(): () => void {
  if (installed) {
    installed.request();
    return installed.stop;
  }

  let frame: number | undefined;
  let fallback: number | undefined;
  let restoreBackground: (() => void) | undefined;
  let stopped = false;

  const activeEditor = () => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.matches('.input-editable') ? el : null;
  };
  const clearPaint = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (fallback !== undefined) window.clearTimeout(fallback);
    frame = fallback = undefined;
    restoreBackground?.();
    restoreBackground = undefined;
  };
  const request = () => {
    if (frame !== undefined || document.hidden || !activeEditor()) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const editor = activeEditor();
      if (!editor || document.hidden) return;
      const computed = getComputedStyle(editor);
      const original = editor.style.getPropertyValue('background-color');
      const priority = editor.style.getPropertyPriority('background-color');
      // Repaint the editor's own backing, rather than compositing over a potentially
      // stale texture. A small foreground mix changes pixels in either theme.
      editor.style.setProperty('background-color',
        `color-mix(in srgb, ${computed.backgroundColor} 98%, ${computed.color})`, 'important');
      const owned = editor.style.getPropertyValue('background-color');
      restoreBackground = () => {
        // A theme/extension update may supersede this pulse before the next frame.
        if (editor.style.getPropertyValue('background-color') !== owned
            || editor.style.getPropertyPriority('background-color') !== 'important') return;
        if (original) editor.style.setProperty('background-color', original, priority);
        else editor.style.removeProperty('background-color');
      };
      frame = requestAnimationFrame(clearPaint);
      // A hidden renderer may suspend rAF; always release the temporary background.
      fallback = window.setTimeout(clearPaint, 150);
    });
  };
  const onEdit = (event: Event) => {
    const editor = activeEditor();
    if (editor && event.target instanceof Node && editor.contains(event.target)) request();
  };
  const onSelection = () => {
    const editor = activeEditor();
    const selection = getSelection();
    if (editor && selection?.anchorNode && editor.contains(selection.anchorNode)) request();
  };
  const onVisibility = () => {
    if (document.hidden) {
      clearPaint();
    } else request();
  };
  const events = ['input', 'compositionupdate', 'compositionend', 'focusin'];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearPaint();
    for (const event of events) document.removeEventListener(event, onEdit);
    document.removeEventListener('selectionchange', onSelection);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', stop);
    installed = undefined;
  };
  for (const event of events) document.addEventListener(event, onEdit, { passive: true });
  document.addEventListener('selectionchange', onSelection, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', stop, { once: true });
  installed = { stop, request };
  request();
  return stop;
}
