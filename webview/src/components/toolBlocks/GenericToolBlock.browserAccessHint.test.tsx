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
    const element = hint(renderCall('cua_repl', error));
    expect(element?.textContent).toBe(['title', 'description', 'report']
      .map(key => `tools.browserAccessHint.${key}`).join(''));
    expect(element?.querySelector('a')).toBeNull();
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

  it('keeps the English wording generic', () => {
    expect(en.tools.browserAccessHint).toEqual({
      title: 'This browser error happened outside CC GUI',
      description: 'An external browser tool could not access the page. This is not a CC GUI error.',
      report: 'Please report it to the provider of that tool.',
    });
  });

  it.each(Object.entries({ es, fr, hi, ja, ko, ptBR, ru, zh, zhTW }))('is translated in %s', (_, locale) => {
    const messages: Record<string, string> = locale.tools.browserAccessHint;
    expect(Object.keys(messages)).toEqual(Object.keys(en.tools.browserAccessHint));
    for (const [key, english] of Object.entries(en.tools.browserAccessHint)) {
      expect(messages[key]).not.toBe(english);
      expect(messages[key]).not.toMatch(/Codex|Chrome|Edge|cua_repl|\{\{/);
    }
  });
});
