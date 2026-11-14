import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en.json';
import zh from '../../../i18n/locales/zh.json';
import { requestDependencyStatusUntilSettled } from '../../../utils/bridgeStartup';
import DependencySection from './index';

const translations: Record<string, string> = {
  'settings.dependency.title': 'SDK 依赖管理',
  'settings.dependency.description': '管理 AI SDK 依赖包。首次使用时需要安装对应的 SDK。',
  'settings.dependency.installPolicyTip': '安装遇到问题？可将报错复制给终端 CLI AI 解决',
  'settings.dependency.loading': '加载中',
  'settings.dependency.claudeSdkName': 'Claude Code SDK',
  'settings.dependency.codexMigratedTitle': 'Codex 已迁移到「供应商管理 → CLI」',
  'settings.dependency.codexMigratedDesc': 'Codex 不再从这里安装 SDK。',
  'settings.dependency.claudeSdkDescription': 'Claude AI 功能所需。包含 Claude Code SDK 及相关依赖。',
  'settings.dependency.targetVersion': '目标版本',
  'settings.dependency.loadingVersions': '版本列表加载中',
  'settings.dependency.installedVersion': '当前版本 {{version}}',
  'settings.dependency.latestStableVersion': '最新稳定版 {{version}}',
  'settings.dependency.installVersion': '安装 {{version}}',
  'settings.dependency.install': '安装',
  'settings.dependency.currentVersionAction': '当前版本',
  'settings.dependency.updateToVersion': '更新到 {{version}}',
  'settings.dependency.rollbackToVersion': '回退到 {{version}}',
  'settings.dependency.uninstall': '卸载',
  'settings.dependency.updateAvailable': '有更新',
  'settings.dependency.rollbackWarning': '目标版本低于当前版本，将执行回退安装。',
  'settings.dependency.targetVersionValue': '目标版本 {{version}}',
  'settings.cli.retry': '重试',
};

const resolveLocaleKey = (locale: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const template = translations[key] ?? key;
      if (!options) {
        return template;
      }

      return Object.entries(options).reduce(
        (result, [token, value]) => result.replace(`{{${token}}}`, value),
        template,
      );
    },
  }),
}));

