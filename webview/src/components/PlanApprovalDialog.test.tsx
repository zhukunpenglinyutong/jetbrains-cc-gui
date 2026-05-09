import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlanApprovalDialog, { type PlanApprovalRequest } from './PlanApprovalDialog';
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

describe('PlanApprovalDialog', () => {
  beforeEach(() => {
    resetLinkifyCapabilities();
    setLinkifyCapabilities({ classNavigationEnabled: true });
  });

  it('reuses MarkdownBlock linkify inside the dialog content', () => {
    const request: PlanApprovalRequest = {
      requestId: 'req-1',
      toolName: 'plan',
      plan: [
        'Review src/components/App.tsx',
        '',
        'Check com.github.claudecodegui.handler.file.OpenFileHandler',
        '',
        'Reference https://example.com/docs',
      ].join('\n'),
    };

    render(
      <PlanApprovalDialog
        isOpen
        request={request}
        onApprove={() => {}}
        onReject={() => {}}
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
