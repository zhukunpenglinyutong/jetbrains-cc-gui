import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplyHistoryModel, type ApplyHistoryModelDeps } from './applyHistoryModel';
import { sendBridgeEvent } from './utils/bridge';
import type { ModelInfo } from './components/ChatInputBox/types';

vi.mock('./utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));

const sendBridge = vi.mocked(sendBridgeEvent);

/**
 * Recording stubs for every dep. The setters are the contract under test:
 * exactly one provider slot may receive the history model, with an exact
 * value, alongside exact bridge events.
 */
function makeDeps(overrides: Partial<ApplyHistoryModelDeps> = {}): ApplyHistoryModelDeps {
  return {
    currentProvider: 'claude',
    longContextEnabled: false,
    handleProviderSelect: vi.fn(),
    handleAgentSelect: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setSelectedGrokModel: vi.fn(),
    setSelectedKimiModel: vi.fn(),
    setSelectedMiniMaxModel: vi.fn(),
    setSelectedOpenCodeModel: vi.fn(),
    setSelectedPiModel: vi.fn(),
    setSelectedDshModel: vi.fn(),
    setSelectedGeminiModel: vi.fn(),
    setSelectedOmpModel: vi.fn(),
    setOmpPermissionMode: vi.fn(),
    ...overrides,
  };
}

/** Build the App-facing callback the way App.tsx does (factory + roles). */
function makeApply(deps: ApplyHistoryModelDeps, ompRoles: ModelInfo[] = []) {
  return createApplyHistoryModel({ modelState: deps, ompRoles });
}

/** Assert ONLY `setter` fired, with exactly `value` (no cross-slot leakage). */
function expectOnlySetter(
  deps: ApplyHistoryModelDeps,
  setter: keyof ApplyHistoryModelDeps,
  value: string,
) {
  const allSetters: Array<keyof ApplyHistoryModelDeps> = [
    'setSelectedClaudeModel', 'setSelectedCodexModel', 'setSelectedGrokModel',
    'setSelectedKimiModel', 'setSelectedMiniMaxModel', 'setSelectedOpenCodeModel',
    'setSelectedPiModel', 'setSelectedDshModel', 'setSelectedGeminiModel',
    'setSelectedOmpModel',
  ];
  for (const name of allSetters) {
    const fn = deps[name] as ReturnType<typeof vi.fn>;
    if (name === setter) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(value);
    } else {
      expect(fn, `${String(name)} must stay untouched`).not.toHaveBeenCalled();
    }
  }
}

// The bridge mock is module-level: reset it between tests so call-count
// assertions measure one row application, not the whole run.
beforeEach(() => {
  sendBridge.mockClear();
});

describe('createApplyHistoryModel — gemini history rows', () => {
  it('routes the slug to the gemini slot UNCHANGED — no claude normalization', () => {
    const deps = makeDeps();
    // A slug that WOULD be mangled by the claude path ([1m] suffix + legacy
    // alias) must pass through verbatim on the gemini branch.
    const slug = 'claude-sonnet-4-6[1m]';
    makeApply(deps)('gemini', slug);

    expectOnlySetter(deps, 'setSelectedGeminiModel', slug);
    expect(sendBridge).toHaveBeenCalledTimes(1);
    expect(sendBridge).toHaveBeenCalledWith('set_model', slug);
    // No omp side effects either.
    expect(deps.setOmpPermissionMode).not.toHaveBeenCalled();
  });

  it('routes a real gemini catalog slug verbatim, including the effort tier', () => {
    const deps = makeDeps({ longContextEnabled: true });
    makeApply(deps)('gemini', 'gemini-3.7-flash-high');

    expectOnlySetter(deps, 'setSelectedGeminiModel', 'gemini-3.7-flash-high');
    expect(sendBridge).toHaveBeenCalledWith('set_model', 'gemini-3.7-flash-high');
    // longContextEnabled must NOT append [1m] on the gemini path.
    expect(sendBridge).not.toHaveBeenCalledWith('set_model', 'gemini-3.7-flash-high[1m]');
  });
});

describe('createApplyHistoryModel — claude normalization preserved', () => {
  it('aliases a retired model id and strips [1m] for the slot', () => {
    const deps = makeDeps();
    makeApply(deps)('claude', 'claude-opus-4-6[1m]');

    expectOnlySetter(deps, 'setSelectedClaudeModel', 'claude-opus-5');
    // The bridge event re-applies the suffix per longContextEnabled (false
    // here): the slot stores the base id, the wire carries the effective id.
    expect(sendBridge).toHaveBeenCalledTimes(1);
    expect(sendBridge).toHaveBeenCalledWith('set_model', 'claude-opus-5');
  });

  it('re-applies [1m] on the wire when longContextEnabled', () => {
    const deps = makeDeps({ longContextEnabled: true });
    makeApply(deps)('claude', 'claude-sonnet-5[1m]');

    expectOnlySetter(deps, 'setSelectedClaudeModel', 'claude-sonnet-5');
    expect(sendBridge).toHaveBeenCalledWith('set_model', 'claude-sonnet-5[1m]');
  });

  it('treats an unrecognized provider as claude (fallback branch)', () => {
    const deps = makeDeps();
    makeApply(deps)('some-future-provider', 'model-x');

    expectOnlySetter(deps, 'setSelectedClaudeModel', 'model-x');
    expect(sendBridge).toHaveBeenCalledWith('set_model', 'model-x');
  });
});

