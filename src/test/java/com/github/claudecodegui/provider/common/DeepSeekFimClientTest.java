package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.*;

public class DeepSeekFimClientTest {

    private static String okBody(String text) {
        JsonObject choice = new JsonObject();
        choice.addProperty("text", text);
        JsonArray choices = new JsonArray();
        choices.add(choice);
        JsonObject root = new JsonObject();
        root.add("choices", choices);
        return root.toString();
    }

    @Test
    public void buildsEndpointFromBaseUrlAndPath() {
        assertEquals("https://api.deepseek.com/beta/completions",
                DeepSeekFimClient.buildEndpoint("https://api.deepseek.com", "/beta/completions"));
        assertEquals("https://api.deepseek.com/beta/completions",
                DeepSeekFimClient.buildEndpoint("https://api.deepseek.com/", "beta/completions"));
        assertEquals("https://api.siliconflow.cn/v1/completions",
                DeepSeekFimClient.buildEndpoint("https://api.siliconflow.cn/", "/v1/completions"));
        assertEquals("", DeepSeekFimClient.buildEndpoint("", "/v1/completions"));
        assertEquals("", DeepSeekFimClient.buildEndpoint("https://api.deepseek.com", "https://evil.example.com/x"));
    }

    @Test
    public void buildsRequestBodyWithPathIndependentFields() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        JsonObject body = DeepSeekFimClient.buildRequestBody("pre", "suf", s);
        assertEquals("deepseek-flash", body.get("model").getAsString());
        assertEquals("pre", body.get("prompt").getAsString());
        assertEquals("suf", body.get("suffix").getAsString());
        assertEquals(256, body.get("max_tokens").getAsInt());
        assertFalse(body.get("stream").getAsBoolean());
        assertEquals("\n\n", body.getAsJsonArray("stop").get(0).getAsString());
    }

    @Test
    public void parsesCompletionText() {
        assertEquals("int x = 1;", DeepSeekFimClient.parseCompletionText(okBody("int x = 1;")));
        assertNull(DeepSeekFimClient.parseCompletionText("{\"choices\":[]}"));
        assertNull(DeepSeekFimClient.parseCompletionText("{not json"));
        assertNull(DeepSeekFimClient.parseCompletionText(null));
    }

    @Test
    public void callReturnsStatusAndText() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body, timeoutMs) ->
                CompletableFuture.completedFuture(new DeepSeekFimClient.HttpResult(200, okBody("return 42;"), null)));
        DeepSeekFimClient.CallResult r = client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertTrue(r.ok);
        assertEquals(200, r.httpStatus);
        assertEquals("return 42;", r.text);
        assertEquals("https://api.deepseek.com/v1/completions", r.endpoint);
    }

    @Test
    public void callSurfacesHttpErrorForTestConnection() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body, timeoutMs) ->
                CompletableFuture.completedFuture(new DeepSeekFimClient.HttpResult(404, "{\"error\":\"not found\"}", null)));
        DeepSeekFimClient.CallResult r = client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertFalse(r.ok);
        assertEquals(404, r.httpStatus);
        assertTrue(r.error.contains("404"));
        assertTrue(r.error.contains("not found"));
    }

    @Test
    public void callSurfacesTransportFailure() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body, timeoutMs) ->
                CompletableFuture.failedFuture(new IllegalStateException("connection refused")));
        DeepSeekFimClient.CallResult r = client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertFalse(r.ok);
        assertTrue(r.error.contains("connection refused"));
    }

    @Test
    public void callSurfacesATimeoutAsAReadableError() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body, timeoutMs) ->
                CompletableFuture.failedFuture(
                        new java.net.http.HttpTimeoutException("request timed out")));
        DeepSeekFimClient.CallResult r = client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertFalse(r.ok);
        assertTrue(r.error.contains("timed out"));
    }

    // The editor waits 2.5s, so the request itself must be bounded well under
    // that; the probe is allowed a longer budget. Both go through the transport.
    @Test
    public void callPassesTheRequestBudgetToTheTransport() {
        int[] seen = {-1};
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body, timeoutMs) -> {
            seen[0] = timeoutMs;
            return CompletableFuture.completedFuture(
                    new DeepSeekFimClient.HttpResult(200, okBody("x"), null));
        });

        client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertEquals(DeepSeekFimClient.EDITOR_TIMEOUT_MS, seen[0]);
        assertTrue(DeepSeekFimClient.EDITOR_TIMEOUT_MS < 2500);

        client.call("a", "b", cfg("/v1/completions"), "k", 15000).join();
        assertEquals(15000, seen[0]);
    }

    @Test
    public void completeReturnsNullOnFailure() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body, timeoutMs) ->
                CompletableFuture.completedFuture(new DeepSeekFimClient.HttpResult(401, "unauthorized", null)));
        assertNull(client.complete("a", "b", cfg("/v1/completions"), "k").join());
    }

    private static CodeCompletionSettings cfg(String path) {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://api.deepseek.com");
        s.setPath(path);
        s.normalize();
        return s;
    }
}
