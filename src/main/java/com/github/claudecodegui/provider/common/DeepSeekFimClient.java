package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * Calls an OpenAI-compatible completions endpoint (FIM):
 * {@code POST {baseUrl}{path}} with {@code prompt} + {@code suffix}.
 *
 * <p>Works for any provider exposing that shape — DeepSeek official
 * ({@code /beta/completions}), SiliconFlow and other gateways
 * ({@code /v1/completions}). The response text ({@code choices[0].text}) is the
 * middle fragment to insert between prefix and suffix.
 *
 * <p>Never throws to callers: failures are reported through
 * {@link CallResult} (used by the "test connection" UI) or {@code null}
 * (used by the editor, which stays silent).
 */
public final class DeepSeekFimClient {

    private static final Logger LOG = Logger.getInstance(DeepSeekFimClient.class);
    /**
     * Request budget for the editor path. It has to stay under the completion
     * pass's own wait ({@code FimCompletionContributor.REQUEST_TIMEOUT_MS}) so
     * the exchange is aborted here rather than left running behind it.
     */
    public static final int EDITOR_TIMEOUT_MS = 2000;
    /** Connect budget for the shared client. */
    private static final int CONNECT_TIMEOUT_MS = 2000;
    /**
     * One client for every call: building one per request leaked a connection
     * pool per completion, and a shared client keeps an HTTP/2 connection warm.
     */
    private static final HttpClient SHARED_CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(CONNECT_TIMEOUT_MS))
            .build();

    /** Transport seam for tests. */
    @FunctionalInterface
    public interface Transport {
        /**
         * One POST, non-blocking. A failed call comes back as
         * {@link HttpResult#error} rather than a failed future, and
         * {@code timeoutMs} bounds the request itself.
         */
        CompletableFuture<HttpResult> post(String url, String apiKey, String body, int timeoutMs);
    }

    /** Raw HTTP outcome; {@code error} is non-null when the call itself failed. */
    public static final class HttpResult {
        public final int status;
        public final String body;
        public final String error;

        public HttpResult(int status, String body, String error) {
            this.status = status;
            this.body = body;
            this.error = error;
        }
    }

    /** Outcome of one FIM call, with everything the UI needs to explain a failure. */
    public static final class CallResult {
        public final boolean ok;
        public final int httpStatus;
        public final String text;
        public final String error;
        public final String endpoint;

        CallResult(boolean ok, int httpStatus, String text, String error, String endpoint) {
            this.ok = ok;
            this.httpStatus = httpStatus;
            this.text = text;
            this.error = error;
            this.endpoint = endpoint;
        }
    }

    private final Transport transport;

    public DeepSeekFimClient() {
        this(DeepSeekFimClient::httpPostAsync);
    }

    DeepSeekFimClient(Transport transport) {
        this.transport = transport;
    }

    /** Full outcome for the editor path, bounded by {@link #EDITOR_TIMEOUT_MS}. */
    public CompletableFuture<CallResult> call(String prefix, String suffix,
                                              CodeCompletionSettings cfg, String apiKey) {
        return call(prefix, suffix, cfg, apiKey, EDITOR_TIMEOUT_MS);
    }

    /**
     * Full outcome under an explicit request budget.
     *
     * <p>Non-blocking end to end: the HTTP exchange runs on the transport's own
     * executor instead of a shared pool thread, and the budget bounds the
     * request itself, so a timed-out call stops rather than continuing behind
     * the caller. The "test connection" probe passes a longer budget than the
     * editor does.
     */
    public CompletableFuture<CallResult> call(String prefix, String suffix,
                                              CodeCompletionSettings cfg, String apiKey, int timeoutMs) {
        final String endpoint;
        final String body;
        try {
            CodeCompletionSettings settings = cfg == null ? new CodeCompletionSettings() : cfg;
            settings.normalize();
            endpoint = buildEndpoint(settings.getBaseUrl(), settings.getPath());
            if (endpoint.isEmpty()) {
                return CompletableFuture.completedFuture(
                        new CallResult(false, 0, null, "Base URL or path is invalid", ""));
            }
            body = buildRequestBody(prefix, suffix, settings).toString();
        } catch (Exception e) {
            return CompletableFuture.completedFuture(new CallResult(false, 0, null, messageOf(e), ""));
        }
        return transport.post(endpoint, apiKey, body, timeoutMs)
                .handle((res, err) -> interpret(res, err, endpoint));
    }

    /** Completion text or {@code null}; the editor stays silent on failure. */
    public CompletableFuture<String> complete(String prefix, String suffix,
                                              CodeCompletionSettings cfg, String apiKey) {
        return call(prefix, suffix, cfg, apiKey).thenApply(r -> r.ok ? r.text : null);
    }

    /** Turn one transport outcome into the caller-facing result. */
    private static CallResult interpret(HttpResult res, Throwable err, String endpoint) {
        if (err != null) {
            return new CallResult(false, 0, null, messageOf(err), endpoint);
        }
        if (res == null) {
            return new CallResult(false, 0, null, "No response", endpoint);
        }
        if (res.error != null) {
            return new CallResult(false, res.status, null, res.error, endpoint);
        }
        if (res.status != 200) {
            return new CallResult(false, res.status, null,
                    "HTTP " + res.status + ": " + abbreviate(res.body), endpoint);
        }
        String text = parseCompletionText(res.body);
        if (text == null || text.isEmpty()) {
            return new CallResult(false, res.status, null,
                    "Response contained no completion text", endpoint);
        }
        return new CallResult(true, res.status, text, null, endpoint);
    }

    /** Human message for a failure, unwrapping the completion/timeout wrappers. */
    private static String messageOf(Throwable error) {
        Throwable root = error == null ? null : (error.getCause() == null ? error : error.getCause());
        if (root instanceof HttpTimeoutException) {
            return "request timed out";
        }
        String message = root == null ? null : root.getMessage();
        if (message == null || message.isEmpty()) {
            return root == null ? "Unknown error" : root.getClass().getSimpleName();
        }
        return message;
    }

    static String buildEndpoint(String baseUrl, String path) {
        String base = baseUrl == null ? "" : baseUrl.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if (base.isEmpty()) {
            return "";
        }
        String p = path == null ? "" : path.trim();
        if (p.startsWith("http://") || p.startsWith("https://")) {
            return "";
        }
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        return base + p;
    }

    static JsonObject buildRequestBody(String prefix, String suffix, CodeCompletionSettings cfg) {
        JsonObject o = new JsonObject();
        o.addProperty("model", cfg.getModel());
        o.addProperty("prompt", prefix == null ? "" : prefix);
        o.addProperty("suffix", suffix == null ? "" : suffix);
        o.addProperty("max_tokens", cfg.getMaxTokens());
        o.addProperty("temperature", cfg.getTemperature());
        o.addProperty("top_p", cfg.getTopP());
        JsonArray stop = new JsonArray();
        for (String s : cfg.getStop()) {
            stop.add(s);
        }
        o.add("stop", stop);
        o.addProperty("ignore_eos", cfg.isIgnoreEos());
        o.addProperty("stream", false);
        return o;
    }

    static String parseCompletionText(String responseBody) {
        if (responseBody == null || responseBody.trim().isEmpty()) {
            return null;
        }
        try {
            JsonObject root = JsonParser.parseString(responseBody).getAsJsonObject();
            if (!root.has("choices") || !root.get("choices").isJsonArray()
                    || root.getAsJsonArray("choices").isEmpty()) {
                return null;
            }
            JsonObject first = root.getAsJsonArray("choices").get(0).getAsJsonObject();
            if (!first.has("text") || first.get("text").isJsonNull()) {
                return null;
            }
            String text = first.get("text").getAsString();
            return text == null || text.isEmpty() ? null : text;
        } catch (Exception e) {
            LOG.debug("[FimClient] failed to parse response: " + e.getMessage());
            return null;
        }
    }

    private static String abbreviate(String s) {
        if (s == null) {
            return "";
        }
        String oneLine = s.replace('\n', ' ').replace('\r', ' ');
        return oneLine.length() > 500 ? oneLine.substring(0, 500) : oneLine;
    }

    private static CompletableFuture<HttpResult> httpPostAsync(String url, String apiKey, String body, int timeoutMs) {
        HttpRequest request;
        try {
            request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    // The request timeout aborts the exchange itself, so a slow
                    // gateway cannot keep the connection alive past the budget.
                    .timeout(Duration.ofMillis(Math.max(1, timeoutMs)))
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Authorization", "Bearer " + (apiKey == null ? "" : apiKey))
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
        } catch (Exception e) {
            return CompletableFuture.completedFuture(new HttpResult(0, null, messageOf(e)));
        }
        return SHARED_CLIENT.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .handle((resp, err) -> err != null
                        ? new HttpResult(0, null, messageOf(err))
                        : new HttpResult(resp.statusCode(), resp.body(), null));
    }
}
