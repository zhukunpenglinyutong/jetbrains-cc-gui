package com.github.claudecodegui.service;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.stream.Stream;

/**
 * Lightweight HTTP client for commit message generation.
 * Avoids booting the full SDK bridge for the small, one-shot commit flow.
 */
final class CommitHttpAiClient {
    static final int DEFAULT_TIMEOUT_SECONDS = 60;
    private static final int MAX_ATTEMPTS = 3;
    private static final long RETRY_BASE_DELAY_MS = 750L;

    private static final Gson GSON = new Gson();
    private static final int DEFAULT_MAX_TOKENS = 1536;
    private static final String DIFF_SECTION_MARKER = "## Selected git diff";
    private static final Set<Integer> RETRYABLE_HTTP_STATUSES = new HashSet<>(Set.of(
            429, 500, 502, 503, 504, 529
    ));

    String generateClaude(String prompt, Config config, Consumer<String> chunkConsumer)
            throws IOException, InterruptedException {
        JsonObject body = new JsonObject();
        body.addProperty("model", valueOr(config.model, "claude-sonnet-4-6"));
        body.addProperty("max_tokens", DEFAULT_MAX_TOKENS);
        body.addProperty("temperature", 0.0);
        body.addProperty("stream", true);
        body.add("messages", buildClaudeMessages(prompt, body));

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("x-api-key", config.apiKey);
        headers.put("anthropic-version", "2023-06-01");

        StringBuilder out = new StringBuilder();
        postJsonLines(anthropicEndpoint(config.baseUrl), body, headers, DEFAULT_TIMEOUT_SECONDS, line -> {
            String text = extractClaudeStreamingText(line);
            if (!text.isEmpty()) {
                out.append(text);
                if (chunkConsumer != null) {
                    chunkConsumer.accept(text);
                }
            }
        });
        return out.toString();
    }

    String generateOpenAiCompatible(String prompt, Config config, Consumer<String> chunkConsumer)
            throws IOException, InterruptedException {
        String wireApi = resolveOpenAiWireApi(config);
        try {
            if ("responses".equalsIgnoreCase(wireApi)) {
                return generateStreamingResponses(prompt, config, chunkConsumer);
            }
            return generateStreamingChatCompletions(prompt, config, chunkConsumer);
        } catch (IOException e) {
            if (!shouldFallbackToNonStreaming(e)) {
                throw e;
            }
            if ("responses".equalsIgnoreCase(wireApi)) {
                return generateResponses(prompt, config);
            }
            return generateChatCompletions(prompt, config);
        }
    }

    private String resolveOpenAiWireApi(Config config) {
        if (config == null) {
            return "";
        }
        String explicitWireApi = trim(config.wireApi);
        if (!explicitWireApi.isEmpty()) {
            return explicitWireApi;
        }
        String baseUrl = trim(config.baseUrl).toLowerCase();
        if (baseUrl.endsWith("/chat/completions")) {
            return "";
        }
        if (baseUrl.endsWith("/responses")) {
            return "responses";
        }
        return shouldPreferResponsesByModel(config.model) ? "responses" : "";
    }

    private boolean shouldPreferResponsesByModel(String model) {
        String normalized = trim(model).toLowerCase();
        return normalized.startsWith("gpt-5");
    }

    private String generateStreamingChatCompletions(String prompt, Config config, Consumer<String> chunkConsumer)
            throws IOException, InterruptedException {
        JsonObject body = new JsonObject();
        body.addProperty("model", valueOr(config.model, "gpt-5.5"));
        body.addProperty("temperature", 0.3);
        body.addProperty("max_tokens", DEFAULT_MAX_TOKENS);
        body.addProperty("stream", true);
        body.add("messages", buildChatMessages(prompt));

        StringBuilder out = new StringBuilder();
        postJsonLines(openAiEndpoint(config.baseUrl, "/chat/completions"), body, openAiHeaders(config.apiKey),
                DEFAULT_TIMEOUT_SECONDS, line -> {
                    String text = extractStreamingChatText(line);
                    if (!text.isEmpty()) {
                        out.append(text);
                        if (chunkConsumer != null) {
                            chunkConsumer.accept(text);
                        }
                    }
                });
        return out.toString();
    }

