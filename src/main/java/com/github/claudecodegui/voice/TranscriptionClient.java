package com.github.claudecodegui.voice;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

/**
 * Uploads a recorded clip to an OpenAI-compatible {@code /audio/transcriptions} endpoint.
 */
public final class TranscriptionClient implements Transcriber {

    static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(60);
    private static final int MAX_ERROR_DETAIL_CHARS = 300;

    private final HttpClient httpClient;

    public TranscriptionClient(HttpClient httpClient) {
        this.httpClient = httpClient;
    }

    /**
     * Returns the transcribed text, trimmed.
     *
     * @param prompt preceding transcript that keeps spelling and style consistent across
     *               live segments; empty for none
     * @throws TranscriptionException when the endpoint rejects the request or returns no text
     */
    @Override
    public String transcribe(byte[] wav, VoiceInputConfig config, String prompt) throws IOException, InterruptedException {
        String boundary = "----ccgui-voice-" + UUID.randomUUID();
        HttpRequest.Builder builder;
        try {
            builder = HttpRequest.newBuilder(URI.create(config.transcriptionsUrl()));
        } catch (IllegalArgumentException e) {
            throw new TranscriptionException("invalid endpoint URL");
        }
        if (config.hasApiKey()) {
            builder.header("Authorization", "Bearer " + config.apiKey());
        }
        HttpRequest request = builder
                .timeout(REQUEST_TIMEOUT)
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(buildMultipartBody(boundary, wav, config, prompt)))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() / 100 != 2) {
            throw new TranscriptionException("HTTP " + response.statusCode() + ": " + errorDetail(response.body()));
        }
        return parseText(response.body());
    }

    static byte[] buildMultipartBody(String boundary, byte[] wav, VoiceInputConfig config, String prompt) {
        ByteArrayOutputStream body = new ByteArrayOutputStream(wav.length + 1024);
        writeField(body, boundary, "model", config.model());
        writeField(body, boundary, "response_format", "json");
        if (!config.language().isEmpty()) {
            writeField(body, boundary, "language", config.language());
        }
        if (!prompt.isEmpty()) {
            writeField(body, boundary, "prompt", prompt);
        }
        writeAscii(body, "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\n"
                + "Content-Type: audio/wav\r\n\r\n");
        body.writeBytes(wav);
        writeAscii(body, "\r\n--" + boundary + "--\r\n");
        return body.toByteArray();
    }

    static String parseText(String body) throws TranscriptionException {
        try {
            JsonElement root = JsonParser.parseString(body);
            if (root.isJsonObject() && root.getAsJsonObject().has("text")) {
                return root.getAsJsonObject().get("text").getAsString().trim();
            }
        } catch (JsonParseException | IllegalStateException | UnsupportedOperationException e) {
            throw new TranscriptionException("unexpected response: " + truncate(body));
        }
        throw new TranscriptionException("response has no text field: " + truncate(body));
    }

    static String errorDetail(String body) {
        try {
            JsonElement root = JsonParser.parseString(body);
            if (root.isJsonObject()) {
                JsonObject obj = root.getAsJsonObject();
                JsonElement error = obj.get("error");
                if (error != null && error.isJsonObject() && error.getAsJsonObject().has("message")) {
                    return error.getAsJsonObject().get("message").getAsString();
                }
                if (error != null && error.isJsonPrimitive()) {
                    return error.getAsString();
                }
            }
        } catch (JsonParseException | IllegalStateException | UnsupportedOperationException ignored) {
            // Non-JSON error bodies are reported verbatim below.
        }
        return truncate(body);
    }

    private static void writeField(ByteArrayOutputStream body, String boundary, String name, String value) {
        writeAscii(body, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
        body.writeBytes(value.getBytes(StandardCharsets.UTF_8));
        writeAscii(body, "\r\n");
    }

    private static void writeAscii(ByteArrayOutputStream body, String text) {
        body.writeBytes(text.getBytes(StandardCharsets.US_ASCII));
    }

    private static String truncate(String body) {
        String text = body == null ? "" : body.strip();
        return text.length() <= MAX_ERROR_DETAIL_CHARS ? text : text.substring(0, MAX_ERROR_DETAIL_CHARS) + "…";
    }

    /** The endpoint answered, but not with a usable transcript. */
    public static final class TranscriptionException extends IOException {
        public TranscriptionException(String message) {
            super(message);
        }
    }
}
