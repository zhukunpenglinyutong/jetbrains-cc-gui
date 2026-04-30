package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Content rebuild utility.
 * Derives the pre-edit content by reverse-applying edit operations to the post-edit content.
 */
public final class ContentRebuildUtil {

    private static final Logger LOG = Logger.getInstance(ContentRebuildUtil.class);

    private ContentRebuildUtil() {
    }

    /**
     * Reverse-rebuild the pre-edit content from the post-edit content.
     * Uses the fail-closed UndoOperationApplier; if any operation cannot be matched safely,
     * the returned content remains the post-edit content via rebuildBeforeContentResult.
     */
    public static String rebuildBeforeContent(String afterContent, JsonArray edits) {
        return rebuildBeforeContentResult(afterContent, edits).content();
    }

    /**
     * Reverse-rebuild the pre-edit content and report skipped operations.
     */
    public static RebuildResult rebuildBeforeContentResult(String afterContent, JsonArray edits) {
        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits(afterContent, edits);
        JsonArray skippedOperations = new JsonArray();
        if (!result.isSuccess()) {
            for (UndoOperationApplier.Failure failure : result.getFailures()) {
                JsonObject skipped = new JsonObject();
                skipped.addProperty("operationIndex", failure.operationIndex());
                skipped.addProperty("reason", failure.reason());
                skipped.addProperty("message", failure.message());
                skippedOperations.add(skipped);
            }
            LOG.warn("rebuildBeforeContent failed: " + skippedOperations);
            return new RebuildResult(false, afterContent, skippedOperations);
        }
        LOG.info("Rebuilt before content (" + edits.size() + " operations, 0 skipped)");
        return new RebuildResult(true, result.getContent(), skippedOperations);
    }

    public record RebuildResult(boolean success, String content, JsonArray skippedOperations) {
    }
}
