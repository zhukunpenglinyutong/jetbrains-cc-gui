import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment } from '../types.js';
import { generateId } from '../utils/generateId.js';
import { createImagePasteDedupe, type ImagePasteSource } from '../utils/imagePasteDedupe.js';
import { insertTextAtCursor } from '../utils/selectionUtils.js';
import {
  parseExplicitFileReferences,
  registerAbsoluteFileReference,
  registerLineFileReference,
} from '../utils/fileReferences.js';
import { perfTimer } from '../../../utils/debug.js';
import { sendBridgeEvent } from '../../../utils/bridge.js';
import { BRIDGE_READY_EVENT } from '../../../utils/bridgeStartup.js';

declare global {
  interface Window {
    getClipboardFilePath?: () => Promise<string>;
  }
}

interface UsePasteAndDropOptions {
  editableRef: React.RefObject<HTMLDivElement | null>;
  pathMappingRef: React.MutableRefObject<Map<string, string>>;
  getTextContent: () => string;
  adjustHeight: () => void;
  renderFileTags: () => void;
  setHasContent: (hasContent: boolean) => void;
  setInternalAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  /** Pending images belong to this session, not just to the mounted input box. */
  currentSessionId?: string | null;
  onInput?: (content: string) => void;
  closeAllCompletions: () => void;
  handleInput: (inputType?: string) => void;
  /** Immediately flush pending debounced onInput to sync parent state */
  flushInput: () => void;
}

interface UsePasteAndDropReturn {
  /** Handle paste event - detect images and plain text */
  handlePaste: (e: React.ClipboardEvent) => void;
  /** Handle drag over event */
  handleDragOver: (e: React.DragEvent) => void;
  /** Handle drop event - detect images and file paths */
  handleDrop: (e: React.DragEvent) => void;
  /** Keep submit controls closed until image reads and comparisons settle. */
  isPreparingImages: boolean;
  /** Synchronous guard also covers a submit before React publishes the pending state. */
  hasPendingImagePastes: () => boolean;
  /** A submitted or replaced draft must forget old work and clipboard replay history. */
  invalidateImagePastes: () => void;
}

interface ImagePasteScope {
  dedupe: ReturnType<typeof createImagePasteDedupe>;
  pending: number;
  publication: number;
  processing: Promise<void>;
}

const NATIVE_IMAGE_TIMEOUT_MS = 30000;

/**
 * usePasteAndDrop - Handle paste and drag-drop operations
 *
 * Features:
 * - Paste images as attachments (Base64 encoded)
 * - Paste text including file paths
 * - Drag and drop files/images
 * - Auto-create file references from dropped paths
 */
