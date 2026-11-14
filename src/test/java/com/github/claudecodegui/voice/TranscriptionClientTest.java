package com.github.claudecodegui.voice;

import com.sun.net.httpserver.HttpServer;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

public class TranscriptionClientTest {

    private HttpServer server;
    private final AtomicReference<String> authHeader = new AtomicReference<>();
    private final AtomicReference<String> contentType = new AtomicReference<>();
    private final AtomicReference<String> requestBody = new AtomicReference<>();
    private volatile int responseStatus = 200;
    private volatile String responseBody = "{\"text\": \"  hello world \"}";

    @Before
    public void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/audio/transcriptions", exchange -> {
            authHeader.set(exchange.getRequestHeaders().getFirst("Authorization"));
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.ISO_8859_1));
            byte[] body = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(responseStatus, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
    }

    @After
    public void stopServer() {
        server.stop(0);
    }

    @Test
    public void postsMultipartClipAndReturnsTrimmedText() throws Exception {
        String text = client().transcribe(new byte[] {'R', 'I', 'F', 'F'}, config(baseUrl(), "sk-test", "uk"), "earlier words");

        assertEquals("hello world", text);
        assertEquals("Bearer sk-test", authHeader.get());
        assertTrue(contentType.get().startsWith("multipart/form-data; boundary="));
        String body = requestBody.get();
        assertTrue(body.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"));
        assertTrue(body.contains("name=\"language\"\r\n\r\nuk\r\n"));
        assertTrue(body.contains("name=\"prompt\"\r\n\r\nearlier words\r\n"));
        assertTrue(body.contains("filename=\"voice.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n"));
    }

    @Test
    public void omitsLanguageAndPromptWhenEmpty() throws Exception {
        client().transcribe(new byte[] {1}, config(baseUrl(), "sk", ""), "");

        assertFalse(requestBody.get().contains("name=\"language\""));
        assertFalse(requestBody.get().contains("name=\"prompt\""));
    }

    @Test
    public void sendsNoAuthorizationHeaderWithoutAKey() throws Exception {
        client().transcribe(new byte[] {1}, config(baseUrl(), "", ""), "");

        assertNull(authHeader.get());
    }

    @Test
    public void reportsAMalformedEndpointAsATranscriptionError() {
        TranscriptionClient.TranscriptionException e = assertThrows(TranscriptionClient.TranscriptionException.class,
                () -> client().transcribe(new byte[] {1}, config("http://bad host/v1", "sk", ""), ""));

        assertEquals("invalid endpoint URL", e.getMessage());
    }

    @Test
    public void surfacesOpenAiStyleErrorMessage() {
        responseStatus = 401;
        responseBody = "{\"error\": {\"message\": \"Incorrect API key provided\", \"type\": \"invalid_request_error\"}}";

        TranscriptionClient.TranscriptionException e = assertThrows(TranscriptionClient.TranscriptionException.class,
                () -> client().transcribe(new byte[] {1}, config(baseUrl(), "bad", ""), ""));

        assertEquals("HTTP 401: Incorrect API key provided", e.getMessage());
    }

    @Test
    public void rejectsSuccessWithoutText() {
        responseBody = "{\"segments\": []}";

        assertThrows(TranscriptionClient.TranscriptionException.class,
                () -> client().transcribe(new byte[] {1}, config(baseUrl(), "sk", ""), ""));
    }

    @Test
    public void errorDetailFallsBackToTruncatedRawBody() {
        assertEquals("upstream exploded", TranscriptionClient.errorDetail(" upstream exploded \n"));
        assertEquals("quota", TranscriptionClient.errorDetail("{\"error\": \"quota\"}"));
        String longBody = "x".repeat(500);
        assertEquals(301, TranscriptionClient.errorDetail(longBody).length());
    }

    private static VoiceInputConfig config(String baseUrl, String apiKey, String language) {
        return new VoiceInputConfig(baseUrl, apiKey, "whisper-1", language, false, List.of());
    }

    private TranscriptionClient client() {
        return new TranscriptionClient(HttpClient.newHttpClient());
    }

    private String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/v1";
    }
}
