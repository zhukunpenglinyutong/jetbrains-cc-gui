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

  it('manages internal attachments in uncontrolled mode', async () => {
    const originalFileReader = globalThis.FileReader;

    // Create a proper mock FileReader that calls onload synchronously
    class MockFileReader {
      public result: string | ArrayBuffer | null = null;
      public onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      public onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      public onabort: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

      readAsDataURL(_blob: Blob): void {
        // Set result as a data URL format
        this.result = 'data:text/plain;base64,SGVsbG8=';
        // Call onload synchronously with a proper event object
        if (this.onload) {
          const event = new ProgressEvent('load') as ProgressEvent<FileReader>;
          this.onload.call(this as unknown as FileReader, event);
        }
      }
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

      // Wait for state update
      await act(async () => {
        await Promise.resolve();
      });

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