describe('createApplyHistoryModel — plain pass-through providers', () => {
  // codex/grok/kimi/minimax/opencode/pi/dsh: own slot + raw set_model, nothing else.
  const passThrough = [
    'codex', 'grok', 'kimi', 'minimax', 'opencode', 'pi', 'dsh',
  ] as const;

  for (const provider of passThrough) {
    it(`${provider} routes raw to its own slot + set_model`, () => {
      const deps = makeDeps();
      const setter = ({
        codex: 'setSelectedCodexModel',
        grok: 'setSelectedGrokModel',
        kimi: 'setSelectedKimiModel',
        minimax: 'setSelectedMiniMaxModel',
        opencode: 'setSelectedOpenCodeModel',
        pi: 'setSelectedPiModel',
        dsh: 'setSelectedDshModel',
      } as const)[provider];
      makeApply(deps)(provider, `model-for-${provider}`);

      expectOnlySetter(deps, setter, `model-for-${provider}`);
      expect(sendBridge).toHaveBeenCalledTimes(1);
      expect(sendBridge).toHaveBeenCalledWith('set_model', `model-for-${provider}`);
      expect(deps.setOmpPermissionMode).not.toHaveBeenCalled();
    });
  }

  it('dsh does not normalize a claude-shaped slug', () => {
    const deps = makeDeps();
    makeApply(deps)('dsh', 'claude-sonnet-4-6[1m]');
    expectOnlySetter(deps, 'setSelectedDshModel', 'claude-sonnet-4-6[1m]');
  });
});

describe('createApplyHistoryModel — omp mode⇔model unification', () => {
  it('a role id sets the matching mode and sends both bridge events', () => {
    const deps = makeDeps();
    makeApply(deps, [{ id: 'plan', label: 'Plan' }])('omp', 'plan');

    expectOnlySetter(deps, 'setSelectedOmpModel', 'plan');
    expect(deps.setOmpPermissionMode).toHaveBeenCalledWith('plan');
    expect(sendBridge).toHaveBeenCalledWith('set_model', 'plan');
    expect(sendBridge).toHaveBeenCalledWith('set_mode', 'plan');
  });

  it('a catalog model id unifies to default mode, which still sends set_mode', () => {
    const deps = makeDeps();
    makeApply(deps, [{ id: 'smol', label: 'Smol' }])('omp', 'qwen3-coder');

    expectOnlySetter(deps, 'setSelectedOmpModel', 'qwen3-coder');
    expect(deps.setOmpPermissionMode).toHaveBeenCalledWith('default');
    expect(sendBridge).toHaveBeenCalledWith('set_mode', 'default');
  });

  it('a dynamic role outside Java’s static whitelist skips set_mode', () => {
    const deps = makeDeps();
    makeApply(deps, [{ id: 'custom-role', label: 'Custom' }])('omp', 'custom-role');

    expectOnlySetter(deps, 'setSelectedOmpModel', 'custom-role');
    expect(deps.setOmpPermissionMode).toHaveBeenCalledWith('custom-role');
    expect(sendBridge).toHaveBeenCalledTimes(1);
    expect(sendBridge).toHaveBeenCalledWith('set_model', 'custom-role');
    expect(sendBridge).not.toHaveBeenCalledWith('set_mode', 'custom-role');
  });
});

describe('createApplyHistoryModel — provider switch and agent restore', () => {
  it('switches provider first when the history row differs from the current one', () => {
    const deps = makeDeps({ currentProvider: 'claude' });
    makeApply(deps)('gemini', 'gemini-3.7-flash-high');

    expect(deps.handleProviderSelect).toHaveBeenCalledTimes(1);
    expect(deps.handleProviderSelect).toHaveBeenCalledWith('gemini');
  });

  it('does not re-switch when the row matches the current provider', () => {
    const deps = makeDeps({ currentProvider: 'gemini' });
    makeApply(deps)('gemini', 'gemini-3.7-flash-high');

    expect(deps.handleProviderSelect).not.toHaveBeenCalled();
    expectOnlySetter(deps, 'setSelectedGeminiModel', 'gemini-3.7-flash-high');
  });

  it('restores an agent only for claude rows', () => {
    const claude = makeDeps();
    makeApply(claude)('claude', 'claude-sonnet-5', 'my-agent');
    expect(claude.handleAgentSelect).toHaveBeenCalledWith({ id: 'my-agent', name: 'my-agent', prompt: '' });

    const gemini = makeDeps();
    makeApply(gemini)('gemini', 'gemini-3.7-flash-high', 'my-agent');
    expect(gemini.handleAgentSelect).not.toHaveBeenCalled();
  });

  it('ignores an agent field on a row without a model', () => {
    const deps = makeDeps();
    // '' is the type-clean spelling of "row without a model" (the callback
    // signature takes string; the `if (model)` guard is what skips routing).
    makeApply(deps)('claude', '', 'my-agent');
    expect(deps.handleAgentSelect).toHaveBeenCalledWith({ id: 'my-agent', name: 'my-agent', prompt: '' });
    for (const setter of [
      'setSelectedClaudeModel', 'setSelectedCodexModel', 'setSelectedGeminiModel',
    ] as const) {
      expect(deps[setter]).not.toHaveBeenCalled();
    }
    expect(sendBridge).not.toHaveBeenCalled();
  });
});
