package com.github.claudecodegui.cli.claude;

import org.junit.Test;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertTrue;

public class ClaudeCliSessionTest {

    @Test
    public void configureThinkingEnvDoesNotRemoveExplicitThinkingBudget() throws Exception {
        ClaudeCliSession session = new ClaudeCliSession("tab-claude");
        Map<String, String> env = new HashMap<>();
        env.put("MAX_THINKING_TOKENS", "9999");

        Method method = ClaudeCliSession.class.getDeclaredMethod("configureThinkingEnv", Map.class);
        method.setAccessible(true);
        method.invoke(session, env);

        assertTrue(env.containsKey("MAX_THINKING_TOKENS"));
        assertTrue("9999".equals(env.get("MAX_THINKING_TOKENS")) || "12000".equals(env.get("MAX_THINKING_TOKENS")));
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
}
