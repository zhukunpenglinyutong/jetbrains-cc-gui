import { act, renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { useChatInputAttachmentsCoordinator } from './useChatInputAttachmentsCoordinator.js';

function createFile(name: string, type: string) {
  const blob = new Blob(['x'], { type });
  return new File([blob], name, { type });
}

describe('useChatInputAttachmentsCoordinator', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('delegates to parent callbacks in controlled mode', () => {
    const onAddAttachment = vi.fn();
    const onRemoveAttachment = vi.fn();

    const { result } = renderHook(() =>
      useChatInputAttachmentsCoordinator({
        externalAttachments: [],
        onAddAttachment,
        onRemoveAttachment,
      })
    );

    const file = createFile('a.txt', 'text/plain');
    const list = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;

    result.current.handleAddAttachment(list);
    result.current.handleRemoveAttachment('a1');

    expect(onAddAttachment).toHaveBeenCalledWith(list);
    expect(onRemoveAttachment).toHaveBeenCalledWith('a1');
  });

  it('manages internal attachments in uncontrolled mode', () => {
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
      const { result } = renderHook(() =>
        useChatInputAttachmentsCoordinator({
          externalAttachments: undefined,
        })
      );

      const file = createFile('a.txt', 'text/plain');
      const list = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;

      act(() => {
        result.current.handleAddAttachment(list);
      });

      expect(mockReadAsDataURL).toHaveBeenCalled();
      expect(result.current.attachments).toHaveLength(1);

      const attachment = result.current.attachments[0] as Attachment;
      act(() => {
        result.current.handleRemoveAttachment(attachment.id);
      });

      expect(result.current.attachments).toHaveLength(0);
    } finally {
      globalThis.FileReader = originalFileReader;
    }
  });
});
