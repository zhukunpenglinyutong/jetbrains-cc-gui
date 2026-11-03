package com.github.claudecodegui.provider.claude;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * History reload must show a folded steer as a user row. Only prompt/user-prompt
 * queued_command attachments are steered; every other row (task notifications,
 * subagent carriers, plain messages) has to pass through untouched.
 */
public class QueuedCommandHistoryRewriteTest {

    private final Gson gson = new Gson();

    private JsonObject parse(String json) {
        return gson.fromJson(json, JsonObject.class);
    }

    @Test
    public void rewrite_nullRowReturnsNull() {
        assertNull(QueuedCommandHistoryRewrite.rewrite(null));
    }

    @Test
    public void rewrite_nonAttachmentRowIsReturnedUnchanged() {
        JsonObject row = parse("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}");

        assertSame(row, QueuedCommandHistoryRewrite.rewrite(row));
    }

    @Test
    public void rewrite_otherAttachmentTypeIsReturnedUnchanged() {
        JsonObject row = parse("{\"type\":\"attachment\",\"attachment\":{\"type\":\"file\",\"commandMode\":\"prompt\"}}");

        assertSame(row, QueuedCommandHistoryRewrite.rewrite(row));
    }

    @Test
    public void rewrite_taskNotificationQueuedCommandIsReturnedUnchanged() {
        JsonObject row = parse("{\"type\":\"attachment\",\"attachment\":"
                + "{\"type\":\"queued_command\",\"commandMode\":\"task-notification\",\"prompt\":\"<task-notification/>\"}}");

        assertSame(row, QueuedCommandHistoryRewrite.rewrite(row));
    }

    @Test
    public void rewrite_promptQueuedCommandBecomesSteeredUserRow() {
        JsonObject row = parse("{\"type\":\"attachment\",\"uuid\":\"u-1\",\"timestamp\":\"2026-01-01T00:00:00Z\","
                + "\"attachment\":{\"type\":\"queued_command\",\"commandMode\":\"prompt\",\"prompt\":\"do not touch file B\"}}");

        JsonObject rewritten = QueuedCommandHistoryRewrite.rewrite(row);

        assertEquals("user", rewritten.get("type").getAsString());
        assertTrue(rewritten.get("steered").getAsBoolean());
        assertEquals("do not touch file B",
                rewritten.getAsJsonObject("message").get("content").getAsString());
        assertEquals("user", rewritten.getAsJsonObject("message").get("role").getAsString());
        // Bookkeeping fields survive so the row keeps its place in the session.
        assertEquals("u-1", rewritten.get("uuid").getAsString());
        assertEquals("2026-01-01T00:00:00Z", rewritten.get("timestamp").getAsString());
        assertFalse(rewritten.has("attachment"));
    }

    @Test
    public void rewrite_userPromptModeWithoutPromptYieldsEmptyContent() {
        JsonObject row = parse("{\"type\":\"attachment\",\"attachment\":"
                + "{\"type\":\"queued_command\",\"commandMode\":\"user-prompt\"}}");

        JsonObject rewritten = QueuedCommandHistoryRewrite.rewrite(row);

        assertEquals("user", rewritten.get("type").getAsString());
        assertEquals("", rewritten.getAsJsonObject("message").get("content").getAsString());
    }

    @Test
    public void rewrite_promptArrayIsPassedThroughVerbatim() {
        JsonObject row = parse("{\"type\":\"attachment\",\"attachment\":{\"type\":\"queued_command\","
                + "\"commandMode\":\"prompt\",\"prompt\":[{\"type\":\"text\",\"text\":\"steer me\"}]}}");

        JsonObject rewritten = QueuedCommandHistoryRewrite.rewrite(row);
        JsonArray content = rewritten.getAsJsonObject("message").getAsJsonArray("content");

        assertEquals(1, content.size());
        assertEquals("steer me", content.get(0).getAsJsonObject().get("text").getAsString());
    }
}
