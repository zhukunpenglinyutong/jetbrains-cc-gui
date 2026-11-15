import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  ttEnsureServer: vi.fn(),
  ttInstallCli: vi.fn(),
}));

vi.mock('./tokentrackerBridge', () => ({
  isTokenTrackerBridgeAvailable: () => true,
  ...bridge,
}));

import { ensureServerWithUpgrade } from './useTokenTrackerServer';

const ready = { running: true, port: 7680 };

describe('ensureServerWithUpgrade', () => {
  beforeEach(() => {
    bridge.ttEnsureServer.mockReset();
    bridge.ttInstallCli.mockReset();
  });

  it('returns the server without installing when the CLI is current', async () => {
    bridge.ttEnsureServer.mockResolvedValueOnce(ready);
    const onUpgrade = vi.fn();

    await expect(ensureServerWithUpgrade(onUpgrade)).resolves.toEqual(ready);
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(bridge.ttInstallCli).not.toHaveBeenCalled();
  });

  it('installs the pinned CLI and ensures again when the CLI is outdated', async () => {
    bridge.ttEnsureServer
      .mockRejectedValueOnce(new Error('tokentracker_cli_outdated'))
      .mockResolvedValueOnce(ready);
    bridge.ttInstallCli.mockResolvedValueOnce({ installed: true });
    const onUpgrade = vi.fn();

    await expect(ensureServerWithUpgrade(onUpgrade)).resolves.toEqual(ready);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(bridge.ttInstallCli).toHaveBeenCalledTimes(1);
    expect(bridge.ttEnsureServer).toHaveBeenCalledTimes(2);
  });

  it('still ensures after a failed upgrade so the old CLI keeps working', async () => {
    bridge.ttEnsureServer
      .mockRejectedValueOnce(new Error('tokentracker_cli_outdated'))
      .mockResolvedValueOnce(ready);
    bridge.ttInstallCli.mockRejectedValueOnce(new Error('npm EACCES'));

    await expect(ensureServerWithUpgrade(() => {})).resolves.toEqual(ready);
    expect(bridge.ttEnsureServer).toHaveBeenCalledTimes(2);
  });

  it('passes other errors through without installing', async () => {
    bridge.ttEnsureServer.mockRejectedValueOnce(new Error('tokentracker_cli_not_installed'));

    await expect(ensureServerWithUpgrade(() => {})).rejects.toThrow('tokentracker_cli_not_installed');
    expect(bridge.ttInstallCli).not.toHaveBeenCalled();
  });
});
