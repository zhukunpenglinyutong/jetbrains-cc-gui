import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GenericToolBlock from './GenericToolBlock';
import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';
import fr from '../../i18n/locales/fr.json';
import hi from '../../i18n/locales/hi.json';
import ja from '../../i18n/locales/ja.json';
import ko from '../../i18n/locales/ko.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ru from '../../i18n/locales/ru.json';
import zh from '../../i18n/locales/zh.json';
import zhTW from '../../i18n/locales/zh-TW.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../hooks/useIsToolDenied', () => ({ useIsToolDenied: () => false }));
vi.mock('../../utils/bridge', () => ({ openFile: vi.fn() }));
vi.mock('../../hooks/useResolvedFileLinkTooltip', () => ({ useResolvedFileLinkTooltip: () => ({}) }));

const HOST_ERROR = 'The browser access host is unavailable';
const URL_ERROR = 'Computer Use has been stopped for this turn because it could not verify whether the '
  + 'current browser URL is allowed. Stop your work and send a final message noting why Computer Use ended.';

const renderCall = (server: string | undefined, content: unknown, isError = true, name = 'js') =>
  render(<GenericToolBlock name={name}
    input={{ ...(server ? { server } : {}), arguments: { code: 'await cua.getState()' } }}
    result={{ type: 'tool_result', is_error: isError, content: content as string }} />).container;

const hint = (container: HTMLElement) => container.querySelector('.browser-access-hint');

describe('browser access hint', () => {
  it.each([HOST_ERROR, URL_ERROR])('explains a failed cua_repl call while collapsed: %s', error => {
    const text = hint(renderCall('cua_repl', error))?.textContent;
    for (const key of ['title', 'description', 'optionsTitle', 'desktopOption', 'manualOption', 'note']) {
      expect(text).toContain(`tools.browserAccessHint.${key}`);
    }
  });

  it('recognizes the error inside MCP text blocks', () => {
    expect(hint(renderCall('cua_repl', [{ type: 'text', text: HOST_ERROR }]))).toBeTruthy();
  });

  it.each(['mcp__cua_repl__js', 'mcp__cua_repl.js'])('recognizes the flat tool name %s', name => {
    expect(hint(renderCall(undefined, HOST_ERROR, true, name))).toBeTruthy();
  });

  it('stays hidden when the call succeeded', () => {
    expect(hint(renderCall('cua_repl', HOST_ERROR, false))).toBeNull();
  });

  it('stays hidden for other servers', () => {
    expect(hint(renderCall('node_repl', HOST_ERROR))).toBeNull();
  });

  it('stays hidden for other cua_repl failures', () => {
    expect(hint(renderCall('cua_repl', 'ReferenceError: edge is not defined'))).toBeNull();
  });

  it('keeps the agreed English wording', () => {
    expect(en.tools.browserAccessHint).toEqual({
      title: 'Codex couldn\'t control your browser',
      description: 'Codex\'s browser tool (cua_repl) tried to access Chrome/Edge, but couldn\'t connect to '
        + 'the browser access host or verify the page address.',
      optionsTitle: 'What you can do:',
      desktopOption: 'Use the official Codex desktop app for this browser task.',
      manualOption: 'Or continue here without browser control, for example by pasting the page content or '
        + 'attaching a file.',
      note: 'Reopening the browser or changing CC GUI permissions is unlikely to help.',
    });
  });

  it.each(Object.entries({ es, fr, hi, ja, ko, ptBR, ru, zh, zhTW }))('is translated in %s', (_, locale) => {
    const messages: Record<string, string> = locale.tools.browserAccessHint;
    expect(Object.keys(messages)).toEqual(Object.keys(en.tools.browserAccessHint));
    expect(messages.description).toContain('cua_repl');
    expect(messages.description).not.toBe(en.tools.browserAccessHint.description);
  });
});
