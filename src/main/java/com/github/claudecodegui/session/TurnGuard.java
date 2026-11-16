package com.github.claudecodegui.session;

/**
 * The turn a provider message handler was created for. A new handler is built per
 * send, and the previous provider process can still report after the next send
 * started (Stop, stream_end) or after the session was replaced, so every handler
 * must drop callbacks once this no longer matches the session.
 */
final class TurnGuard {
    private final SessionState state;
    private final Object turnOwner;
    private final String runtimeSessionEpoch;
    private final String executionBindingEpoch;

    TurnGuard(SessionState state, Object turnOwner) {
        this.state = state;
        this.turnOwner = turnOwner;
        this.runtimeSessionEpoch = state.getRuntimeSessionEpoch();
        this.executionBindingEpoch = state.getExecutionSnapshot().bindingEpoch();
    }

    boolean ownsCurrentTurn() {
        return state.isCurrentTurn(turnOwner) && runtimeSessionEpoch.equals(state.getRuntimeSessionEpoch())
                && state.getExecutionState().isCurrentBinding(executionBindingEpoch);
    }
}
