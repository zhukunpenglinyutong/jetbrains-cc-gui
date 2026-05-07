package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Deduplicates streaming deltas that were already included via conservative full-message sync.
 *
 * <p>Not thread-safe. All methods must be called from the SDK callback thread.
 * Field visibility to EDT is guaranteed by the happens-before relationship
 * established through {@code ApplicationManager.invokeLater()}.
 */
final class ReplayDeduplicator {

    static final int NO_SYNCED_REPLAY = -1;

    private int syncedContentOffset = NO_SYNCED_REPLAY;
    private String syncedContentReplay = null;
    private int syncedThinkingOffset = NO_SYNCED_REPLAY;
    private String syncedThinkingReplay = null;

    void reset() {
        syncedContentOffset = NO_SYNCED_REPLAY;
        syncedContentReplay = null;
        syncedThinkingOffset = NO_SYNCED_REPLAY;
        syncedThinkingReplay = null;
    }

    static int replayOffset(int fallbackOffset, int currentOffset) {
        return currentOffset >= 0 ? currentOffset : fallbackOffset;
    }

    void beginContentReplay(String replayContent, int offset) {
        if (replayContent == null || offset >= replayContent.length()) {
            syncedContentReplay = null;
            syncedContentOffset = NO_SYNCED_REPLAY;
            return;
        }
        syncedContentReplay = replayContent;
        syncedContentOffset = Math.max(0, offset);
    }

    void beginThinkingReplay(String replayContent, int offset) {
        if (replayContent == null || offset >= replayContent.length()) {
            syncedThinkingReplay = null;
            syncedThinkingOffset = NO_SYNCED_REPLAY;
            return;
        }
        syncedThinkingReplay = replayContent;
        syncedThinkingOffset = Math.max(0, offset);
    }

    int contentOffset() {
        return syncedContentOffset;
    }

    int thinkingOffset() {
        return syncedThinkingOffset;
    }

    String consumeContentDelta(String delta) {
        ReplayResult result = consumeSyncedReplay(delta, syncedContentReplay, syncedContentOffset);
        syncedContentReplay = result.replayContent;
        syncedContentOffset = result.offset;
        return result.novelDelta;
    }

    String consumeThinkingDelta(String delta) {
        ReplayResult result = consumeSyncedReplay(delta, syncedThinkingReplay, syncedThinkingOffset);
        syncedThinkingReplay = result.replayContent;
        syncedThinkingOffset = result.offset;
        return result.novelDelta;
    }

    private ReplayResult consumeSyncedReplay(String delta, String replayContent, int offset) {
        if (delta == null || delta.isEmpty() || replayContent == null || offset < 0) {
            return ReplayResult.inactive(delta);
        }

        int safeOffset = Math.min(Math.max(0, offset), replayContent.length());
        int replayIndex = safeOffset;

        int consumed = 0;
        while (consumed < delta.length()
                && replayIndex + consumed < replayContent.length()
                && replayContent.charAt(replayIndex + consumed) == delta.charAt(consumed)) {
            consumed++;
        }
        // Fallback: if offset-based matching fails, check if the delta matches the tail
        // of the replay content (handles offset drift after partial syncs).
        // Guard with a length/offset check and ensure the matched tail starts at or
        // beyond the synced offset, so we do not silently swallow legitimate repeated
        // deltas that happen to share a suffix with already-synced replay content.
        if (consumed == 0
                && replayContent.length() > safeOffset
                && replayContent.endsWith(delta)
                && replayContent.lastIndexOf(delta) >= safeOffset) {
            replayIndex = replayContent.length() - delta.length();
            consumed = delta.length();
        } else if (consumed == 0) {
            return ReplayResult.inactive(delta);
        }

        int nextOffset = replayIndex + consumed;
        String novelDelta = delta.substring(consumed);
        if (nextOffset >= replayContent.length()) {
            return new ReplayResult(novelDelta, null, NO_SYNCED_REPLAY);
        }
        return new ReplayResult(novelDelta, replayContent, nextOffset);
    }

    // --- Static extraction helpers ---

    static String extractThinkingContent(JsonObject raw) {
        if (raw == null) {
            return "";
        }
        JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message") : null;
        if (message == null || !message.has("content") || !message.get("content").isJsonArray()) {
            return "";
        }

        StringBuilder sb = new StringBuilder();
        JsonArray contentArray = message.getAsJsonArray("content");
        for (int i = 0; i < contentArray.size(); i++) {
            if (!contentArray.get(i).isJsonObject()) {
                continue;
            }
            JsonObject block = contentArray.get(i).getAsJsonObject();
            String type = block.has("type") && !block.get("type").isJsonNull()
                    ? block.get("type").getAsString() : "";
            if (!"thinking".equals(type)) {
                continue;
            }
            String thinking = "";
            if (block.has("thinking") && !block.get("thinking").isJsonNull()) {
                thinking = block.get("thinking").getAsString();
            } else if (block.has("text") && !block.get("text").isJsonNull()) {
                thinking = block.get("text").getAsString();
            }
            if (!thinking.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append('\n');
                }
                sb.append(thinking);
            }
        }
        return sb.toString();
    }

    static String extractTextContent(JsonObject raw) {
        if (raw == null) {
            return "";
        }
        JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message") : null;
        if (message == null || !message.has("content") || !message.get("content").isJsonArray()) {
            return "";
        }

        StringBuilder sb = new StringBuilder();
        JsonArray contentArray = message.getAsJsonArray("content");
        for (int i = 0; i < contentArray.size(); i++) {
            if (!contentArray.get(i).isJsonObject()) {
                continue;
            }
            JsonObject block = contentArray.get(i).getAsJsonObject();
            String type = block.has("type") && !block.get("type").isJsonNull()
                    ? block.get("type").getAsString() : "";
            if ("text".equals(type) && block.has("text") && !block.get("text").isJsonNull()) {
                sb.append(block.get("text").getAsString());
            }
        }
        return sb.toString();
    }

    static SegmentActivity syncSegmentActivity(JsonObject raw) {
        JsonObject message = raw != null && raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message") : null;
        if (message == null || !message.has("content") || !message.get("content").isJsonArray()) {
            return new SegmentActivity(false, false);
        }

        JsonArray contentArray = message.getAsJsonArray("content");
        for (int i = contentArray.size() - 1; i >= 0; i--) {
            if (!contentArray.get(i).isJsonObject()) {
                continue;
            }
            JsonObject block = contentArray.get(i).getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull()) {
                continue;
            }
            String type = block.get("type").getAsString();
            return new SegmentActivity("text".equals(type), "thinking".equals(type));
        }
        return new SegmentActivity(false, false);
    }

    static final class SegmentActivity {
        final boolean textActive;
        final boolean thinkingActive;

        SegmentActivity(boolean textActive, boolean thinkingActive) {
            this.textActive = textActive;
            this.thinkingActive = thinkingActive;
        }
    }

    private static final class ReplayResult {
        private final String novelDelta;
        private final String replayContent;
        private final int offset;

        private ReplayResult(String novelDelta, String replayContent, int offset) {
            this.novelDelta = novelDelta != null ? novelDelta : "";
            this.replayContent = replayContent;
            this.offset = offset;
        }

        private static ReplayResult inactive(String delta) {
            return new ReplayResult(delta, null, NO_SYNCED_REPLAY);
        }
    }
}
