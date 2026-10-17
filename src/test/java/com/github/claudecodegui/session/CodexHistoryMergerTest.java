package com.github.claudecodegui.session;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

/** Verifies history source boundaries and submission identity reconciliation. */
public class CodexHistoryMergerTest {
    @Test
    public void nativeConfirmationWinsOverTheSameOptimisticSubmission() {
        var local = this.row("local", "native", "client", null);
        var nativeRow = this.row("confirmed", "native", "client", "item");
        assertSame(nativeRow, CodexHistoryMerger.merge(List.of(nativeRow), List.of(local)).get(0));
        assertSame(nativeRow, CodexHistoryMerger.merge(List.of(local), List.of(nativeRow)).get(0));
    }

    @Test
    public void sourceReplacementKeepsOnlyUnconfirmedWorkAndPreservesRepeatedText() {
        var legacy = this.row("same", "legacy", null, null);
        var first = this.row("same", "native", "first", "one");
        var second = this.row("same", "native", "second", "two");
        var uncertain = this.row("uncertain", null, "pending", null);
        var result = CodexHistoryMerger.reconcile(List.of(first, second), List.of(legacy, uncertain));
        assertEquals(List.of(first, second, uncertain), result);
        assertEquals(List.of(legacy, uncertain), CodexHistoryMerger.reconcile(List.of(legacy), List.of(first, uncertain)));
    }

    private ClaudeSession.Message row(String text, String source, String client, String item) {
        JsonObject raw = new JsonObject();
        raw.addProperty("uuid", text);
        if (source != null) raw.addProperty("historySource", source);
        if (client != null) raw.addProperty("clientMessageId", client);
        if (item != null) {
            raw.addProperty("codexItemId", item);
            raw.addProperty("codexThreadId", "thread");
            raw.addProperty("codexTurnId", "turn");
        }
        return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, text, raw);
    }
}
