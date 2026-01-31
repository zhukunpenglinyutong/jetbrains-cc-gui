package com.github.claudecodegui.handler.diff;

import org.jetbrains.annotations.Nullable;

/**
 * Result of an interactive diff operation.
 */
public class DiffResult {
    private final DiffAction action;
    private final String finalContent;

    /**
     * Creates a new DiffResult.
     *
     * @param action       The action taken by the user (APPLY, REJECT, or DISMISS)
     * @param finalContent The final content after user edits (null if rejected or dismissed)
     */
    public DiffResult(DiffAction action, @Nullable String finalContent) {
        this.action = action;
        this.finalContent = finalContent;
    }

    /**
     * Creates an APPLY result with the given content.
     */
    public static DiffResult apply(String finalContent) {
        return new DiffResult(DiffAction.APPLY, finalContent);
    }

    /**
     * Creates a REJECT result (user clicked Reject button).
     */
    public static DiffResult reject() {
        return new DiffResult(DiffAction.REJECT, null);
    }

    /**
     * Creates a DISMISS result (user closed the window without action).
     */
    public static DiffResult dismiss() {
        return new DiffResult(DiffAction.DISMISS, null);
    }

    public DiffAction getAction() {
        return action;
    }

    @Nullable
    public String getFinalContent() {
        return finalContent;
    }

    public boolean isApplied() {
        return action == DiffAction.APPLY;
    }

    public boolean isRejected() {
        return action == DiffAction.REJECT;
    }

    /**
     * Returns true if the user dismissed the diff view without taking action.
     */
    public boolean isDismissed() {
        return action == DiffAction.DISMISS;
    }

    @Override
    public String toString() {
        return "DiffResult{" +
                "action=" + action +
                ", hasContent=" + (finalContent != null) +
                '}';
    }
}
