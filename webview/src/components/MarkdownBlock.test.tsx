import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownBlock from './MarkdownBlock';
import {
  resetLinkifyCapabilities,
  setLinkifyCapabilities,
} from '../utils/linkifyCapabilities';

const bridgeMocks = vi.hoisted(() => ({
  openBrowser: vi.fn(),
  openClass: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock('../utils/bridge', () => ({
  openBrowser: bridgeMocks.openBrowser,
  openClass: bridgeMocks.openClass,
  openFile: bridgeMocks.openFile,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

describe('MarkdownBlock linkify integration', () => {
  beforeEach(() => {
    resetLinkifyCapabilities();
    bridgeMocks.openBrowser.mockReset();
    bridgeMocks.openClass.mockReset();
    bridgeMocks.openFile.mockReset();
  });

  it('linkifies inline code content but not code fence blocks', () => {
    render(
      <MarkdownBlock
        content={[
          'Open src/components/App.tsx',
          '',
          '`src/inline-code.ts` should be linkified',
          '',
          '```ts',
          'src/ignored-block.ts',
          '```',
        ].join('\n')}
      />,
    );

    const fileLink = screen.getByRole('link', { name: 'src/components/App.tsx' });
    expect(fileLink.getAttribute('data-linkify')).toBe('file');

    // Inline code content should be linkified
    const inlineCodeLink = screen.getByRole('link', { name: 'src/inline-code.ts' });
    expect(inlineCodeLink.getAttribute('data-linkify')).toBe('file');
    expect(inlineCodeLink.closest('code')).toBeTruthy();

    // Code fence content should NOT be linkified
    const fencedCode = document.querySelector('pre code');
    expect(fencedCode?.textContent).toContain('src/ignored-block.ts');
    expect(fencedCode?.querySelector('a')).toBeNull();
  });

  it('renders Java class links only when capability is enabled', () => {
    const fqcn = 'com.github.claudecodegui.handler.file.OpenFileHandler';

    const disabledRender = render(<MarkdownBlock content={fqcn} />);
    expect(screen.queryByRole('link', { name: fqcn })).toBeNull();
    disabledRender.unmount();

    setLinkifyCapabilities({ classNavigationEnabled: true });
    render(<MarkdownBlock content={fqcn} />);

    const classLink = screen.getByRole('link', { name: fqcn });
    expect(classLink.classList.contains('class-link')).toBe(true);
    expect(classLink.getAttribute('data-linkify')).toBe('class');
  });

  it('adds url-link styling to plain URLs and markdown links', () => {
    render(
      <MarkdownBlock content={'Visit https://example.com/docs and [guide](https://example.com/guide)'} />,
    );

    const rawUrlLink = screen.getByRole('link', { name: 'https://example.com/docs' });
    const markdownLink = screen.getByRole('link', { name: 'guide' });

    expect(rawUrlLink.classList.contains('url-link')).toBe(true);
    expect(markdownLink.classList.contains('url-link')).toBe(true);
  });

  it('strips unsafe markdown link protocols during sanitization', () => {
    render(<MarkdownBlock content={'[bad](javascript:alert(1)) and [good](https://example.com/docs)'} />);

    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByRole('link', { name: 'good' }).getAttribute('href')).toBe('https://example.com/docs');
  });

  it('strips file: protocol links and does not route them to openFile', () => {
    render(
      <MarkdownBlock
        content={'[click](https://example.com/docs) and [local](file:///tmp/demo.txt)'}
      />,
    );

    // file: link should be stripped entirely by DOMPurify sanitization
    expect(screen.queryByRole('link', { name: 'local' })).toBeNull();

    // https link should still work
    const httpsLink = screen.getByRole('link', { name: 'click' });
    expect(httpsLink.getAttribute('href')).toBe('https://example.com/docs');

    fireEvent.click(httpsLink);
    expect(bridgeMocks.openBrowser).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('renders windows, posix, and explicit relative paths as file links', () => {
    render(
      <MarkdownBlock
        content={[
          'Windows C:\\repo\\src\\Main.java',
          '',
          'POSIX /home/user/project/src/main.ts',
          '',
          'Relative ./foo.ts and ../shared/utils.ts',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('link', { name: 'C:\\repo\\src\\Main.java' }).getAttribute('data-linkify')).toBe('file');
    expect(screen.getByRole('link', { name: '/home/user/project/src/main.ts' }).getAttribute('data-linkify')).toBe('file');
    expect(screen.getByRole('link', { name: './foo.ts' }).getAttribute('data-linkify')).toBe('file');
    expect(screen.getByRole('link', { name: '../shared/utils.ts' }).getAttribute('data-linkify')).toBe('file');
  });

  it('dispatches clicks to the correct bridge helpers', () => {
    setLinkifyCapabilities({ classNavigationEnabled: true });

    render(
      <MarkdownBlock
        content={[
          'Open src/components/App.tsx',
          '',
          'See com.github.claudecodegui.handler.file.OpenFileHandler',
          '',
          'Visit https://example.com/docs',
        ].join('\n')}
      />
    );

    fireEvent.click(screen.getByRole('link', { name: 'src/components/App.tsx' }));
    fireEvent.click(
      screen.getByRole('link', {
        name: 'com.github.claudecodegui.handler.file.OpenFileHandler',
      }),
    );
    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/docs' }));

    expect(bridgeMocks.openFile).toHaveBeenCalledWith('src/components/App.tsx');
    expect(bridgeMocks.openClass).toHaveBeenCalledWith(
      'com.github.claudecodegui.handler.file.OpenFileHandler',
    );
    expect(bridgeMocks.openBrowser).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('shows links during streaming and keeps final rendering consistent', () => {
    setLinkifyCapabilities({ classNavigationEnabled: true });

    const content = [
      'Reading src/App.tsx',
      '',
      'Class com.github.claudecodegui.handler.file.OpenFileHandler',
      '',
      'Docs https://example.com/docs',
    ].join('\n');

    const { rerender } = render(<MarkdownBlock content={content} isStreaming />);

    expect(screen.getByRole('link', { name: 'src/App.tsx' })).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'com.github.claudecodegui.handler.file.OpenFileHandler',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();

    rerender(<MarkdownBlock content={content} isStreaming={false} />);

    expect(screen.getByRole('link', { name: 'src/App.tsx' })).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'com.github.claudecodegui.handler.file.OpenFileHandler',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();
  });
});
