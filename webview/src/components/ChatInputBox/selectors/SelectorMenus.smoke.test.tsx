import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSelect } from './ConfigSelect';
import { ModeSelect } from './ModeSelect';
import { ModelSelect } from './ModelSelect';
import { ProviderSelect } from './ProviderSelect';
import { ReasoningSelect } from './ReasoningSelect';
import type { NodeProcessSnapshot } from '../../../utils/nodeProcessCapabilities';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'settings.configure': 'Configure',
        'settings.agent.title': 'Agents',
        'settings.basic.streaming.label': 'Streaming',
        'common.thinking': 'Thinking',
        'config.runtimeProvider.title': 'Switch provider',
        'config.nodeProcesses.title': 'Node Process Manager',
        'config.nodeProcesses.badgeWithOrphan': '1 · 1 orphan ⚠',
        'config.nodeProcesses.badge': '1 process',
      };
      if (translations[key]) return translations[key];
      if (typeof options === 'string') return options;
      if (typeof options?.defaultValue === 'string') return options.defaultValue;
      if (typeof options?.model === 'string') return options.model;
      return key;
    },
  }),
}));

vi.mock('../providers/agentProvider', () => ({
  CREATE_NEW_AGENT_ID: '__create__',
  EMPTY_STATE_ID: '__empty__',
  agentProvider: vi.fn(async () => [
    { id: 'agent-a', name: 'Agent A', prompt: 'Use Agent A', provider: 'custom' },
  ]),
}));

vi.mock('../providers/openCodeAgentProvider', () => ({
  openCodeAgentProvider: vi.fn(async () => [
    { id: 'opencode:build', name: 'Build', prompt: '', provider: 'opencode', agentID: 'build' },
  ]),
}));

const nodeProcessSnapshot: NodeProcessSnapshot = {
  snapshotAt: Date.now(),
  totals: { daemon: 0, channel: 0, orphan: 1, all: 1 },
  processes: [
    {
      id: 'orphan-1',
      kind: 'ORPHAN',
      provider: 'opencode',
      pid: 1234,
      alive: true,
      startedAt: Date.now() - 1000,
      uptimeMs: 1000,
      command: 'node orphan.js',
      activeRequestCount: 0,
      orphan: true,
    },
  ],
};

let nodeProcessListener: ((snapshot: NodeProcessSnapshot) => void) | null = null;

vi.mock('../../../utils/nodeProcessCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/nodeProcessCapabilities')>();
  return {
    ...actual,
    fetchNodeProcesses: vi.fn(() => {
      nodeProcessListener?.(nodeProcessSnapshot);
    }),
    subscribeNodeProcesses: vi.fn((listener: (snapshot: NodeProcessSnapshot) => void) => {
      nodeProcessListener = listener;
      return () => {
        if (nodeProcessListener === listener) nodeProcessListener = null;
      };
    }),
    subscribeNodeProcessKillResult: vi.fn(() => () => {}),
  };
});

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

function installNarrowMenuGeometry() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 884 });

  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const element = this as HTMLElement;
    if (element.id === 'app') return domRect(0, 0, 496, 884);
    if (element.classList.contains('node-process-dropdown')) {
      return element.style.right === '100%'
        ? domRect(-90, 400, 320, 220)
        : domRect(440, 400, 320, 220);
    }
    if (element.classList.contains('selector-option') && element.textContent?.includes('Node Process Manager')) {
      return domRect(230, 620, 240, 60);
    }
    if (element.tagName === 'BUTTON') return domRect(64, 820, 42, 32);
    return domRect(64, 620, 240, 40);
  };
}

function expectOpenDropdown() {
  expect(document.querySelector('.selector-dropdown')).toBeTruthy();
}

describe('selector menu smoke tests', () => {
  beforeEach(() => {
    installNarrowMenuGeometry();
    document.body.innerHTML = '<div id="app"></div>';
    window.sendToJava = vi.fn();
    nodeProcessListener = null;
  });

  afterEach(() => {
    cleanup();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('opens every top-level footer selector menu in a narrow viewport', () => {
    const cases = [
      <ModeSelect key="mode" value="default" onChange={vi.fn()} provider="opencode" />,
      <ModelSelect key="model" value="opencode-default" onChange={vi.fn()} currentProvider="opencode" models={[{ id: 'opencode-default', label: 'opencode default' }]} />,
      <ProviderSelect key="provider" value="opencode" onChange={vi.fn()} />,
      <ReasoningSelect key="reasoning" value="default" onChange={vi.fn()} currentProvider="opencode" openCodeVariantOptions={[{ id: 'default', label: 'Default' }]} />,
      <ConfigSelect key="config" currentProvider="opencode" streamingEnabled alwaysThinkingEnabled={false} />,
    ];

    cases.forEach((component) => {
      cleanup();
      document.body.innerHTML = '<div id="app"></div>';
      render(component, { container: document.getElementById('app') as HTMLElement });
      fireEvent.click(screen.getByRole('button'));
      expectOpenDropdown();
    });
  });

  it('opens config submenus without a flip/update loop', () => {
    render(
      <ConfigSelect currentProvider="opencode" streamingEnabled alwaysThinkingEnabled={false} />,
      { container: document.getElementById('app') as HTMLElement },
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.mouseEnter(screen.getByText('Node Process Manager').closest('.selector-option') as HTMLElement);

    expect(document.querySelector('.node-process-dropdown')).toBeTruthy();
    expect(screen.getByText(/PID 1234/)).toBeTruthy();
  });
});
