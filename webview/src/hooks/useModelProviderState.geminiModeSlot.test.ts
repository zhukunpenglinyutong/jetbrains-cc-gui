import { act, renderHook } from '@testing-library/react';
import { useModelProviderState } from './useModelProviderState.js';

/**
 * Story 1.5 review patch P1: the gemini permission-mode slot's ORCHESTRATION
 * wiring — `handleModeSelect` writing the slot and emitting an un-coerced
 * `set_mode`, and `handleProviderSelect` restoring the gemini posture on
 * switch-back — had no executable test (the persistence hook's tests seed
 * localStorage directly; useMessageSender's tests mock handleModeSelect).
 * These interaction tests pin the wiring: reverting the slot to the shared
 * claude one must fail here (the exact cross-provider posture leak the slot
 * exists to prevent — AC1/AC6).
 */
describe('useModelProviderState gemini permission-mode slot (Story 1.5)', () => {
  const t = ((key: string) => key) as any;
  const addToast = vi.fn();

  beforeEach(() => {
    window.sendToJava = vi.fn();
    // useModelStatePersistence restores the persisted provider/model on mount.
    localStorage.clear();
  });

  afterEach(() => {
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
  });

  function setup() {
    return renderHook(() => useModelProviderState({ addToast, t, onSessionResetRequest: vi.fn() }));
  }

  /** All set_mode bridge events sent so far, in order. */
  const modeEvents = () =>
    (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .filter((event) => event.startsWith('set_mode:'));

  it('emits an un-coerced set_mode on gemini and keeps the slot across a provider round-trip', () => {
    const { result } = setup();

    act(() => result.current.setCurrentProvider('gemini'));
    act(() => result.current.handleModeSelect('sandbox'));
    expect(modeEvents()).toContain('set_mode:sandbox');

    // Switch away and back: the gemini posture must survive (AC1) — the
    // claude slot's mode must neither leak in nor overwrite it.
    act(() => result.current.handleProviderSelect('claude'));
    act(() => result.current.handleProviderSelect('gemini'));

    expect(modeEvents()).toEqual(['set_mode:sandbox', 'set_mode:default', 'set_mode:sandbox']);
  });

  it("does not leak claude's posture into the gemini slot on provider switch", () => {
    const { result } = setup();

    act(() => result.current.setCurrentProvider('claude'));
    act(() => result.current.handleModeSelect('bypassPermissions'));
    // Switching to gemini derives the mode from the GEMINI slot (default),
    // not from claude's bypassPermissions.
    act(() => result.current.handleProviderSelect('gemini'));

    const events = modeEvents();
    // The full sequence: claude's pick, then default from the gemini slot —
    // bypassPermissions must not re-appear on the gemini switch.
    expect(events).toEqual(['set_mode:bypassPermissions', 'set_mode:default']);
  });

  it('keeps gemini plan native across switches (no CLI plan downgrade for gemini)', () => {
    const { result } = setup();

    act(() => result.current.setCurrentProvider('gemini'));
    act(() => result.current.handleModeSelect('plan'));
    act(() => result.current.handleProviderSelect('claude'));
    // claude keeps its own default posture while gemini's plan is parked.
    expect(modeEvents()).toEqual(['set_mode:plan', 'set_mode:default']);
    act(() => result.current.handleProviderSelect('gemini'));
    expect(modeEvents()).toEqual(['set_mode:plan', 'set_mode:default', 'set_mode:plan']);
  });
});