    private String generateChatCompletions(String prompt, Config config)
            throws IOException, InterruptedException {
        JsonObject body = new JsonObject();
        body.addProperty("model", valueOr(config.model, "gpt-5.5"));
        body.addProperty("temperature", 0.3);
        body.addProperty("max_tokens", DEFAULT_MAX_TOKENS);
        body.add("messages", buildChatMessages(prompt));

        JsonObject response = postJson(openAiEndpoint(config.baseUrl, "/chat/completions"), body,
                openAiHeaders(config.apiKey), DEFAULT_TIMEOUT_SECONDS);
        return extractChatCompletionText(response);
    }

    private String generateStreamingResponses(String prompt, Config config, Consumer<String> chunkConsumer)
            throws IOException, InterruptedException {
        JsonObject body = new JsonObject();
        body.addProperty("model", valueOr(config.model, "gpt-5.5"));
        body.addProperty("max_output_tokens", DEFAULT_MAX_TOKENS);
        body.addProperty("stream", true);
        String[] parts = splitPrompt(prompt);
        if (!parts[0].isEmpty()) {
            body.addProperty("instructions", parts[0]);
        }
        body.addProperty("input", parts[1]);

        StringBuilder out = new StringBuilder();
        postJsonLines(openAiEndpoint(config.baseUrl, "/responses"), body, openAiHeaders(config.apiKey),
                DEFAULT_TIMEOUT_SECONDS, line -> {
                    String text = extractStreamingResponsesText(line);
                    if (!text.isEmpty()) {
                        out.append(text);
                        if (chunkConsumer != null) {
                            chunkConsumer.accept(text);
                        }
                    }
                });
        return out.toString();
    }

    private String generateResponses(String prompt, Config config)
            throws IOException, InterruptedException {
        JsonObject body = new JsonObject();
        body.addProperty("model", valueOr(config.model, "gpt-5.5"));
        body.addProperty("max_output_tokens", DEFAULT_MAX_TOKENS);
        String[] parts = splitPrompt(prompt);
        if (!parts[0].isEmpty()) {
            body.addProperty("instructions", parts[0]);
        }
        body.addProperty("input", parts[1]);

        JsonObject response = postJson(openAiEndpoint(config.baseUrl, "/responses"), body,
                openAiHeaders(config.apiKey), DEFAULT_TIMEOUT_SECONDS);
        return extractResponsesText(response);
    }

