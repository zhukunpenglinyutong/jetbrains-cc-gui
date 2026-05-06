package com.github.claudecodegui.action.editor;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import org.jetbrains.annotations.NotNull;

import java.util.Objects;
import java.util.function.Consumer;

final class SelectionReferenceFailureHandler {

    private static final String SELECT_CODE_FIRST_KEY = "send.selectCodeFirst";

    private SelectionReferenceFailureHandler() {
    }

    static void showBuildFailure(@NotNull SelectionReferenceBuilder.Result result,
                                 @NotNull String selectCodeFirstMessageKey,
                                 @NotNull Consumer<String> infoCallback,
                                 @NotNull Consumer<String> errorCallback) {
        String messageKey = Objects.requireNonNull(
                result.getMessageKey(),
                "Failure result must contain a message key"
        );

        if (SELECT_CODE_FIRST_KEY.equals(messageKey)) {
            infoCallback.accept(ClaudeCodeGuiBundle.message(selectCodeFirstMessageKey));
            return;
        }
        errorCallback.accept(ClaudeCodeGuiBundle.message(messageKey));
    }

    static void showBuildFailure(@NotNull SelectionReferenceBuilder.Result result,
                                 @NotNull Consumer<String> infoCallback,
                                 @NotNull Consumer<String> errorCallback) {
        showBuildFailure(result, SELECT_CODE_FIRST_KEY, infoCallback, errorCallback);
    }
}
