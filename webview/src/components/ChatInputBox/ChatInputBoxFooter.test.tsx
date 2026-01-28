import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompletionController } from './types.js';
import { ChatInputBoxFooter } from './ChatInputBoxFooter.js';

const buttonAreaSpy = vi.fn();
vi.mock('./ButtonArea.js', () => {
  return {
    ButtonArea: (props: any) => {
      buttonAreaSpy(props);
      return <div data-testid="button-area" />;
    },
  };
});

vi.mock('./Dropdown/index.js', () => {
  return {
    CompletionDropdown: ({ isVisible }: { isVisible: boolean }) => (
      <div data-testid="completion-dropdown" data-visible={String(isVisible)} />
    ),
  };
});

vi.mock('./PromptEnhancerDialog.js', () => {
  return {
    PromptEnhancerDialog: ({ isOpen }: { isOpen: boolean }) => (
      <div data-testid="enhancer" data-open={String(isOpen)} />
    ),
  };
});

function createCompletion(isOpen: boolean): CompletionController {
  return {
    isOpen,
    position: null,
    items: [],
    activeIndex: 0,
    loading: false,
    close: vi.fn(),
    selectIndex: vi.fn(),
    handleMouseEnter: vi.fn(),
  };
}

describe('ChatInputBoxFooter', () => {
  it('renders tooltip and wires ButtonArea props', () => {
    buttonAreaSpy.mockClear();

    render(
      <ChatInputBoxFooter
        disabled={false}
        hasInputContent={true}
        isLoading={false}
        isEnhancing={false}
        selectedModel="claude-sonnet-4-5"
        permissionMode="bypassPermissions"
        currentProvider="claude"
        reasoningEffort="medium"
        onSubmit={vi.fn()}
        onEnhancePrompt={vi.fn()}
        onClearAgent={vi.fn()}
        fileCompletion={createCompletion(false)}
        commandCompletion={createCompletion(true)}
        agentCompletion={createCompletion(false)}
        tooltip={{ visible: true, text: 'tip', top: 10, left: 10 }}
        promptEnhancer={{
          isOpen: false,
          isLoading: false,
          originalPrompt: '',
          enhancedPrompt: '',
          onUseEnhanced: vi.fn(),
          onKeepOriginal: vi.fn(),
          onClose: vi.fn(),
        }}
        t={((key: string) => key) as any}
      />
    );

    expect(screen.getByText('tip')).toBeTruthy();
    expect(buttonAreaSpy).toHaveBeenCalled();
    expect(buttonAreaSpy.mock.calls[0][0].hasInputContent).toBe(true);
  });
});