    private JsonObject postJson(String url, JsonObject body, Map<String, String> headers, int timeoutSeconds)
            throws IOException, InterruptedException {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(Math.min(timeoutSeconds, 30)))
                .build();
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(body)))
                .header("Content-Type", "application/json");
        for (Map.Entry<String, String> header : headers.entrySet()) {
            if (notBlank(header.getValue())) {
                builder.header(header.getKey(), header.getValue().trim());
            }
        }
        HttpResponse<String> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        int statusCode = response.statusCode();
        if (statusCode < 200 || statusCode >= 300) {
            throw new HttpStatusIOException(statusCode, buildHttpErrorMessage(statusCode, response.body(), 1));
        }
        try {
            JsonElement element = JsonParser.parseString(response.body());
            if (element != null && element.isJsonObject()) {
                return element.getAsJsonObject();
            }
        } catch (Exception e) {
            throw new IOException("AI response was not valid JSON: " + shorten(response.body()), e);
        }
        throw new IOException("AI response was not a JSON object: " + shorten(response.body()));
    }

    private void postJsonLines(String url, JsonObject body, Map<String, String> headers, int timeoutSeconds,
                               Consumer<String> lineConsumer)
            throws IOException, InterruptedException {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(Math.min(timeoutSeconds, 30)))
                .build();
        IOException lastIOException = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(timeoutSeconds))
                    .POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(body)))
                    .header("Content-Type", "application/json")
                    .header("Accept", "text/event-stream");
            for (Map.Entry<String, String> header : headers.entrySet()) {
                if (notBlank(header.getValue())) {
                    builder.header(header.getKey(), header.getValue().trim());
                }
            }

            try {
                HttpResponse<Stream<String>> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofLines());
                try (Stream<String> lines = response.body()) {
                    int statusCode = response.statusCode();
                    if (statusCode < 200 || statusCode >= 300) {
                        String errorBody = readErrorBody(lines);
                        if (isRetryableHttpStatus(statusCode) && attempt < MAX_ATTEMPTS) {
                            sleepBeforeRetry(attempt);
                            continue;
                        }
                        throw new HttpStatusIOException(statusCode,
                                buildHttpErrorMessage(statusCode, errorBody, attempt));
                    }
                    StringBuilder eventData = new StringBuilder();
                    lines.forEach(line -> acceptSseLine(line, eventData, lineConsumer));
                    flushSseEvent(eventData, lineConsumer);
                    return;
                }
            } catch (IOException e) {
                lastIOException = e;
                if (attempt < MAX_ATTEMPTS && isRetryableIOException(e)) {
                    sleepBeforeRetry(attempt);
                    continue;
                }
                throw e;
            }
        }
        if (lastIOException != null) {
            throw lastIOException;
        }
    }

    private boolean isRetryableHttpStatus(int statusCode) {
        return RETRYABLE_HTTP_STATUSES.contains(statusCode);
    }

    private boolean shouldFallbackToNonStreaming(IOException e) {
        if (e instanceof HttpStatusIOException statusException) {
            return isRetryableHttpStatus(statusException.statusCode);
        }
        return isRetryableIOException(e);
    }

    private boolean isRetryableIOException(IOException e) {
        if (e == null) {
            return false;
        }
        String message = e.getMessage();
        if (message == null) {
            return false;
        }
        String normalized = message.toLowerCase();
        return normalized.contains("timed out")
                || normalized.contains("timeout")
                || normalized.contains("connection reset")
                || normalized.contains("connection refused")
                || normalized.contains("503")
                || normalized.contains("502")
                || normalized.contains("504");
    }

    private void sleepBeforeRetry(int attempt) throws InterruptedException {
        long delay = RETRY_BASE_DELAY_MS * attempt;
        Thread.sleep(delay);
    }

    private String readErrorBody(Stream<String> lines) {
        StringBuilder error = new StringBuilder();
        lines.limit(20).forEach(line -> {
            if (error.length() < 800) {
                error.append(line).append('\n');
            }
        });
        return error.toString();
    }

    private String buildHttpErrorMessage(int statusCode, String errorBody, int attempt) {
        String suffix = attempt > 1 ? " after " + attempt + " attempts" : "";
        return "HTTP " + statusCode + suffix + ": " + shorten(errorBody);
    }

    private void acceptSseLine(String line, StringBuilder eventData, Consumer<String> lineConsumer) {
        if (line == null) {
            return;
        }
        String trimmed = line.trim();
        if (trimmed.isEmpty()) {
            flushSseEvent(eventData, lineConsumer);
            return;
        }
        if (trimmed.startsWith(":") || !trimmed.startsWith("data:")) {
            return;
        }
        if (eventData.length() > 0) {
            eventData.append('\n');
        }
        eventData.append(trimmed.substring("data:".length()).trim());
    }

    private void flushSseEvent(StringBuilder eventData, Consumer<String> lineConsumer) {
        if (eventData.length() == 0) {
            return;
        }
        lineConsumer.accept(eventData.toString());
        eventData.setLength(0);
    }

    private JsonArray buildChatMessages(String prompt) {
        JsonArray messages = new JsonArray();
        String[] parts = splitPrompt(prompt);
        if (!parts[0].isEmpty()) {
            JsonObject system = new JsonObject();
            system.addProperty("role", "system");
            system.addProperty("content", parts[0]);
            messages.add(system);
        }
        JsonObject user = new JsonObject();
        user.addProperty("role", "user");
        user.addProperty("content", parts[0].isEmpty() ? prompt : parts[1]);
        messages.add(user);
        return messages;
    }

    private JsonArray buildClaudeMessages(String prompt, JsonObject body) {
        JsonArray messages = new JsonArray();
        String[] parts = splitPrompt(prompt);
        if (!parts[0].isEmpty()) {
            body.addProperty("system", parts[0]);
        }
        JsonObject user = new JsonObject();
        user.addProperty("role", "user");
        user.addProperty("content", parts[0].isEmpty() ? prompt : parts[1]);
        messages.add(user);
        return messages;
    }

    private String[] splitPrompt(String prompt) {
        if (prompt == null) {
            return new String[]{"", ""};
        }
        int idx = prompt.indexOf(DIFF_SECTION_MARKER);
        if (idx > 0) {
            return new String[]{prompt.substring(0, idx).trim(), prompt.substring(idx).trim()};
        }
        return new String[]{"", prompt};
    }

    private Map<String, String> openAiHeaders(String apiKey) {
        Map<String, String> headers = new LinkedHashMap<>();
        if (notBlank(apiKey)) {
            headers.put("Authorization", "Bearer " + apiKey.trim());
        }
        return headers;
    }

    private String anthropicEndpoint(String baseUrl) {
        String value = trimTrailingSlash(valueOr(baseUrl, "https://api.anthropic.com"));
        if (value.endsWith("/v1/messages")) {
            return value;
        }
        if (value.endsWith("/v1")) {
            return value + "/messages";
        }
        return value + "/v1/messages";
    }

    private String openAiEndpoint(String baseUrl, String endpointPath) {
        String value = trimTrailingSlash(valueOr(baseUrl, "https://api.openai.com"));
        if (value.endsWith("/chat/completions") || value.endsWith("/responses")) {
            return value;
        }
        if (value.endsWith("/v1")) {
            return value + endpointPath;
        }
        return value + "/v1" + endpointPath;
    }

    private String extractClaudeStreamingText(String eventData) {
        String data = sseData(eventData);
        if (data.isEmpty()) {
            return "";
        }
        try {
            JsonElement element = JsonParser.parseString(data);
            if (!element.isJsonObject()) {
                return "";
            }
            JsonObject event = element.getAsJsonObject();
            if (!event.has("delta") || !event.get("delta").isJsonObject()) {
                return "";
            }
            JsonObject delta = event.getAsJsonObject("delta");
            if (delta.has("text") && !delta.get("text").isJsonNull()) {
                return delta.get("text").getAsString();
            }
        } catch (Exception ignored) {
            return "";
        }
        return "";
    }

    private String extractStreamingChatText(String eventData) {
        String data = sseData(eventData);
        if (data.isEmpty() || "[DONE]".equals(data)) {
            return "";
        }
        try {
            JsonElement element = JsonParser.parseString(data);
            if (!element.isJsonObject()) {
                return "";
            }
            JsonObject event = element.getAsJsonObject();
            if (!event.has("choices") || !event.get("choices").isJsonArray()
                    || event.getAsJsonArray("choices").size() == 0) {
                return "";
            }
            JsonObject choice = event.getAsJsonArray("choices").get(0).getAsJsonObject();
            if (!choice.has("delta") || !choice.get("delta").isJsonObject()) {
                return "";
            }
            JsonObject delta = choice.getAsJsonObject("delta");
            if (delta.has("content") && !delta.get("content").isJsonNull()) {
                return delta.get("content").getAsString();
            }
        } catch (Exception ignored) {
            return "";
        }
        return "";
    }

    private String extractStreamingResponsesText(String eventData) {
        String data = sseData(eventData);
        if (data.isEmpty() || "[DONE]".equals(data)) {
            return "";
        }
        try {
            JsonElement element = JsonParser.parseString(data);
            if (!element.isJsonObject()) {
                return "";
            }
            JsonObject event = element.getAsJsonObject();
            String type = event.has("type") && !event.get("type").isJsonNull()
                    ? event.get("type").getAsString()
                    : "";
            if (!"response.output_text.delta".equals(type)
                    && !"response.refusal.delta".equals(type)
                    && !"output_text.delta".equals(type)) {
                return "";
            }
            if (event.has("delta") && !event.get("delta").isJsonNull()) {
                return event.get("delta").getAsString();
            }
        } catch (Exception ignored) {
            return "";
        }
        return "";
    }

    private String extractChatCompletionText(JsonObject response) throws IOException {
        if (response == null
                || !response.has("choices")
                || !response.get("choices").isJsonArray()
                || response.getAsJsonArray("choices").size() == 0) {
            throw new IOException("OpenAI response did not contain choices.");
        }
        JsonObject firstChoice = response.getAsJsonArray("choices").get(0).getAsJsonObject();
        if (!firstChoice.has("message") || !firstChoice.get("message").isJsonObject()) {
            throw new IOException("OpenAI response did not contain message.");
        }
        JsonObject message = firstChoice.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            throw new IOException("OpenAI response message was empty.");
        }
        return message.get("content").getAsString();
    }

    private String extractResponsesText(JsonObject response) throws IOException {
        if (response != null && response.has("output_text") && !response.get("output_text").isJsonNull()) {
            return response.get("output_text").getAsString();
        }
        if (response == null || !response.has("output") || !response.get("output").isJsonArray()) {
            throw new IOException("OpenAI response did not contain output.");
        }
        StringBuilder out = new StringBuilder();
        JsonArray output = response.getAsJsonArray("output");
        for (JsonElement outputElement : output) {
            if (!outputElement.isJsonObject()) {
                continue;
            }
            JsonObject outputItem = outputElement.getAsJsonObject();
            if (!outputItem.has("content") || !outputItem.get("content").isJsonArray()) {
                continue;
            }
            JsonArray content = outputItem.getAsJsonArray("content");
            for (JsonElement contentElement : content) {
                if (!contentElement.isJsonObject()) {
                    continue;
                }
                JsonObject contentItem = contentElement.getAsJsonObject();
                if (contentItem.has("text") && !contentItem.get("text").isJsonNull()) {
                    out.append(contentItem.get("text").getAsString());
                }
            }
        }
        if (out.length() == 0) {
            throw new IOException("OpenAI response output was empty.");
        }
        return out.toString();
    }

    private String sseData(String line) {
        if (line == null) {
            return "";
        }
        String trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
            return trimmed;
        }
        return trimmed.substring("data:".length()).trim();
    }

    private String valueOr(String value, String fallback) {
        return notBlank(value) ? value.trim() : fallback;
    }

    private String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private String trimTrailingSlash(String value) {
        String out = value == null ? "" : value.trim();
        while (out.endsWith("/")) {
            out = out.substring(0, out.length() - 1);
        }
        return out;
    }

    private boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private String shorten(String text) {
        if (text == null) {
            return "";
        }
        return text.length() > 800 ? text.substring(0, 800) + "..." : text;
    }

    static final class Config {
        final String apiKey;
        final String baseUrl;
        final String model;
        final String wireApi;
        final String source;

        Config(String apiKey, String baseUrl, String model, String wireApi, String source) {
            this.apiKey = apiKey;
            this.baseUrl = baseUrl;
            this.model = model;
            this.wireApi = wireApi;
            this.source = source;
        }
    }

    private static final class HttpStatusIOException extends IOException {
        private final int statusCode;

        private HttpStatusIOException(int statusCode, String message) {
            super(message);
            this.statusCode = statusCode;
        }
    }
}
