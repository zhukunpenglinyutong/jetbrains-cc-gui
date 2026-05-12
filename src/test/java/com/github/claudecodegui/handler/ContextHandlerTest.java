package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.github.claudecodegui.handler.core.HandlerContext;
import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Tests for {@link ContextHandler} request parsing logic.
 */
public class ContextHandlerTest {

    private static final Gson GSON = new Gson();

    @Test
    public void parseAllFieldsFromValidRequest() {
        JsonObject body = new JsonObject();
        body.addProperty("sessionId", "sess-123");
        body.addProperty("cwd", "/home/user/project");
        body.addProperty("model", "claude-opus-4-7[1m]");
        body.addProperty("requestId", "req-abc");

        String[] result = ContextHandler.parseContextUsageRequest(GSON, body.toString());

        assertEquals("sess-123", result[0]);
        assertEquals("/home/user/project", result[1]);
        assertEquals("claude-opus-4-7[1m]", result[2]);
        assertEquals("req-abc", result[3]);
    }

    @Test
    public void parsePartialRequestWithOnlyModelAndRequestId() {
        JsonObject body = new JsonObject();
        body.addProperty("model", "claude-sonnet-4-6");
        body.addProperty("requestId", "req-xyz");

        String[] result = ContextHandler.parseContextUsageRequest(GSON, body.toString());

        assertNull(result[0]); // sessionId
        assertNull(result[1]); // cwd
        assertEquals("claude-sonnet-4-6", result[2]);
        assertEquals("req-xyz", result[3]);
    }

    @Test
    public void parseNullContentReturnsAllNulls() {
        String[] result = ContextHandler.parseContextUsageRequest(GSON, null);

        assertNull(result[0]);
        assertNull(result[1]);
        assertNull(result[2]);
        assertNull(result[3]);
    }

    @Test
    public void parseEmptyContentReturnsAllNulls() {
        String[] result = ContextHandler.parseContextUsageRequest(GSON, "");

        assertNull(result[0]);
        assertNull(result[1]);
        assertNull(result[2]);
        assertNull(result[3]);
    }

    @Test
    public void parseNullJsonFieldsReturnNull() {
        JsonObject body = new JsonObject();
        body.add("sessionId", null);
        body.addProperty("model", "claude-opus-4-7");
        body.add("requestId", null);

        String[] result = ContextHandler.parseContextUsageRequest(GSON, body.toString());

        assertNull(result[0]); // sessionId is null
        assertNull(result[1]); // cwd not present
        assertEquals("claude-opus-4-7", result[2]);
        assertNull(result[3]); // requestId is null
    }

    @Test
    public void parseInvalidJsonReturnsAllNulls() {
        String[] result = ContextHandler.parseContextUsageRequest(GSON, "not valid json {{{");

        assertNull(result[0]);
        assertNull(result[1]);
        assertNull(result[2]);
        assertNull(result[3]);
    }

    @Test
    public void parseModelWith1MContextSuffix() {
        JsonObject body = new JsonObject();
        body.addProperty("model", "claude-opus-4-7[1m]");

        String[] result = ContextHandler.parseContextUsageRequest(GSON, body.toString());

        assertEquals("claude-opus-4-7[1m]", result[2]);
    }

    @Test
    public void handlerDeclaresGetContextUsageSupport() {
        HandlerContext context = new HandlerContext(
                null,
                null,
                null,
                null,
                new HandlerContext.JsCallback() {
                    @Override
                    public void callJavaScript(String functionName, String... args) {
                    }

                    @Override
                    public String escapeJs(String str) {
                        return str;
                    }
                }
        );

        ContextHandler handler = new ContextHandler(context);
        assertArrayEquals(new String[]{"get_context_usage"}, handler.getSupportedTypes());
    }
}
