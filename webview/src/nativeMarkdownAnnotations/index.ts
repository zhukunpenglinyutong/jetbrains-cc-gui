import { capturePreviewSelection, findSourceElement, positionAttribute, quoteRects } from './selection';
import type { PreviewSelection } from './selection';
import { previewLabels } from './labels';
import { createMermaidAdapter } from './mermaid';
import type { DiagramRange } from './mermaid';
import './theme.less';
import './style.css';

interface Annotation {
  completed?: boolean; sourceMissing?: boolean; id: string; revision: number; selectedText: string; comment: string;
  start: number; end: number; status: string; precision: string; anchorText?: string;
}
interface NativeState {
  panelId: string; documentVersion: number; dirty: boolean; path: string; annotations: Annotation[];
  enabled?: boolean;
  diagrams?: DiagramRange[];
  language?: string;
  submitShortcut?: 'enter' | 'ctrlEnter';
}
interface NativePipe {
  post(type: string, data: string): void;
  subscribe(type: string, callback: (data: string) => void): void;
}
interface NativeWindow extends Window {
  __IntelliJTools?: { messagePipe?: NativePipe };
  IncrementalDOM?: { notifications?: { afterPatchListeners?: Array<() => void> } };
  __ccguiMarkdownReview?: boolean;
}

const nativeWindow = window as NativeWindow;
let labels = previewLabels(navigator.language);