describe('DependencySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
    window.__pendingDependencyUpdates = undefined;
    window.__pendingDependencyVersions = undefined;
    window.__dependencyStatusState = 'pending';
  });

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
  });

  it('explains that Codex moved to the CLI section instead of listing a Codex SDK card', () => {
    render(<DependencySection isActive={false} />);

    expect(screen.getByText(translations['settings.dependency.codexMigratedTitle'])).toBeTruthy();
    expect(screen.getByText(translations['settings.dependency.codexMigratedDesc'])).toBeTruthy();
    expect(screen.queryByText('Codex SDK')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Codex SDK' })).toBeNull();
  });

  it('shows an error state with manual retry instead of SDK install actions', () => {
    render(<DependencySection isActive={false} />);

    act(() => {
      window.updateDependencyStatus?.(JSON.stringify({
        success: false,
        error: 'status unavailable',
      }));
    });

    expect(screen.getByText('chat.sdkStatusUnavailable')).toBeTruthy();
    expect(screen.queryByText('Claude Code SDK')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'chat.retrySdkStatus' }));

    expect(window.sendToJava).toHaveBeenCalledWith('get_dependency_status:');
    expect(screen.getByText(translations['settings.dependency.loading'])).toBeTruthy();
  });

  it.each([
    ['NPM_QUERY_EXIT_1: EPERM', 'versionCacheAccessError'],
    ['NPM_QUERY_TIMEOUT', 'versionQueryTimeout'],
    ['NPM_QUERY_EXIT_1: ENOTFOUND', 'versionQueryNetworkError'],
    ['NPM_QUERY_FAILED', 'versionQueryFailed'],
  ])('shows the cause of %s and retries version lookup without installing or claiming a bundled latest version', (error, key) => {
    render(<DependencySection isActive={false} />);
    act(() => {
      window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': { id: 'claude-sdk', status: 'not_installed', hasUpdate: false },
      }));
      window.dependencyVersionsLoaded?.(JSON.stringify({
        'claude-sdk': { sdkId: 'claude-sdk', versions: ['0.3.220'], fallbackVersions: ['0.3.220'],
          source: 'fallback', latestVersion: '0.3.220', error },
      }));
    });
    expect(screen.getByText(`settings.dependency.${key}`)).toBeTruthy();
    expect(screen.queryByText('最新稳定版 v0.3.220')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(window.sendToJava).toHaveBeenCalledWith('get_dependency_versions:{"id":"claude-sdk"}');
    expect((screen.getByRole('button', { name: '重试' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('版本列表加载中')).toBeTruthy();
    act(() => {
      window.dependencyVersionsLoaded?.(JSON.stringify({
        'claude-sdk': { sdkId: 'claude-sdk', versions: ['0.3.307', '0.3.220'], source: 'remote', latestVersion: '0.3.307' },
      }));
    });
    expect(screen.queryByText(`settings.dependency.${key}`)).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.getByText('最新稳定版 v0.3.307')).toBeTruthy();
    expect(screen.queryByText('版本列表加载中')).toBeNull();
  });

  it('uses version lookup keys that exist in the shipped locales', () => {
    const keys = [
      'settings.cli.retry',
      'settings.dependency.versionCacheAccessError',
      'settings.dependency.versionQueryTimeout',
      'settings.dependency.versionQueryNetworkError',
      'settings.dependency.versionQueryFailed',
    ];
    for (const locale of [en, zh]) {
      for (const key of keys) {
        expect(typeof resolveLocaleKey(locale, key), key).toBe('string');
      }
    }
  });

  it('returns to loading when the dependency tab retries a previous error', () => {
    const view = render(<DependencySection isActive={false} />);

    act(() => {
      window.updateDependencyStatus?.(JSON.stringify({
        success: false,
        error: 'status unavailable',
      }));
    });
    expect(screen.getByText('chat.sdkStatusUnavailable')).toBeTruthy();

    view.rerender(<DependencySection isActive />);

    expect(screen.queryByText('chat.sdkStatusUnavailable')).toBeNull();
    expect(screen.getByText(translations['settings.dependency.loading'])).toBeTruthy();
  });

  it('reuses the startup request while dependency status is pending', () => {
    requestDependencyStatusUntilSettled();

    render(<DependencySection isActive />);

    const sendToJavaMock = vi.mocked(window.sendToJava!);
    const statusRequests = sendToJavaMock.mock.calls
      .filter(([message]) => message === 'get_dependency_status:');
    expect(statusRequests).toHaveLength(1);
  });

  it('queues an installation refresh behind the active status request', async () => {
    requestDependencyStatusUntilSettled();
    render(<DependencySection isActive={false} />);

    act(() => {
      window.dependencyInstallResult?.(JSON.stringify({
        success: true,
        sdkId: 'claude-sdk',
      }));
    });

    const sendToJavaMock = vi.mocked(window.sendToJava!);
    const countStatusRequests = () => sendToJavaMock.mock.calls
      .filter(([message]) => message === 'get_dependency_status:').length;
    expect(countStatusRequests()).toBe(1);

    await act(async () => {
      window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': { status: 'installed' },
      }));
      await Promise.resolve();
    });

    expect(countStatusRequests()).toBe(2);
  });

  it('removes the custom version input and keeps a compact version selector with actions', () => {
    render(<DependencySection isActive={false} />);

    act(() => {
      window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': {
          id: 'claude-sdk',
          name: 'Claude Code SDK',
          status: 'installed',
          installedVersion: '0.2.89',
          hasUpdate: false,
        },
        'codex-sdk': {
          id: 'codex-sdk',
          name: 'Codex SDK',
          status: 'not_installed',
          hasUpdate: false,
        },
      }));

      window.dependencyVersionsLoaded?.(JSON.stringify({
        'claude-sdk': {
          sdkId: 'claude-sdk',
          versions: ['0.2.89', '0.2.88'],
          source: 'remote',
          latestVersion: '0.2.89',
        },
        'codex-sdk': {
          sdkId: 'codex-sdk',
          versions: ['0.118.0', '0.117.0'],
          source: 'remote',
          latestVersion: '0.118.0',
        },
      }));
    });

    expect(screen.queryByText('自定义版本')).toBeNull();
    expect(screen.getAllByText('目标版本')).toHaveLength(1);
    expect(screen.queryByText('Codex SDK')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: '目标版本 v0.2.89' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '目标版本 v0.118.0' })).toBeNull();
    expect(screen.getByRole('button', { name: '当前版本' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '卸载' })).toHaveLength(1);
  });

  it('opens an app-controlled version list with the latest version reachable first', () => {
    render(<DependencySection isActive={false} />);

    act(() => {
      window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': {
          id: 'claude-sdk',
          name: 'Claude Code SDK',
          status: 'installed',
          installedVersion: '0.2.88',
          hasUpdate: true,
          latestVersion: '0.2.90',
        },
        'codex-sdk': {
          id: 'codex-sdk',
          name: 'Codex SDK',
          status: 'not_installed',
          hasUpdate: false,
        },
      }));

      window.dependencyVersionsLoaded?.(JSON.stringify({
        'claude-sdk': {
          sdkId: 'claude-sdk',
          versions: ['0.2.90', '0.2.89', '0.2.88'],
          source: 'remote',
          latestVersion: '0.2.90',
        },
        'codex-sdk': {
          sdkId: 'codex-sdk',
          versions: ['0.118.0', '0.117.0'],
          source: 'remote',
          latestVersion: '0.118.0',
        },
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: '目标版本 v0.2.88' }));

    const listbox = screen.getByRole('listbox', { name: '目标版本' });
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'v0.2.90',
      'v0.2.89',
      'v0.2.88',
    ]);

    fireEvent.click(within(listbox).getByRole('option', { name: 'v0.2.90' }));

    expect(screen.getByRole('button', { name: '目标版本 v0.2.90' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '更新到 v0.2.90' })).toBeTruthy();
  });

  it('shows a loading hint while version options are still being fetched', () => {
    render(<DependencySection isActive />);

    act(() => {
      window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': {
          id: 'claude-sdk',
          name: 'Claude Code SDK',
          status: 'installed',
          installedVersion: '0.2.89',
          hasUpdate: false,
        },
        'codex-sdk': {
          id: 'codex-sdk',
          name: 'Codex SDK',
          status: 'not_installed',
          hasUpdate: false,
        },
      }));
    });

    expect(screen.getAllByText('版本列表加载中').length).toBeGreaterThan(0);
    expect(window.sendToJava).toHaveBeenCalledWith('get_dependency_versions:');

    act(() => {
      window.dependencyVersionsLoaded?.(JSON.stringify({
        'claude-sdk': {
          sdkId: 'claude-sdk',
          versions: ['0.2.89', '0.2.88'],
          source: 'remote',
          latestVersion: '0.2.89',
        },
        'codex-sdk': {
          sdkId: 'codex-sdk',
          versions: ['0.118.0', '0.117.0'],
          source: 'remote',
          latestVersion: '0.118.0',
        },
      }));
    });

    expect(screen.queryByText('版本列表加载中')).toBeNull();
  });
});
