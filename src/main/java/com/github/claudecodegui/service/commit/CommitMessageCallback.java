package com.github.claudecodegui.service.commit;

/**
 * Callback for commit-message generation.
 *
 * <p>{@code onProgress} is optional (default no-op) and invoked on the EDT with
 * a partial preview while the model streams, so the commit box can render text
 * incrementally.
 */
public interface CommitMessageCallback {

    void onSuccess(String commitMessage);

    void onError(String error);

    /** Optional streaming preview (called on EDT). */
    default void onProgress(String partial) {
        // no-op by default
    }
}
