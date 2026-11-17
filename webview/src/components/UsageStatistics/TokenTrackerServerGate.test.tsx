import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TokenTrackerServerState } from './useTokenTrackerServer';

const hook = vi.hoisted(() => ({
  state: { status: 'checking' } as TokenTrackerServerState,
}));

vi.mock('./useTokenTrackerServer', () => ({
  useTokenTrackerServer: () => ({ state: hook.state, retry: vi.fn(), install: vi.fn() }),
}));

vi.mock('./useTokenTrackerViewBridge', () => ({
  useTokenTrackerViewBridge: () => ({ remountKey: 0 }),
}));

import { TokenTrackerServerGate } from './TokenTrackerServerGate';
import type { TokenTrackerGateCopy } from './TokenTrackerServerGate';

const copy: TokenTrackerGateCopy = {
  checkingLabel: 'checking',
  installingLabel: 'installing',
  installingDesc: 'installing desc',
  startingLabel: 'starting',
  guideTitle: 'guide',
  guideDesc: 'guide desc',
  guideInstallLabel: 'install label',
  guideCopy: 'copy',
  guideCopied: 'copied',
  guideInstallNow: 'install now',
  guideNoteHooks: 'hooks',
  guideNoteTelemetry: 'telemetry',
  errorTitle: 'error',
  errorRetry: 'retry',
  staleConfigDirNotice: 'stale config dir notice',
};

const Icon = () => null;

function renderGate() {
  return render(
    <TokenTrackerServerGate icon={Icon} copy={copy} dashboardClassName="dash">
      <div>dashboard body</div>
    </TokenTrackerServerGate>,
  );
}

describe('TokenTrackerServerGate stale config directory notice', () => {
  beforeEach(() => {
    hook.state = { status: 'checking' };
  });

  it('shows the notice above the dashboard when the running server predates the config directory', () => {
    hook.state = { status: 'ready', port: 7680, configDirStale: true };
    renderGate();
    expect(screen.getByText('stale config dir notice')).toBeTruthy();
    expect(screen.getByText('dashboard body')).toBeTruthy();
  });

  it('shows no notice when the server is current', () => {
    hook.state = { status: 'ready', port: 7680 };
    renderGate();
    expect(screen.queryByText('stale config dir notice')).toBeNull();
    expect(screen.getByText('dashboard body')).toBeTruthy();
  });

  it('shows no notice while the server is still starting', () => {
    hook.state = { status: 'starting' };
    renderGate();
    expect(screen.queryByText('stale config dir notice')).toBeNull();
  });

  it('shows no notice on the error screen', () => {
    hook.state = { status: 'error', message: 'boom' };
    renderGate();
    expect(screen.queryByText('stale config dir notice')).toBeNull();
  });
});
