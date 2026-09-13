package com.github.claudecodegui.service.commit;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Extracts the final commit message from the model's raw output.
 *
 * <p>Three-step extraction:
 * <ol>
 *     <li>{@code <commit>...</commit>} tags (the enforced contract).</li>
 *     <li>The first markdown code fence as a fallback.</li>
 *     <li>The trimmed raw text as a last resort.</li>
 * </ol>
 *
 * <p>The legacy heuristic machinery ({@code isAnalysisSection},
 * {@code isConventionalCommitLine}, thinking-marker stripping, …) was removed:
 * with {@code disableThinking=true} + a strict {@code <commit>} output contract
 * those band-aids are no longer needed.
 */
public final class CommitMessageCleanup {

    private static final String COMMIT_TAG_START = "<commit>";
    private static final String COMMIT_TAG_END = "</commit>";

    private CommitMessageCleanup() {
    }

    @NotNull
    public static String clean(@Nullable String message) {
        if (message == null || message.isEmpty()) {
            return "";
        }
        String cleaned = message.trim();

        // 1. Extract from <commit>...</commit> tags.
        int startIdx = cleaned.indexOf(COMMIT_TAG_START);
        int endIdx = cleaned.indexOf(COMMIT_TAG_END);
        if (startIdx != -1 && endIdx != -1 && endIdx > startIdx) {
            return convertLiteralNewlines(
                    cleaned.substring(startIdx + COMMIT_TAG_START.length(), endIdx).trim());
        }

        // 2. Fallback: first markdown code fence.
        if (cleaned.contains("```")) {
            int codeBlockStart = cleaned.indexOf("```");
            int contentStart = cleaned.indexOf('\n', codeBlockStart);
            if (contentStart != -1) {
                int codeBlockEnd = cleaned.indexOf("```", contentStart);
                if (codeBlockEnd != -1) {
                    return convertLiteralNewlines(cleaned.substring(contentStart + 1, codeBlockEnd).trim());
                }
            }
        }

        // 3. Last resort: trimmed raw text.
        return convertLiteralNewlines(cleaned);
    }

    /**
     * Convert literal {@code \n} characters to real newlines and collapse runs
     * of blank lines (preserving the conventional title/body separator).
     */
    @NotNull
    public static String convertLiteralNewlines(@Nullable String text) {
        if (text == null) {
            return "";
        }
        String result = text.replace("\\n", "\n");
        result = result.replaceFirst("^\\n+", "");
        result = result.replaceAll("\\n{3,}", "\n\n");
        return result.trim();
    }
}
