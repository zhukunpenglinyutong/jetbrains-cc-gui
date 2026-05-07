import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DependencySection from './index';

const translations: Record<string, string> = {
  'settings.dependency.title': 'SDK 依赖管理',
  'settings.dependency.description': '管理 AI SDK 依赖包。首次使用时需要安装对应的 SDK。',
  'settings.dependency.installPolicyTip': '安装遇到问题？可将报错复制给终端 CLI AI 解决',
  'settings.dependency.loading': '加载中',
  'settings.dependency.claudeSdkName': 'Claude Code SDK',
  'settings.dependency.codexSdkName': 'Codex SDK',
  'settings.dependency.claudeSdkDescription': 'Claude AI 功能所需。包含 Claude Code SDK 及相关依赖。',
  'settings.dependency.codexSdkDescription': 'Codex AI 功能所需。包含 OpenAI Codex SDK。',
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
};

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
    expect(screen.getAllByText('目标版本')).toHaveLength(2);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: '目标版本 v0.2.89' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '目标版本 v0.118.0' })).toBeTruthy();
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
