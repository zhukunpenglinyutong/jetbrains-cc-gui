import { act, renderHook } from '@testing-library/react';
import { usePasteAndDrop } from './usePasteAndDrop.js';
import type { Attachment } from '../types.js';

function createClipboardItem(type: string, file: File) {
  return {
    kind: 'file',
    type,
    getAsFile: () => file,
  } as DataTransferItem;
}

describe('usePasteAndDrop', () => {
  it('deduplicates image attachments from repeated sources in a short window', () => {
    const originalFileReader = globalThis.FileReader;
    const originalDateNow = Date.now;

    let now = 1_000_000;
    Date.now = () => now;

    const mockReadAsDataURL = vi.fn(function (this: FileReader) {
      (this as unknown as { result?: string }).result = 'data:image/png;base64,QUJDRA==';
      this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    });

    class MockFileReader {
      public result: string | null = null;
      public onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      readAsDataURL = mockReadAsDataURL as unknown as (blob: Blob) => void;
    }

    // @ts-expect-error test override
    globalThis.FileReader = MockFileReader;

    try {
      let attachments: Attachment[] = [];
      const setInternalAttachments = vi.fn((updater: unknown) => {
        attachments =
          typeof updater === 'function'
            ? (updater as (prev: Attachment[]) => Attachment[])(attachments)
            : (updater as Attachment[]);
      });

      const editableRef = {
        current: document.createElement('div'),
      } as React.RefObject<HTMLDivElement | null>;

      const { result } = renderHook(() =>
        usePasteAndDrop({
          editableRef,
          pathMappingRef: { current: new Map<string, string>() } as React.MutableRefObject<Map<string, string>>,
          getTextContent: () => '',
          adjustHeight: vi.fn(),
          renderFileTags: vi.fn(),
          setHasContent: vi.fn(),
          setInternalAttachments,
          closeAllCompletions: vi.fn(),
          handleInput: vi.fn(),
          flushInput: vi.fn(),
        })
      );

      const file = new File([new Blob(['x'], { type: 'image/png' })], 'pasted.png', { type: 'image/png' });
      const item = createClipboardItem('image/png', file);
      const pasteEvent = {
        preventDefault: vi.fn(),
        clipboardData: {
          items: [item],
          getData: vi.fn(() => ''),
        },
      } as unknown as React.ClipboardEvent;

      act(() => {
        result.current.handlePaste(pasteEvent);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent('java-paste-image', {
          detail: {
            base64: 'QUJDRA==',
            mediaType: 'image/png',
          },
        }));
      });

      expect(attachments).toHaveLength(1);

      now += 2_000;
      act(() => {
        window.dispatchEvent(new CustomEvent('java-paste-image', {
          detail: {
            base64: 'QUJDRA==',
            mediaType: 'image/png',
          },
        }));
      });

      expect(attachments).toHaveLength(2);
    } finally {
      globalThis.FileReader = originalFileReader;
      Date.now = originalDateNow;
    }
  });
});
