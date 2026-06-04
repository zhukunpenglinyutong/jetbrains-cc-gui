package com.github.claudecodegui.cli.claude;

import com.github.claudecodegui.cli.CliSendRequest;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeCliSessionTest {

    @Test
    public void buildCommandDoesNotSendEffortForUnknownCustomModels() throws Exception {
        ClaudeCliModelResolver.ResolvedModel profile = ClaudeCliModelResolver.resolveProfile(
                "mimo-v2.5-pro", new JsonObject());

        List<String> command = buildCommand(request("mimo-v2.5-pro", "high"), profile);

        assertTrue(command.contains("--model"));
        assertTrue(command.contains("mimo-v2.5-pro"));
        assertFalse(command.contains("--effort"));
        assertFalse(command.contains("high"));
    }

    @Test
    public void buildCommandSendsEffortForCanonicalClaudeModels() throws Exception {
        ClaudeCliModelResolver.ResolvedModel profile = ClaudeCliModelResolver.resolveProfile(
                "claude-sonnet-4-6", new JsonObject());

        List<String> command = buildCommand(request("claude-sonnet-4-6", "high"), profile);

        assertTrue(command.contains("--model"));
        assertTrue(command.contains("claude-sonnet-4-6"));
        assertTrue(command.contains("--effort"));
        assertTrue(command.contains("high"));
    }

    @Test
    public void buildExitErrorWrapsServiceUnavailableDiagnostic() throws Exception {
        Method method = ClaudeCliSession.class.getDeclaredMethod(
                "buildExitError",
                int.class,
                StringBuilder.class
        );
        method.setAccessible(true);

        StringBuilder diagnostic = new StringBuilder();
        diagnostic.append("unexpected status 503 Service Unavailable: Service temporarily unavailable, ")
                .append("url: https://gongyiapi.mossx.ai/responses, ")
                .append("request id: req-claude-503");

        String error = (String) method.invoke(null, 1, diagnostic);

        assertTrue(error.contains("Claude CLI 请求失败"));
        assertTrue(error.contains("服务暂时不可用 (503)"));
        assertTrue(error.contains("https://gongyiapi.mossx.ai/responses"));
        assertTrue(error.contains("req-claude-503"));
    }

    @Test
    public void buildCommandOmitsDisabledOptionalCliCapabilities() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL_CAPABILITIES", "no-effort,no-mcp,no-add-dir,no-partial-messages");
        ClaudeCliModelResolver.ResolvedModel profile = ClaudeCliModelResolver.resolveProfile(
                "claude-sonnet-4-6", env);

        List<String> command = buildCommand(
                request("claude-sonnet-4-6", "high"),
                profile,
                true,
                "C:/tmp/mcp.json",
                List.of("C:/tmp/images")
        );

        assertFalse(command.contains("--effort"));
        assertFalse(command.contains("--mcp-config"));
        assertFalse(command.contains("--add-dir"));
        assertFalse(command.contains("--include-partial-messages"));
    }

    @Test
    public void interruptBeforeActiveHandleStillMarksSessionInterrupted() {
        ClaudeCliSession session = new ClaudeCliSession("tab-claude");

        session.interrupt();

        assertTrue(session.wasInterrupted());
    }

    @Test
    public void interruptedExitEmitsInterruptedCompletionOnlyOnce() {
        ClaudeCliSession session = new ClaudeCliSession("tab-claude");
        AtomicBoolean interruptHandled = new AtomicBoolean(false);

        session.interrupt();

        assertTrue(session.shouldEmitInterruptedCompletion(interruptHandled));
        interruptHandled.set(true);
        assertFalse(session.shouldEmitInterruptedCompletion(interruptHandled));
    }

    @Test
    public void interruptedExitNeverReportsExitCodeErrorEvenAfterInterruptedCompletionWasHandled() {
        ClaudeCliSession session = new ClaudeCliSession("tab-claude");
        AtomicBoolean interruptHandled = new AtomicBoolean(true);

        session.interrupt();

        assertFalse(session.shouldEmitInterruptedCompletion(interruptHandled));
        assertFalse(session.shouldReportExitError(1, false));
    }

    @Test
    public void sendPreparationClearsOnlyPreviousInterrupts() {
        ClaudeCliSession session = new ClaudeCliSession("tab-claude");

        session.interrupt();
        session.prepareForSend();
        assertFalse(session.wasInterrupted());

        session.interrupt();
        assertTrue(session.wasInterrupted());
    }

    private static List<String> buildCommand(
            CliSendRequest request,
            ClaudeCliModelResolver.ResolvedModel profile
    ) {
        return buildCommand(request, profile, false, null, List.of());
    }

    private static List<String> buildCommand(
            CliSendRequest request,
            ClaudeCliModelResolver.ResolvedModel profile,
            boolean hasMcpServers,
            String mcpConfigFilePath,
            List<String> addDirs
    ) {
        return ClaudeCliSession.buildCommand(
                "claude",
                request,
                addDirs,
                profile,
                hasMcpServers,
                mcpConfigFilePath,
                null
        );
    }

    private static CliSendRequest request(String model, String reasoningEffort) {
        return new CliSendRequest(
                "tab-claude",
                "claude",
                "hello",
                null,
                null,
                List.of(),
                null,
                List.of(),
                null,
                "default",
                model,
                reasoningEffort,
                null,
                Map.of()
        );
    }
}