export function usePasteAndDrop({
  editableRef,
  pathMappingRef,
  getTextContent,
  adjustHeight,
  renderFileTags,
  setHasContent,
  setInternalAttachments,
  currentSessionId = null,
  onInput,
  closeAllCompletions,
  handleInput,
  flushInput,
}: UsePasteAndDropOptions): UsePasteAndDropReturn {
  /**
   * One keystroke can deliver the same clipboard image twice (webview paste
   * event and a Java producer); only the first delivery becomes an attachment.
   */
  // Lazy per-draft state avoids rebuilding the dedupe cache on every input render.
  const pasteScopeRef = useRef<ImagePasteScope | null>(null);
  const nativeRequestsRef = useRef(new Map<string, (attachment: Attachment | null) => void>());
  const mountedRef = useRef(false);
  const draftScopeIdRef = useRef<string | null>(null);
  const publicationSequenceRef = useRef(0);
  const committedPublicationRef = useRef(0);
  const [publication, setPublication] = useState(0);
  const [isPreparingImages, setIsPreparingImages] = useState(false);

  const publishImageScope = useCallback(() => {
    sendBridgeEvent('paste_image_scope', draftScopeIdRef.current ?? '');
  }, []);

  const invalidateImagePastes = useCallback(() => {
    pasteScopeRef.current = null;
    for (const finish of nativeRequestsRef.current.values()) finish(null);
    nativeRequestsRef.current.clear();
    // Native gestures bind to this id before their queued offer can reach a replacement draft.
    draftScopeIdRef.current = mountedRef.current ? generateId() : null;
    publishImageScope();
    if (mountedRef.current) {
      setIsPreparingImages(false);
    }
  }, [publishImageScope]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    window.addEventListener(BRIDGE_READY_EVENT, publishImageScope);
    invalidateImagePastes();
    return () => {
      mountedRef.current = false;
      window.removeEventListener(BRIDGE_READY_EVENT, publishImageScope);
      invalidateImagePastes();
    };
  }, [currentSessionId, invalidateImagePastes, publishImageScope]);

  const hasPendingImagePastes = useCallback(() => {
    const scope = pasteScopeRef.current;
    return !!scope && (scope.pending > 0 || scope.publication > committedPublicationRef.current);
  }, []);

  useLayoutEffect(() => {
    // This state update shares the attachment update's batch; a native submit cannot observe readiness first.
    committedPublicationRef.current = publication;
    if (mountedRef.current) setIsPreparingImages(hasPendingImagePastes());
  }, [publication, hasPendingImagePastes]);

  const queuePastedImage = useCallback((prepare: () => Promise<Attachment | null>, source: ImagePasteSource | null) => {
    if (!mountedRef.current) return;
    const scope = pasteScopeRef.current ??= {
      dedupe: createImagePasteDedupe(), pending: 0, publication: 0, processing: Promise.resolve(),
    };
    const arrivedAt = Date.now();
    // Capture ownership before FileReader starts, not after its callback or pixel decoding finishes.
    scope.pending++;
    setIsPreparingImages(true);
    // Start independent reads immediately, but commit their decisions in gesture order.
    // Attach the rejection handler now so a later read cannot reject unobserved while waiting its turn.
    const prepared = (() => {
      try {
        return prepare().catch((error) => {
          console.warn('Failed to prepare clipboard image', error);
          return null;
        });
      } catch (error) {
        console.warn('Failed to prepare clipboard image', error);
        return Promise.resolve(null);
      }
    })();
    scope.processing = scope.processing.then(async () => {
      try {
        const attachment = await prepared;
        if (!attachment || !mountedRef.current || pasteScopeRef.current !== scope) return;
        const accepted = source === null || await scope.dedupe.isNewPaste(attachment, source, arrivedAt);
        if (accepted && mountedRef.current && pasteScopeRef.current === scope) {
          scope.publication = ++publicationSequenceRef.current;
          setInternalAttachments((prev) => pasteScopeRef.current === scope ? [...prev, attachment] : prev);
          setPublication(scope.publication);
        }
      } catch (error) {
        console.warn('Failed to prepare clipboard image', error);
      } finally {
        scope.pending--;
        if (mountedRef.current && pasteScopeRef.current === scope) {
          setIsPreparingImages(hasPendingImagePastes());
        }
      }
    });
  }, [setInternalAttachments, hasPendingImagePastes]);

  const requestNativeImage = useCallback((snapshotId?: string) => {
    queuePastedImage(() => new Promise<Attachment | null>((resolve) => {
      const requestId = generateId();
      const finish = (attachment: Attachment | null) => {
        clearTimeout(timeout);
        nativeRequestsRef.current.delete(requestId);
        resolve(attachment);
      };
      // Lost bridge replies must release the draft without accepting a later, obsolete image.
      const timeout = setTimeout(() => finish(null), NATIVE_IMAGE_TIMEOUT_MS);
      nativeRequestsRef.current.set(requestId, finish);
      // Native actions already captured the clipboard; claiming that snapshot must not reread newer contents.
      const request = snapshotId ? JSON.stringify({ requestId, snapshotId, scopeId: draftScopeIdRef.current }) : requestId;
      if (!sendBridgeEvent('paste_image', request)) finish(null);
    }), 'java-bridge');
  }, [queuePastedImage]);

  /**
   * Handle paste event - detect images and plain text
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;

      if (!items || items.length === 0) {
        // JCEF may have intercepted the paste event; ask Java side to check clipboard for images
        e.preventDefault();
        requestNativeImage();
        return;
      }

      // Check if there's a real image (type is image/*)
      let hasImage = false;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Only process real image types (type starts with image/)
        if (item.type.startsWith('image/')) {
          hasImage = true;
          e.preventDefault();

          const blob = item.getAsFile();

          if (blob) {
            queuePastedImage(() => new Promise<Attachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error ?? new Error('Image read failed'));
              reader.onabort = () => reject(new Error('Image read aborted'));
              reader.onload = () => {
                const base64 = (reader.result as string).split(',')[1];
                const mediaType = blob.type || item.type || 'image/png';
                const ext = (() => {
                  if (mediaType && mediaType.includes('/')) {
                    return mediaType.split('/')[1];
                  }
                  const name = blob.name || '';
                  const m = name.match(/\.([a-zA-Z0-9]+)$/);
                  return m ? m[1] : 'png';
                })();
                resolve({
                  id: generateId(),
                  fileName: `pasted-image-${Date.now()}.${ext}`,
                  mediaType,
                  data: base64,
                });
              };
              reader.readAsDataURL(blob);
            }), 'dom-paste');
          }

          return;
        }
      }

      // If no image, try to get text or file path
      if (!hasImage) {
        e.preventDefault();

        // Try multiple ways to get text
        let text =
          e.clipboardData.getData('text/plain') ||
          e.clipboardData.getData('text/uri-list') ||
          e.clipboardData.getData('text/html');

        // If still no text, try to get filename/path from file type item
        if (!text) {
          // Check if there's a file type item
          let hasFileItem = false;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
              hasFileItem = true;
              break;
            }
          }

          // If there's a file type item, try to get full path via Java side
          if (hasFileItem && window.getClipboardFilePath) {
            window
              .getClipboardFilePath()
              .then((fullPath: string) => {
                if (fullPath && fullPath.trim()) {
                  const registeredPath = registerAbsoluteFileReference(
                    pathMappingRef.current,
                    fullPath,
                  );
                  // A real clipboard file is structured input from Java, so it
                  // can safely become a file reference without text guessing.
                  insertTextAtCursor(
                    registeredPath ? `@${registeredPath} ` : fullPath,
                    editableRef.current,
                  );
                  // Bypass IME guard (isComposingRef may be stale after recent compositionEnd)
                  handleInput();
                  // Immediately sync parent state without waiting for debounce
                  flushInput();
                  if (registeredPath) {
                    requestAnimationFrame(() => renderFileTags());
                  }
                }
              })
              .catch(() => {
                // Ignore errors
              });
            return;
          }
        }

        if (text && text.trim()) {
          const timer = perfTimer('handlePaste-text');
          timer.mark(`text-length:${text.length}`);

          // Only an entire, explicitly marked @ absolute-path payload is
          // promoted to file references. Mixed prose/code/email/annotation
          // text remains ordinary pasted text and never enters the mapping.
          const lineReference = registerLineFileReference(pathMappingRef.current, text);
          const explicitPaths = lineReference ? null : parseExplicitFileReferences(text);
          const registeredPaths = explicitPaths?.map((filePath) =>
            registerAbsoluteFileReference(pathMappingRef.current, filePath)
          );
          const normalizedFileReferenceText = lineReference
            ? `@${lineReference} `
            : registeredPaths &&
              registeredPaths.every((filePath): filePath is string => filePath !== null)
              ? `${registeredPaths.map((filePath) => `@${filePath}`).join(' ')} `
              : null;
          const textToInsert = normalizedFileReferenceText ?? text;

          // Use modern Selection API to insert plain text (maintains cursor position)
          insertTextAtCursor(textToInsert, editableRef.current);
          timer.mark('insertText');

          // Trigger input event to update state
          // Pass false to bypass IME guard (isComposingRef may be stale after recent compositionEnd)
          handleInput();
          timer.mark('handleInput');

          // Immediately sync parent state without waiting for debounce
          flushInput();

          // Scroll to make cursor visible after paste
          // Use requestAnimationFrame to ensure DOM updates are complete
          requestAnimationFrame(() => {
            if (normalizedFileReferenceText) {
              renderFileTags();
            }
            // Get the wrapper element that has overflow scroll
            const wrapper = editableRef.current?.parentElement;
            if (wrapper && editableRef.current) {
              // Scroll wrapper to bottom to show pasted content
              wrapper.scrollTop = wrapper.scrollHeight;
            }
          });

          timer.end();
        } else {
          // No image, no text, no file — JCEF may have intercepted a clipboard image
          requestNativeImage();
        }
      }
    },
    [
      editableRef,
      pathMappingRef,
      renderFileTags,
      queuePastedImage,
      requestNativeImage,
      handleInput,
      flushInput,
    ]
  );

  /**
   * Handle drag over event
   */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Set drop effect to copy
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  /**
   * Handle drop event - detect images and file paths
   */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // First get text content (file path)
      const text = e.dataTransfer?.getData('text/plain');

      // Then check file objects
      const files = e.dataTransfer?.files;

      // Check if there are actual image file objects
      let hasImageFile = false;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];

          // Only process image files
          if (file.type.startsWith('image/')) {
            hasImageFile = true;
            // Deliberate drops share lifecycle protection, but never clipboard replay suppression.
            queuePastedImage(() => new Promise<Attachment>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error ?? new Error('Image read failed'));
              reader.onabort = () => reject(new Error('Image read aborted'));
              reader.onload = () => {
                const base64 = (reader.result as string).split(',')[1];
                const ext = (() => {
                  if (file.type && file.type.includes('/')) {
                    return file.type.split('/')[1];
                  }
                  const m = file.name.match(/\.([a-zA-Z0-9]+)$/);
                  return m ? m[1] : 'png';
                })();
                resolve({
                  id: generateId(),
                  fileName: file.name || `dropped-image-${Date.now()}.${ext}`,
                  mediaType: file.type || 'image/png',
                  data: base64,
                });
              };
              reader.readAsDataURL(file);
            }), null);
          }
        }
      }

      // If there are image files, don't process text
      if (hasImageFile) {
        return;
      }

      // No image files, process text (file path or other text)
      if (text && text.trim()) {
        // Reuse the same absolute-path registration used by paste and the
        // dedicated Java bridge. Relative/non-path drops remain plain text.
        const filePath = registerAbsoluteFileReference(pathMappingRef.current, text);
        const textToInsert = filePath
          ? `@${filePath} `
          : `${text.startsWith('@') ? text : `@${text}`} `;

        // Get current cursor position
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0 && editableRef.current) {
          // Ensure cursor is inside input box
          if (editableRef.current.contains(selection.anchorNode)) {
            // Use modern API to insert text
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(textToInsert);
            range.insertNode(textNode);

            // Move cursor after inserted text
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          } else {
            // Cursor not inside input box, append to end
            // Use appendChild instead of innerText to avoid breaking existing file tags
            const textNode = document.createTextNode(textToInsert);
            editableRef.current.appendChild(textNode);

            // Move cursor to end
            const range = document.createRange();
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else {
          // No selection, append to end
          if (editableRef.current) {
            const textNode = document.createTextNode(textToInsert);
            editableRef.current.appendChild(textNode);
          }
        }

        // Close all completion menus
        closeAllCompletions();

        // Directly trigger state update, don't call handleInput (avoid re-detecting completion)
        const newText = getTextContent();
        setHasContent(!!newText.trim());
        adjustHeight();
        onInput?.(newText);

        // Immediately render file tags (don't wait for space)
        setTimeout(() => {
          renderFileTags();
        }, 50);
      }
    },
    [
      editableRef,
      pathMappingRef,
      getTextContent,
      adjustHeight,
      renderFileTags,
      setHasContent,
      queuePastedImage,
      onInput,
      closeAllCompletions,
    ]
  );

  // Listen for image paste events dispatched from Java side (when clipboard has image but no text)
  useEffect(() => {
    const onJavaPasteImage = (e: Event) => {
      const { base64, mediaType, requestId } = (e as CustomEvent).detail;
      // A request can outlive its session or draft; only its original pending owner may consume it.
      const finish = requestId ? nativeRequestsRef.current.get(requestId) : undefined;
      if (requestId && !finish) return;
      if (!base64) {
        finish?.(null);
        return;
      }
      const ext = mediaType?.split('/')[1] || 'png';
      const attachment: Attachment = {
        id: generateId(),
        fileName: `pasted-image-${Date.now()}.${ext}`,
        mediaType: mediaType || 'image/png',
        data: base64,
      };

      if (finish) finish(attachment);
      else queuePastedImage(() => Promise.resolve(attachment), 'java-bridge');
    };
    const onNativePasteRequest = (event: Event) => {
      const { snapshotId, scopeId } = (event as CustomEvent<{ snapshotId?: string; scopeId?: string }>).detail ?? {};
      if (snapshotId && (!scopeId || scopeId !== draftScopeIdRef.current)) return;
      requestNativeImage(snapshotId);
    };
    window.addEventListener('java-request-paste-image', onNativePasteRequest);
    window.addEventListener('java-paste-image', onJavaPasteImage);
    return () => {
      window.removeEventListener('java-paste-image', onJavaPasteImage);
      window.removeEventListener('java-request-paste-image', onNativePasteRequest);
    };
  }, [queuePastedImage, requestNativeImage]);

  return {
    handlePaste,
    handleDragOver,
    handleDrop,
    isPreparingImages,
    hasPendingImagePastes,
    invalidateImagePastes,
  };
}
