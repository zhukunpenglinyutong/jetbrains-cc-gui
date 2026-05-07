import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PermissionDialog, { type PermissionRequest } from './PermissionDialog';
import { resetLinkifyCapabilities, setLinkifyCapabilities } from '../utils/linkifyCapabilities';

vi.mock('../hooks/useDialogResize', () => ({
  useDialogResize: () => ({
    dialogRef: { current: null },
    dialogHeight: null,
    setDialogHeight: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: unknown) => {
      if (typeof fallbackOrOptions === 'string') {
        return fallbackOrOptions;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('PermissionDialog', () => {
  beforeEach(() => {
    resetLinkifyCapabilities();
    setLinkifyCapabilities({ classNavigationEnabled: true });
  });

  it('reuses MarkdownBlock linkify inside the command content area', () => {
    const request: PermissionRequest = {
      channelId: 'perm-1',
      toolName: 'bash',
      inputs: {
        cwd: 'src/components',
        command: [
          'Read src/components/App.tsx',
          '',
          'Inspect com.github.claudecodegui.handler.file.OpenFileHandler',
          '',
          'Reference https://example.com/docs',
        ].join('\n'),
      },
    };

    render(
      <PermissionDialog
        isOpen
        request={request}
        onApprove={() => {}}
        onSkip={() => {}}
        onApproveAlways={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'src/components/App.tsx' })).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'com.github.claudecodegui.handler.file.OpenFileHandler',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();
  });
});