function start(pipe: NativePipe) {
  let state: NativeState | null = null;
  let selection: PreviewSelection | null = null;
  let selectionVersion: number | null = null;
  let activeComment: Annotation | null = null;
  let editing = false;
  let showAllComments = false;
  let showCompleted = false;
  let relocating: Annotation | null = null;
  let popupPosition: { left: number; top: number } | null = null;
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  let composing = false;
  let requestCounter = 0;
  let frame = 0;
  let pending = false;
  let message = '';
  let draft = '';
  let root: HTMLElement | null = null;
  const adaptMermaid = createMermaidAdapter(() => scheduleRender(), () => state?.enabled !== false);
  const callbacks = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  const container = document.createElement('div');
  container.id = 'ccgui-markdown-review';
  container.setAttribute('aria-label', labels.title);
  const themeLayer = document.createElement('div');
  themeLayer.className = 'ccgui-md-theme';
  container.append(themeLayer);
  const highlights = document.createElement('div');
  highlights.className = 'ccgui-md-highlights';
  const controls = document.createElement('div');
  controls.className = 'ccgui-md-controls';
  const popup = document.createElement('div');
  popup.className = 'ccgui-md-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', labels.title);
  popup.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !(event.target as Element).closest('.ccgui-md-popup-title')
      || (event.target as Element).closest('button')) return;
    const rect = popup.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    popup.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  popup.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    popupPosition = { left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y };
    position(popup, popupPosition.left, popupPosition.top - 6);
  });
  const endDrag = () => { drag = null; };
  popup.addEventListener('pointerup', endDrag);
  popup.addEventListener('pointercancel', endDrag);
  popup.addEventListener('lostpointercapture', endDrag);
  const toolbar = document.createElement('div');
  toolbar.className = 'ccgui-md-toolbar';
  toolbar.addEventListener('pointerdown', event => event.preventDefault());
  themeLayer.append(highlights, controls, popup, toolbar);

  let retry: { signature: string; requestId: string } | null = null;
  const send = (action: string, payload: object = {}) => new Promise<boolean>(resolve => {
    const signature = action + '|' + JSON.stringify(payload);
    // A retry of the timed-out intent reuses its id so the backend replays the
    // original result instead of duplicating the transfer (plan §5 idempotency).
    const requestId = retry?.signature === signature
      ? retry.requestId : 'md-' + Date.now() + '-' + requestCounter++;
    retry = null;
    const timer = setTimeout(() => {
      callbacks.delete(requestId);
      // Housekeeping requests are cheap to repeat; only user intents reuse the
      // id, since a cached replay of a sync would skip the real reconciliation.
      if (action !== 'ready' && action !== 'sync') retry = { signature, requestId };
      message = labels.timeout; pending = false; render();
      resolve(false);
    }, 8000);
    callbacks.set(requestId, { resolve, timer });
    pipe.post('ccgui.markdown.request', JSON.stringify({
      action, requestId, panelId: state?.panelId,
      documentVersion: state?.documentVersion,
      ...(['ready', 'sync'].includes(action) ? {
        renderedSourceLength: Number(/^0\.\.(\d+)$/.exec(root?.getAttribute(positionAttribute() ?? '') ?? '')?.[1] ?? -1),
      } : {}),
      ...payload,
    }));
  });

  /** Errors cross the bridge as keys (plan §7); the overlay owns the display language. */
  const translate = (key: unknown) => typeof key === 'string' && Object.hasOwn(labels, key)
    ? (labels as unknown as Record<string, string>)[key] : '';
  const describe = (response: { messageKey?: string; reasonKey?: string; message?: string }) => {
    const outcome = translate(response.messageKey) || response.message || '';
    const reason = translate(response.reasonKey);
    return reason ? (outcome ? outcome + ' ' + reason : reason) : outcome;
  };

  const button = (text: string, click: () => void, disabled = false, variant = 'secondary') => {
    const element = document.createElement('button');
    element.className = 'ccgui-md-button ' + variant;
    element.type = 'button'; element.textContent = text; element.disabled = disabled;
    element.addEventListener('click', event => { event.stopPropagation(); click(); });
    return element;
  };
  const commentIcon = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
    svg.append(path);
    return svg;
  };
  const position = (element: HTMLElement, left: number, top: number) => {
    element.style.left = Math.max(8, Math.min(left, innerWidth - Math.min(element.offsetWidth, innerWidth - 16) - 8)) + 'px';
    element.style.top = Math.max(8, Math.min(top + 6, innerHeight - Math.min(element.offsetHeight, innerHeight - 16) - 8)) + 'px';
  };
  const iconButton = (label: string, path: string, click: () => void, disabled = false, variant = 'secondary') => {
    const element = button('', click, disabled, variant);
    element.classList.add('ccgui-md-icon-button');
    element.title = label; element.setAttribute('aria-label', label);
    const svg = commentIcon(); svg.querySelector('path')!.setAttribute('d', path);
    const caption = document.createElement('span'); caption.className = 'ccgui-md-button-label'; caption.textContent = labels.send;
    element.append(svg);
    if (variant === 'primary') element.append(caption);
    return element;
  };

  function completionButton(annotation: Annotation) {
    return iconButton(annotation.completed ? labels.reopen : labels.complete, 'M5 12l4 4L19 6', () => {
      if (pending) return;
      pending = true;
      void send('complete', { id: annotation.id, revision: annotation.revision, completed: !annotation.completed })
        .then(() => { pending = false; render(); });
    }, pending);
  }

  const isLocatable = (annotation: Annotation) => !annotation.sourceMissing
    && (annotation.status === 'attached' || annotation.status === 'changed');
  const isTransferable = (annotation: Annotation) => !annotation.completed && !annotation.sourceMissing
    && (annotation.status === 'attached' || annotation.status === 'changed' || annotation.status === 'ambiguous');
  const statusText = (annotation: Annotation) => annotation.status === 'changed' ? labels.stale
    : annotation.status === 'ambiguous' ? labels.ambiguousStatus
    : annotation.status === 'orphaned' || annotation.sourceMissing ? labels.orphanedStatus : '';
  const startRelocate = (annotation: Annotation) => {
    if (pending) return;
    relocating = annotation; activeComment = null; editing = false; showAllComments = false;
    selection = null; popupPosition = null; message = ''; render();
  };

  function annotationActions(annotation: Annotation) {
    const actions = document.createElement('div'); actions.className = 'ccgui-md-actions ccgui-md-list-actions';
    actions.append(iconButton(labels.edit, 'M16 3l5 5-12 12-6 1 1-6zM14 5l5 5', () => {
      activeComment = annotation; showAllComments = false; editing = true; draft = annotation.comment;
      popup.replaceChildren(); render(); popup.querySelector('textarea')?.focus();
    }, pending));
    if (!isLocatable(annotation) || annotation.status === 'changed') {
      actions.append(iconButton(labels.relocate, 'M12 2v20M2 12h20', () => startRelocate(annotation), pending));
    }
    actions.append(iconButton(labels.remove, 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', () => {
      if (pending) return;
      pending = true;
      void send('delete', { id: annotation.id, revision: annotation.revision }).then(() => { pending = false; render(); });
    }, pending, 'danger'), completionButton(annotation));
    return actions;
  }

  function render() {
    labels = previewLabels(state?.language ?? navigator.language);
    container.lang = state?.language ?? navigator.language;
    container.setAttribute('aria-label', labels.title); popup.setAttribute('aria-label', labels.title);
    const attribute = positionAttribute();
    const nativeRoot = document.body.firstElementChild;
    root = attribute && nativeRoot instanceof HTMLElement && nativeRoot !== container
      && (nativeRoot.hasAttribute(attribute) || nativeRoot.querySelector('[' + attribute + ']')) ? nativeRoot : null;
    // Native preview CSS can establish a containing block on <body>. Keep the
    // viewport overlay outside it so native margins/transforms cannot offset it.
    if (!container.isConnected) document.documentElement.append(container);
    container.hidden = !state || state.enabled === false;
    if (state?.enabled === false) {
      selection = null; activeComment = null; editing = false; draft = ''; relocating = null;
      popup.replaceChildren(); highlights.replaceChildren();
      return;
    }
    if (root && attribute && !state?.dirty) adaptMermaid(root, attribute, state?.diagrams ?? []);
    const bodyStyle = getComputedStyle(document.body);
    const opaque = [bodyStyle.backgroundColor, getComputedStyle(document.documentElement).backgroundColor]
      .map(color => color.startsWith('rgb') ? color.match(/[\d.]+/g)?.map(Number) : undefined)
      .find(color => color && (color.length === 3 || color[3] > 0));
    const foreground = bodyStyle.color.match(/[\d.]+/g)?.map(Number);
    const brightness = (color: number[]) => color[0] * .299 + color[1] * .587 + color[2] * .114;
    const dark = opaque ? brightness(opaque) < 128 : foreground
      ? brightness(foreground) > 128 : matchMedia('(prefers-color-scheme: dark)').matches;
    themeLayer.dataset.theme = dark ? 'dark' : 'light';
    controls.replaceChildren();
    const all = (state?.annotations ?? []).filter(item => showCompleted || !item.completed);
    const locatable = all.filter(isLocatable);
    const pendingItems = all.filter(item => !item.completed && statusText(item) !== '');
    if (activeComment && !all.some(item => item.id === activeComment?.id)) { activeComment = null; editing = false; popup.replaceChildren(); }
    if (relocating) {
      const current = all.find(item => item.id === relocating?.id);
      if (!current) relocating = null; else relocating = current;
    }
    const count = all.length;
    const sendCount = all.filter(isTransferable).length;
    const countButton = button(count + ' ' + labels.comments, () => {
      selection = null; activeComment = null; editing = false; showAllComments = !showAllComments; popupPosition = null; render();
    });
    countButton.prepend(commentIcon());
    controls.append(countButton);
    if (pendingItems.length) {
      controls.append(button(pendingItems.length + ' ' + labels.pending, () => {
        selection = null; activeComment = null; editing = false; showAllComments = true; popupPosition = null; render();
      }, false, 'danger'));
    }
    controls.append(iconButton(labels.transfer, 'M22 2L9 15M22 2l-7 20-4-9-9-4z', () => {
      pending = true; message = ''; render();
      // Transfer exactly what the user sees; the explicit list also makes a
      // timed-out retry sign the same intent instead of a moving target.
      void send('transfer', {
        documentVersion: state?.documentVersion,
        annotationIds: all.filter(isTransferable).map(item => item.id),
      }).then(() => { pending = false; render(); });
    }, pending || !sendCount, 'primary'));
    const completedToggle = iconButton(showCompleted ? labels.hideCompleted : labels.showCompleted, 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0', () => { showCompleted = !showCompleted; render(); });
    completedToggle.setAttribute('aria-pressed', String(showCompleted));
    controls.append(completedToggle);
    if (relocating) {
      const status = document.createElement('span');
      status.className = 'ccgui-md-status'; status.setAttribute('role', 'status');
      status.textContent = message || labels.relocateHint;
      controls.append(status);
    } else if (state?.dirty || message) {
      const status = document.createElement('span');
      status.className = 'ccgui-md-status'; status.setAttribute('role', 'status');
      status.textContent = state?.dirty ? labels.waiting : message;
      controls.append(status);
    }

    toolbar.replaceChildren();
    toolbar.hidden = editing || showAllComments || (!!activeComment && !relocating) || !!state?.dirty || (!selection && !relocating);
    if (!toolbar.hidden) {
      if (relocating) {
        toolbar.append(button(labels.cancel, () => { relocating = null; selection = null; message = ''; render(); }),
          button(labels.relocateConfirm, () => {
            if (pending || !selection || !relocating) return;
            pending = true; message = '';
            const target = relocating;
            void send('anchor', { id: target.id, revision: target.revision, ...selection, documentVersion: selectionVersion }).then(ok => {
              pending = false;
              if (ok) { relocating = null; selection = null; close(); } else render();
            });
          }, !selection || pending, 'primary'));
        position(toolbar, selection?.left ?? 16, selection?.top ?? 80);
      } else if (selection) {
        toolbar.append(button(labels.comment, () => {
          draft = ''; editing = true; showAllComments = false; popupPosition = null; message = ''; render();
          popup.querySelector('textarea')?.focus();
        }), button(labels.quote, () => {
          if (pending || !selection) return;
          pending = true; message = ''; render();
          void send('quote', { ...selection, documentVersion: selectionVersion }).then(ok => {
            pending = false; if (ok) close(); else render();
          });
        }));
        position(toolbar, selection.left, selection.top);
      }
    }

    // Preserve the textarea node during status/geometry updates and IME composition.
    if (!editing || !popup.querySelector('textarea')) {
      popup.replaceChildren();
      popup.hidden = !editing && !activeComment && !showAllComments;
      popup.classList.toggle('ccgui-md-summary', showAllComments);
      if (!popup.hidden) {
        const heading = document.createElement('div');
        heading.className = 'ccgui-md-popup-title'; heading.textContent = labels.title;
        heading.prepend(commentIcon());
        const closeButton = iconButton(labels.close, 'M6 6l12 12M18 6L6 18', close);
        closeButton.classList.add('ccgui-md-popup-close');
        heading.append(closeButton);
        popup.append(heading);
        if (showAllComments) {
          const list = document.createElement('ul');
          list.className = 'ccgui-md-comment-list';
          for (const annotation of all) {
            const row = document.createElement('li');
            const entry = button('', () => {
              activeComment = annotation; showAllComments = false; popupPosition = null; render();
            });
            entry.setAttribute('aria-label', annotation.comment);
            const id = document.createElement('small'); id.textContent = '#' + annotation.id;
            const quote = document.createElement('span'); quote.className = 'ccgui-md-list-quote';
            quote.textContent = annotation.selectedText;
            const comment = document.createElement('span'); comment.className = 'ccgui-md-list-comment';
            comment.textContent = annotation.comment;
            entry.append(id, quote, comment);
            const badge = statusText(annotation);
            if (badge) {
              const state = document.createElement('small');
              state.className = 'ccgui-md-badge' + (annotation.status === 'changed' ? ' changed' : '');
              state.textContent = badge;
              entry.append(state);
            }
            row.classList.toggle('completed', !!annotation.completed);
            row.classList.toggle('stale', !isLocatable(annotation));
            row.append(entry, annotationActions(annotation)); list.append(row);
          }
          if (!count) {
            const empty = document.createElement('li'); empty.className = 'ccgui-md-list-empty';
            empty.textContent = '0 ' + labels.comments; list.append(empty);
          }
          popup.append(list);
        } else {
        const quote = document.createElement('blockquote');
        quote.textContent = activeComment?.selectedText ?? selection?.selectedText ?? '';
        popup.append(quote);
        if (editing) {
          const textarea = document.createElement('textarea');
          textarea.placeholder = labels.placeholder;
          textarea.setAttribute('aria-label', labels.placeholder);
          textarea.value = draft;
          textarea.addEventListener('input', () => { draft = textarea.value; });
          textarea.addEventListener('compositionstart', () => { composing = true; });
          textarea.addEventListener('compositionend', () => { composing = false; });
          textarea.addEventListener('keydown', event => {
            if (composing || event.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
            if (event.key !== 'Enter') return;
            event.stopPropagation();
            if (event.repeat) { event.preventDefault(); return; }
            const modified = event.ctrlKey || event.metaKey;
            const submit = !event.shiftKey && !event.altKey
              && (state?.submitShortcut === 'ctrlEnter' ? modified : !modified);
            if (submit) { event.preventDefault(); saveComment(); }
            else if (modified) {
              // Browsers do not insert a textarea newline for Ctrl+Enter.
              event.preventDefault();
              textarea.setRangeText('\n', textarea.selectionStart, textarea.selectionEnd, 'end');
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
          const actions = document.createElement('div'); actions.className = 'ccgui-md-actions';
          const saveComment = () => {
            if (pending || composing || !draft.trim()) return;
            pending = true;
            const operation = activeComment
              ? send('update', { id: activeComment.id, revision: activeComment.revision, comment: draft })
              : send('create', { ...selection, documentVersion: selectionVersion, comment: draft });
            void operation.then(ok => { pending = false; if (ok) close(); else render(); });
          };
          actions.append(button(labels.cancel, close), button(activeComment ? labels.save : labels.add, saveComment, false, 'primary'));
          popup.append(textarea, actions);
        } else if (activeComment) {
          const body = document.createElement('p'); body.textContent = activeComment.comment;
          const current = activeComment;
          const actions = document.createElement('div'); actions.className = 'ccgui-md-actions';
          actions.append(iconButton(labels.edit, 'M16 3l5 5-12 12-6 1 1-6zM14 5l5 5', () => {
            editing = true; draft = current.comment; popup.replaceChildren(); render(); popup.querySelector('textarea')?.focus();
          }));
          if (!isLocatable(current) || current.status === 'changed') {
            actions.append(iconButton(labels.relocate, 'M12 2v20M2 12h20', () => startRelocate(current), pending));
          }
          actions.append(iconButton(labels.remove, 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', () => {
            if (pending) return;
            pending = true;
            void send('delete', { id: current.id, revision: current.revision }).then(ok => {
              pending = false; if (ok) close(); else render();
            });
          }, false, 'danger'), iconButton(labels.source, 'M14 2H6v20h12V6zM14 2v6h4M9 12h6M9 16h6',
          () => { void send('navigate', { id: current.id }); }, !isLocatable(current)),
          iconButton(labels.transferOne, 'M22 2L9 15M22 2l-7 20-4-9-9-4z', () => {
            if (pending) return;
            pending = true;
            void send('transfer', { annotationIds: [current.id], documentVersion: state?.documentVersion }).then(() => { pending = false; render(); });
          }, !isTransferable(current), 'primary'));
          actions.append(completionButton(current));
          popup.append(body, actions);
          const badge = statusText(current);
          if (badge) {
            const status = document.createElement('p'); status.className = 'ccgui-md-badge'; status.textContent = badge;
            popup.append(status);
          }
        }
        }
      }
    }
    if (!popup.hidden) {
      const textarea = popup.querySelector('textarea');
      if (textarea) { textarea.placeholder = labels.placeholder; textarea.setAttribute('aria-label', labels.placeholder); }
      const anchor = activeComment && root && isLocatable(activeComment)
        ? findSourceElement(root, activeComment.start, activeComment.end) : null;
      const rect = anchor?.getBoundingClientRect();
      const summaryAnchor = showAllComments ? controls.getBoundingClientRect() : null;
      position(popup, popupPosition?.left ?? (summaryAnchor ? summaryAnchor.right - popup.offsetWidth : rect?.left ?? selection?.left ?? 16),
        popupPosition ? popupPosition.top - 6 : summaryAnchor ? summaryAnchor.top - popup.offsetHeight - 12 : rect?.bottom ?? selection?.top ?? 60);
    }
    highlights.replaceChildren();
    const markerTops: number[] = [];
    if (root && !state?.dirty) {
      for (const annotation of locatable) {
        const element = findSourceElement(root, annotation.start, annotation.end);
        if (!element) continue;
        const bounds = element.getBoundingClientRect();
        if (bounds.bottom < 0 || bounds.top > innerHeight) continue;
        const mark = button('', () => {
          selection = null; activeComment = annotation; editing = false; showAllComments = false; popupPosition = null; message = ''; render();
        });
        mark.append(commentIcon());
        mark.className = 'ccgui-md-marker' + (annotation.status === 'changed' ? ' changed' : '');
        mark.title = annotation.comment;
        mark.setAttribute('aria-label', annotation.comment);
        mark.style.left = Math.max(0, Math.min(innerWidth - 34, bounds.right)) + 'px';
        const quoteText = annotation.status === 'changed' ? (annotation.anchorText ?? annotation.selectedText) : annotation.selectedText;
        const rectangles = quoteRects(element, quoteText);
        let markerTop = Math.max(0, rectangles[0]?.top ?? bounds.top);
        while (markerTops.some(top => Math.abs(top - markerTop) < 30)) markerTop += 30;
        markerTops.push(markerTop);
        mark.style.top = markerTop + 'px';
        highlights.append(mark);
        for (const rect of rectangles.length ? rectangles : [bounds]) {
          const highlight = document.createElement('div');
          highlight.className = 'ccgui-md-highlight' + (annotation.status === 'changed' ? ' changed' : '');
          Object.assign(highlight.style, {
            left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px',
          });
          highlights.append(highlight);
        }
      }
    }
  }

  function close() {
    editing = false; composing = false; activeComment = null; selection = null; popupPosition = null; showAllComments = false;
    relocating = null; draft = ''; popup.replaceChildren(); render();
  }
  const scheduleRender = () => {
    if (drag) return;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  };
  pipe.subscribe('ccgui.markdown.response', raw => {
    try {
      const response = JSON.parse(raw);
      if (response.kind === 'state') {
        const previous = state;
        // A "behind" frame omits annotations/diagrams; keep the last full view
        // so the comment count and markers do not flicker while typing.
        state = {
          ...(previous ?? {}),
          ...response,
          annotations: response.annotations ?? previous?.annotations ?? [],
        } as NativeState;
        if (activeComment) {
          const current = state?.annotations.find(item => item.id === activeComment?.id);
          if (!current) {
            activeComment = null; selection = null; editing = false; draft = '';
            popup.replaceChildren();
          } else if (!editing) activeComment = current;
        }
        if (relocating) {
          relocating = state?.annotations.find(item => item.id === relocating?.id) ?? null;
        }
        render();
        return;
      }
      const callback = callbacks.get(response.requestId);
      if (!callback) return;
      if (response.status === 'processing') {
        // An interactive step (the chat chooser) is open; the fixed bound would
        // report a false failure, so wait on a safety bound instead.
        clearTimeout(callback.timer);
        callback.timer = setTimeout(() => {
          callbacks.delete(response.requestId);
          retry = null;
          message = labels.timeout; pending = false; render(); callback.resolve(false);
        }, 5 * 60_000);
        message = describe(response); render();
        return;
      }
      clearTimeout(callback.timer); callbacks.delete(response.requestId);
      message = describe(response);
      callback.resolve(response.status === 'ok');
      render();
    } catch { message = labels.failed; render(); }
  });
  document.addEventListener('selectionchange', () => {
    if (editing || pending || !state || state.enabled === false || state.dirty || !root) return;
    const next = capturePreviewSelection(root);
    if (next) { selection = next; selectionVersion = state.documentVersion; activeComment = null; }
    else if (!container.contains(document.activeElement)) selection = null;
    render();
  });
  window.addEventListener('scroll', scheduleRender, { passive: true });
  document.addEventListener('scroll', scheduleRender, { passive: true, capture: true });
  window.addEventListener('resize', scheduleRender);
  const afterPatch = () => {
    if (!editing) selection = null;
    render();
    void send('sync');
  };
  nativeWindow.IncrementalDOM?.notifications?.afterPatchListeners?.push(afterPatch);
  // Mermaid renders asynchronously after the native Markdown patch.
  new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true });
  // The native host owns listener disposal by destroying this page.
  render();
  void send('ready');
  window.addEventListener('IdeReady', () => { void send('ready'); });
}

if (!nativeWindow.__ccguiMarkdownReview) {
  nativeWindow.__ccguiMarkdownReview = true;
  if (nativeWindow.__IntelliJTools?.messagePipe) start(nativeWindow.__IntelliJTools.messagePipe);
  else window.addEventListener('IdeReady', () => {
    if (nativeWindow.__IntelliJTools?.messagePipe) start(nativeWindow.__IntelliJTools.messagePipe);
  }, { once: true });
}
