import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const bridge = vi.hoisted(() => ({
  ttEnsureServer: vi.fn(),
  ttInstallCli: vi.fn(),
}));

vi.mock('./tokentrackerBridge', () => ({
  isTokenTrackerBridgeAvailable: () => true,
  ...bridge,
}));

import { useTokenTrackerServer } from './useTokenTrackerServer';

describe('useTokenTrackerServer config directory staleness', () => {
  beforeEach(() => {
    bridge.ttEnsureServer.mockReset();
    bridge.ttInstallCli.mockReset();
  });

  it('carries configDirStale into the ready state', async () => {
    bridge.ttEnsureServer.mockResolvedValueOnce({ running: true, port: 7681, configDirStale: true });
    const { result } = renderHook(() => useTokenTrackerServer());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toEqual({ status: 'ready', port: 7681, configDirStale: true });
  });

  it('leaves configDirStale out when the server is current', async () => {
    bridge.ttEnsureServer.mockResolvedValueOnce({ running: true, port: 7680 });
    const { result } = renderHook(() => useTokenTrackerServer());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toStrictEqual({ status: 'ready', port: 7680 });
  });

  it('ignores a falsy configDirStale', async () => {
    bridge.ttEnsureServer.mockResolvedValueOnce({ running: true, port: 7680, configDirStale: false });
    const { result } = renderHook(() => useTokenTrackerServer());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state).toStrictEqual({ status: 'ready', port: 7680 });
  });
});
