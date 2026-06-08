package com.github.claudecodegui.cli.codex;

import com.github.claudecodegui.cli.CliSessionCallback;
import org.junit.Test;

import java.lang.reflect.Method;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodexCliSessionTest {

    @Test
    public void reasoningItemCompletedEmitsThinkingDelta() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-1");
        RecordingCallback callback = new RecordingCallback();

        invokeParseEvent(
                session,
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"reasoning\",\"text\":\"Searching\"}}",
                callback,
                new StringBuilder()
        );

        assertTrue(callback.events.stream().anyMatch(event -> "thinking_delta".equals(event.type) && "Searching".equals(event.content)));
    }

    @Test
    public void reasoningItemSummaryEmitsThinkingDelta() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-summary");
        RecordingCallback callback = new RecordingCallback();

        invokeParseEvent(
                session,
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"reasoning\",\"summary\":\"Searching\"}}",
                callback,
                new StringBuilder()
        );

        assertTrue(callback.events.stream().anyMatch(event -> "thinking_delta".equals(event.type) && "Searching".equals(event.content)));
    }

    @Test
    public void reasoningItemEmitsThinkingStartBeforeDelta() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-thinking");
        RecordingCallback callback = new RecordingCallback();

        invokeParseEvent(
                session,
                "{\"type\":\"item.started\",\"item\":{\"id\":\"r1\",\"type\":\"reasoning\",\"text\":\"first\"}}",
                callback,
                new StringBuilder()
        );

        // First reasoning event should emit both "thinking" start and "thinking_delta"
        int thinkingStartIndex = -1;
        int thinkingDeltaIndex = -1;
        for (int i = 0; i < callback.events.size(); i++) {
            Event e = callback.events.get(i);
            if ("thinking".equals(e.type) && thinkingStartIndex == -1) thinkingStartIndex = i;
            if ("thinking_delta".equals(e.type) && thinkingDeltaIndex == -1) thinkingDeltaIndex = i;
        }
        assertTrue("Should emit 'thinking' start signal", thinkingStartIndex >= 0);
        assertTrue("Should emit 'thinking_delta'", thinkingDeltaIndex >= 0);
        assertTrue("'thinking' should come before 'thinking_delta'", thinkingStartIndex < thinkingDeltaIndex);
    }

    @Test
    public void reasoningItemEmitsThinkingStartOnlyOnce() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-thinking-once");
        RecordingCallback callback = new RecordingCallback();

        // First update
        invokeParseEvent(
                session,
                "{\"type\":\"item.started\",\"item\":{\"id\":\"r2\",\"type\":\"reasoning\",\"text\":\"hello\"}}",
                callback,
                new StringBuilder()
        );
        // Second update (same ID)
        invokeParseEvent(
                session,
                "{\"type\":\"item.updated\",\"item\":{\"id\":\"r2\",\"type\":\"reasoning\",\"text\":\"hello world\"}}",
                callback,
                new StringBuilder()
        );

        long thinkingStartCount = callback.events.stream().filter(e -> "thinking".equals(e.type)).count();
        assertEquals("'thinking' start signal should be emitted exactly once", 1, thinkingStartCount);
    }

    @Test
    public void agentMessageUpdatesEmitOnlyAppendedContentDelta() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-agent");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(
                session,
                "{\"type\":\"item.updated\",\"item\":{\"id\":\"item_msg\",\"type\":\"agent_message\",\"text\":\"hello\"}}",
                callback,
                assistantContent
        );
        invokeParseEvent(
                session,
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_msg\",\"type\":\"agent_message\",\"text\":\"hello world\"}}",
                callback,
                assistantContent
        );

        assertEquals("hello world", assistantContent.toString());
        assertEquals(List.of("hello", " world"), callback.contentsOfType("content_delta"));
    }

    @Test
    public void agentMessageCompletionWithDifferentItemIdDoesNotReplayIdenticalTextDelta() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-agent-different-id");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(
                session,
                "{\"type\":\"item.updated\",\"item\":{\"id\":\"item_stream\",\"type\":\"agent_message\",\"text\":\"hello world\"}}",
                callback,
                assistantContent
        );
        invokeParseEvent(
                session,
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_completed\",\"type\":\"agent_message\",\"text\":\"hello world\"}}",
                callback,
                assistantContent
        );

        assertEquals("hello world", assistantContent.toString());
        assertEquals(List.of("hello world"), callback.contentsOfType("content_delta"));
    }

    @Test
    public void commandExecutionStartedAndCompletedEmitToolUseAndResult() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-command");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(
                session,
                "{\"type\":\"item.started\",\"item\":{\"id\":\"cmd_1\",\"type\":\"command_execution\",\"command\":\"git status\",\"status\":\"in_progress\"}}",
                callback,
                assistantContent
        );
        invokeParseEvent(
                session,
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"cmd_1\",\"type\":\"command_execution\",\"command\":\"git status\",\"exit_code\":0,\"output\":\"clean\"}}",
                callback,
                assistantContent
        );

        assertTrue(callback.events.stream().anyMatch(event -> "status".equals(event.type) && event.content.contains("正在执行命令")));
        assertTrue(callback.events.stream().anyMatch(event -> "assistant".equals(event.type)
                && event.content.contains("\"type\":\"tool_use\"")
                && event.content.contains("\"name\":\"Bash\"")
                && event.content.contains("git status")));
        assertTrue(callback.events.stream().anyMatch(event -> "user".equals(event.type)
                && event.content.contains("\"type\":\"tool_result\"")
                && event.content.contains("clean")));
    }

    @Test
    public void mcpToolCallStartedAndCompletedEmitToolUseAndResult() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-mcp");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(
                session,
                "{\"type\":\"item.started\",\"item\":{\"id\":\"mcp_1\",\"type\":\"mcp_tool_call\",\"server\":\"context7\",\"tool\":\"resolve-library-id\",\"arguments\":{\"libraryName\":\"react\"}}}",
                callback,
                assistantContent
        );
        invokeParseEvent(
                session,
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"mcp_1\",\"type\":\"mcp_tool_call\",\"server\":\"context7\",\"tool\":\"resolve-library-id\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"/facebook/react\"}]}}}",
                callback,
                assistantContent
        );

        assertTrue(callback.events.stream().anyMatch(event -> "assistant".equals(event.type)
                && event.content.contains("\"type\":\"tool_use\"")
                && event.content.contains("mcp__context7__resolve-library-id")));
        assertTrue(callback.events.stream().anyMatch(event -> "user".equals(event.type)
                && event.content.contains("\"type\":\"tool_result\"")
                && event.content.contains("/facebook/react")));
    }

    @Test
    public void responseItemFunctionCallAndOutputEmitToolUseAndResult() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-response-item-tool");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(
                session,
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"shell_command\",\"arguments\":\"{\\\"command\\\":\\\"rtk git status\\\"}\"}}",
                callback,
                assistantContent
        );
        invokeParseEvent(
                session,
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call-1\",\"output\":\"clean\"}}",
                callback,
                assistantContent
        );

        assertTrue(callback.events.stream().anyMatch(event -> "assistant".equals(event.type)
                && event.content.contains("\"type\":\"tool_use\"")
                && event.content.contains("\"id\":\"call-1\"")
                && event.content.contains("\"name\":\"shell_command\"")
                && event.content.contains("rtk git status")));
        assertTrue(callback.events.stream().anyMatch(event -> "user".equals(event.type)
                && event.content.contains("\"type\":\"tool_result\"")
                && event.content.contains("\"tool_use_id\":\"call-1\"")
                && event.content.contains("clean")));
    }

    @Test
    public void responseItemCustomToolCallEmitsToolUse() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-response-item-custom-tool");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(
                session,
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"call_id\":\"patch-1\",\"name\":\"apply_patch\",\"input\":\"*** Update File: README.md\\n-old\\n+new\"}}",
                callback,
                assistantContent
        );

        assertTrue(callback.events.stream().anyMatch(event -> "assistant".equals(event.type)
                && event.content.contains("\"type\":\"tool_use\"")
                && event.content.contains("\"id\":\"patch-1\"")
                && event.content.contains("\"name\":\"apply_patch\"")
                && event.content.contains("README.md")));
    }

    @Test
    public void nonToolItemsEmitProgressStatus() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-status");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(session, "{\"type\":\"turn.started\"}", callback, assistantContent);
        invokeParseEvent(session, "{\"type\":\"item.started\",\"item\":{\"id\":\"search_1\",\"type\":\"web_search\",\"query\":\"codex cli\"}}", callback, assistantContent);
        invokeParseEvent(session, "{\"type\":\"item.completed\",\"item\":{\"id\":\"file_1\",\"type\":\"file_change\",\"path\":\"README.md\",\"status\":\"completed\"}}", callback, assistantContent);
        invokeParseEvent(session, "{\"type\":\"item.completed\",\"item\":{\"id\":\"plan_1\",\"type\":\"plan_update\",\"status\":\"completed\"}}", callback, assistantContent);

        assertTrue(callback.events.stream().anyMatch(event -> "status".equals(event.type) && event.content.contains("Codex 正在处理")));
        assertTrue(callback.events.stream().anyMatch(event -> "status".equals(event.type) && event.content.contains("正在搜索")));
        assertTrue(callback.events.stream().anyMatch(event -> "status".equals(event.type) && event.content.contains("文件变更")));
        assertTrue(callback.events.stream().anyMatch(event -> "status".equals(event.type) && event.content.contains("计划")));
    }

    @Test
    public void turnCompletedUsageEmitsResultMessageForCodexHandler() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-usage");
        RecordingCallback callback = new RecordingCallback();

        invokeParseEvent(
                session,
                "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":3,\"output_tokens\":5}}",
                callback,
                new StringBuilder()
        );

        assertTrue(callback.events.stream().anyMatch(event -> "result".equals(event.type)
                && event.content.contains("\"input_tokens\":10")
                && event.content.contains("\"cache_read_input_tokens\":3")
                && event.content.contains("\"output_tokens\":5")));
    }

    @Test
    public void turnFailedIsReportedAsFormattedError() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-failed");
        RecordingCallback callback = new RecordingCallback();

        invokeParseEvent(
                session,
                "{\"type\":\"turn.failed\",\"error\":{\"message\":\"unexpected status 504 Gateway Timeout\"}}",
                callback,
                new StringBuilder()
        );

        assertTrue(callback.errors.stream().anyMatch(error -> error.contains("网关或上游服务超时 (504)")));
    }

    @Test
    public void imageUnsupportedTurnFailureUsesLocalizedVisionMessage() throws Exception {
        Method method = CodexCliSession.class.getDeclaredMethod(
                "formatCodexError",
                String.class,
                boolean.class
        );
        method.setAccessible(true);

        String error = (String) method.invoke(
                null,
                "This model does not support image input. Please use a vision-capable model.",
                true
        );

        assertTrue(error.startsWith("__I18N__:aiBridge.unsupportedImageVision"));
        assertTrue(error.contains("Details:"));
        assertTrue(error.contains("does not support image input"));
    }

    @Test
    public void imageRequestRateLimitKeepsFormattedRateLimitError() throws Exception {
        Method method = CodexCliSession.class.getDeclaredMethod(
                "formatCodexError",
                String.class,
                boolean.class
        );
        method.setAccessible(true);

        String error = (String) method.invoke(
                null,
                "API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。"
                        + "您的限额将在 2026-06-01 19:08:32 重置。]",
                true
        );

        assertFalse(error.startsWith("__I18N__:aiBridge.unsupportedImageVision"));
        assertTrue(error.contains("请求过于频繁 (429)"));
        assertTrue(error.contains("已达到 5 小时的使用上限"));
    }

    @Test
    public void imageRequestExitRateLimitWithImageContextKeepsFormattedRateLimitError() throws Exception {
        Method method = CodexCliSession.class.getDeclaredMethod(
                "buildExitError",
                int.class,
                StringBuilder.class,
                StringBuilder.class,
                boolean.class
        );
        method.setAccessible(true);

        StringBuilder diagnostic = new StringBuilder();
        diagnostic.append("sending local_image attachment failed: ")
                .append("API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。]")
                .append(" model requires vision request retry");

        String error = (String) method.invoke(null, 1, diagnostic, null, true);

        assertFalse(error.startsWith("__I18N__:aiBridge.unsupportedImageVision"));
        assertTrue(error.contains("Codex CLI 请求失败"));
        assertTrue(error.contains("请求过于频繁 (429)"));
        assertTrue(error.contains("local_image"));
    }

    @Test
    public void interruptedExitDoesNotReportExitCodeError() {
        CodexCliSession session = new CodexCliSession("tab-codex");

        session.interrupt();

        assertTrue(session.wasInterrupted());
        assertFalse(session.shouldReportExitError(1));
    }

    @Test
    public void sendPreparationClearsOnlyPreviousCodexInterrupts() {
        CodexCliSession session = new CodexCliSession("tab-codex");

        session.interrupt();
        session.prepareForSend();
        assertFalse(session.wasInterrupted());

        session.interrupt();
        assertTrue(session.wasInterrupted());
    }

    @Test
    public void readingAdditionalInputFromStdinIsIgnored() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-2");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        invokeParseEvent(session, "Reading additional input from stdin...", callback, assistantContent);

        assertEquals("", assistantContent.toString());
        assertFalse(callback.events.stream().anyMatch(event -> "content_delta".equals(event.type)));
    }

    @Test
    public void longPromptIsNotPlacedOnWindowsCommandLine() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-long-prompt");
        String longPrompt = "x".repeat(40_000);
        var request = new com.github.claudecodegui.cli.CliSendRequest(
                "tab-long-prompt",
                "codex",
                longPrompt,
                null,
                "D:\\project\\jetbrains-melon-cc-gui",
                List.of(),
                null,
                List.of(),
                null,
                "acceptEdits",
                "gpt-5.3-codex",
                null,
                null,
                java.util.Map.of()
        );

        Method buildCommand = CodexCliSession.class.getDeclaredMethod(
                "buildCommand",
                com.github.claudecodegui.cli.CliSendRequest.class,
                List.class
        );
        buildCommand.setAccessible(true);
        @SuppressWarnings("unchecked")
        List<String> command = (List<String>) buildCommand.invoke(session, request, List.of());

        assertFalse("Prompt must be sent via stdin instead of as a command-line argument", command.contains(longPrompt));

        Method buildPromptInput = CodexCliSession.class.getDeclaredMethod(
                "buildPromptInput",
                com.github.claudecodegui.cli.CliSendRequest.class
        );
        buildPromptInput.setAccessible(true);
        byte[] stdin = (byte[]) buildPromptInput.invoke(session, request);
        assertEquals(longPrompt, new String(stdin, StandardCharsets.UTF_8));
    }

    @Test
    public void gbkEncodedWindowsDiagnosticFallsBackToChineseText() throws Exception {
        Method decodeLine = CodexCliSession.class.getDeclaredMethod(
                "decodeLine",
                byte[].class,
                int.class
        );
        decodeLine.setAccessible(true);

        byte[] bytes = "命令行太长。".getBytes(Charset.forName("GBK"));
        String decoded = (String) decodeLine.invoke(null, bytes, bytes.length);

        assertEquals("命令行太长。", decoded);
    }

    @Test
    public void rawPowerShellDiagnosticsAreRoutedToCliErrorBuffer() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-ps");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();
        StringBuilder cliError = new StringBuilder();

        invokeParseEvent(
                session,
                ". : File C:\\Users\\32979\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1 cannot be loaded because running scripts is disabled on this system.",
                callback,
                assistantContent,
                cliError
        );

        assertEquals("", assistantContent.toString());
        assertFalse(callback.events.stream().anyMatch(event -> "content_delta".equals(event.type)));
        assertTrue(cliError.toString().contains("Microsoft.PowerShell_profile.ps1"));
    }

    @Test
    public void rawPowerShellCmdletErrorIsIgnoredFromStreamingContent() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-ps-cmdlet");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();
        StringBuilder cliError = new StringBuilder();

        invokeParseEvent(
                session,
                "thinking : The term 'thinking' is not recognized as the name of a cmdlet, function, script file, or operable program.",
                callback,
                assistantContent,
                cliError
        );

        assertEquals("", assistantContent.toString());
        assertFalse(callback.events.stream().anyMatch(event -> "content_delta".equals(event.type)));
        assertTrue(cliError.toString().contains("thinking"));
    }

    @Test
    public void multiLinePowerShellGetContentErrorIsRoutedToCliErrorBuffer() throws Exception {
        CodexCliSession session = new CodexCliSession("tab-ps-get-content");
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();
        StringBuilder cliError = new StringBuilder();

        invokeParseEvent(session, "Get-Content:", callback, assistantContent, cliError);
        invokeParseEvent(session, "Line |", callback, assistantContent, cliError);
        invokeParseEvent(session, "2 | Get-Content build.gradle.kts", callback, assistantContent, cliError);
        invokeParseEvent(session, "| ~~~~~~~~~~~~~~~~~~~~~~~~~~~~", callback, assistantContent, cliError);
        invokeParseEvent(
                session,
                "| Cannot find path 'D:\\\\project\\\\jetbrains-melon-cc-gui\\\\build.gradle.kts' because it does not exist.",
                callback,
                assistantContent,
                cliError
        );

        assertEquals("", assistantContent.toString());
        assertFalse(callback.events.stream().anyMatch(event -> "content_delta".equals(event.type)));
        assertTrue(cliError.toString().contains("Get-Content:"));
        assertTrue(cliError.toString().contains("Cannot find path"));
    }

    @Test
    public void exitErrorIncludesFormattedDiagnosticOutput() throws Exception {
        Method method = CodexCliSession.class.getDeclaredMethod(
                "buildExitError",
                int.class,
                StringBuilder.class,
                StringBuilder.class,
                boolean.class
        );
        method.setAccessible(true);

        StringBuilder diagnostic = new StringBuilder();
        diagnostic.append("unexpected status 503 Service Unavailable: Service temporarily unavailable, ")
                .append("url: https://gongyiapi.mossx.ai/responses, ")
                .append("request id: req-503");

        String error = (String) method.invoke(null, 1, diagnostic, null, false);

        assertTrue(error.contains("Codex CLI 请求失败"));
        assertTrue(error.contains("服务暂时不可用 (503)"));
        assertTrue(error.contains("https://gongyiapi.mossx.ai/responses"));
        assertTrue(error.contains("req-503"));
    }

    @Test(expected = NoSuchMethodException.class)
    public void legacyThreeArgumentParseEventOverloadIsRemoved() throws Exception {
        CodexCliSession.class.getDeclaredMethod(
                "parseEvent",
                String.class,
                CliSessionCallback.class,
                StringBuilder.class
        );
    }

    private static void invokeParseEvent(
            CodexCliSession session,
            String line,
            CliSessionCallback callback,
            StringBuilder assistantContent
    ) throws Exception {
        invokeParseEvent(session, line, callback, assistantContent, null);
    }

    private static void invokeParseEvent(
            CodexCliSession session,
            String line,
            CliSessionCallback callback,
            StringBuilder assistantContent,
            StringBuilder cliError
    ) throws Exception {
        Method method = CodexCliSession.class.getDeclaredMethod(
                "parseEvent",
                String.class,
                CliSessionCallback.class,
                StringBuilder.class,
                StringBuilder.class
        );
        method.setAccessible(true);
        method.invoke(session, line, callback, assistantContent, cliError);
    }

    private static final class RecordingCallback implements CliSessionCallback {
        private final List<Event> events = new ArrayList<>();
        private final List<String> errors = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
            events.add(new Event(type, content));
        }

        @Override
        public void onError(String error) {
            errors.add(error);
        }

        @Override
        public void onComplete(boolean success, String finalResult, String error) {
        }

        private List<String> contentsOfType(String type) {
            List<String> values = new ArrayList<>();
            for (Event event : events) {
                if (type.equals(event.type)) {
                    values.add(event.content);
                }
            }
            return values;
        }
    }

    private record Event(String type, String content) {
    }
}
