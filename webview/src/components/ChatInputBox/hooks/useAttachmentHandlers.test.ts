import { renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { useAttachmentHandlers } from './useAttachmentHandlers.js';

function createFile(name: string, type: string) {
  const blob = new Blob(['x'], { type });
  return new File([blob], name, { type });
}

describe('useAttachmentHandlers', () => {
  it('delegates to external onAddAttachment/onRemoveAttachment in controlled mode', () => {
    const onAddAttachment = vi.fn();
    const onRemoveAttachment = vi.fn();
    const setInternalAttachments = vi.fn();

    const { result } = renderHook(() =>
      useAttachmentHandlers({
        externalAttachments: [],
        onAddAttachment,
        onRemoveAttachment,
        setInternalAttachments,
      })
    );

    const file = createFile('a.txt', 'text/plain');
    const list = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;
    result.current.handleAddAttachment(list);
    expect(onAddAttachment).toHaveBeenCalledWith(list);
    expect(setInternalAttachments).not.toHaveBeenCalled();

    result.current.handleRemoveAttachment('id1');
    expect(onRemoveAttachment).toHaveBeenCalledWith('id1');
  });

  it('adds/removes attachments in uncontrolled mode', () => {
    const originalFileReader = globalThis.FileReader;

    const mockReadAsDataURL = vi.fn(function (this: FileReader) {
      (this as unknown as { result?: string }).result = 'data:text/plain;base64,SGVsbG8=';
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
      let internal: Attachment[] = [];
      const setInternalAttachments = vi.fn((updater: unknown) => {
        internal =
          typeof updater === 'function'
            ? (updater as (prev: Attachment[]) => Attachment[])(internal)
            : (updater as Attachment[]);
      });

      const { result } = renderHook(() =>
        useAttachmentHandlers({
          externalAttachments: undefined,
          onAddAttachment: vi.fn(),
          onRemoveAttachment: vi.fn(),
          setInternalAttachments,
        })
      );

      const file = createFile('a.txt', 'text/plain');
      const list = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;
      result.current.handleAddAttachment(list);

      expect(mockReadAsDataURL).toHaveBeenCalled();
      expect(internal).toHaveLength(1);
      expect(internal[0].fileName).toBe('a.txt');

      const removeId = internal[0].id;
      result.current.handleRemoveAttachment(removeId);
      expect(internal).toHaveLength(0);
    } finally {
      globalThis.FileReader = originalFileReader;
    }
  });
});
