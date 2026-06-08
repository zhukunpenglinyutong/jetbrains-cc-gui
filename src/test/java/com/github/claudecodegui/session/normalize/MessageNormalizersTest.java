package com.github.claudecodegui.session.normalize;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class MessageNormalizersTest {

    @Test
    public void factoryKeepsProviderAndRuntimeImplementationsIndependent() {
        RecordingCallback delegate = new RecordingCallback();

        assertEquals(ClaudeSdkMessageNormalizer.class,
                MessageNormalizers.forRuntime("claude", "sdk", delegate).getClass());
        assertEquals(ClaudeCliMessageNormalizer.class,
                MessageNormalizers.forRuntime("claude", "cli", delegate).getClass());
        assertEquals(CodexSdkMessageNormalizer.class,
                MessageNormalizers.forRuntime("codex", "sdk", delegate).getClass());
        assertEquals(CodexCliMessageNormalizer.class,
                MessageNormalizers.forRuntime("codex", "cli", delegate).getClass());
    }

    @Test
    public void codexCliNormalizerSuppressesTextOnlyAssistantSnapshotsButKeepsToolUse() {
        RecordingCallback delegate = new RecordingCallback();
        MessageCallback normalizer = new CodexCliMessageNormalizer(delegate);

        normalizer.onMessage("stream_start", "");
        normalizer.onMessage("content_delta", "hello");
        normalizer.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}");
        normalizer.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Bash\",\"input\":{}}]}}");

        assertEquals(List.of("stream_start", "content_delta", "assistant"), delegate.types);
        assertTrue(delegate.contents.get(2).contains("\"tool_use\""));
        assertFalse(delegate.contents.stream().anyMatch(content -> content.contains("\"text\":\"hello\"")));
    }

    private static final class RecordingCallback implements MessageCallback {
        final List<String> types = new ArrayList<>();
        final List<String> contents = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
            types.add(type);
            contents.add(content);
        }

        @Override
        public void onError(String error) {
        }

        @Override
        public void onComplete(SDKResult result) {
        }

        @Override
        public void onQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState state, int aheadCount) {
        }
    }
}
