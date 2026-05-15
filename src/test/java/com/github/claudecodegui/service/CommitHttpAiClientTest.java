package com.github.claudecodegui.service;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;

public class CommitHttpAiClientTest {

    private HttpServer server;
    private int port;

    @Before
    public void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        port = server.getAddress().getPort();
    }

    @After
    public void tearDown() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    public void shouldRetryTemporaryHttp503AndEventuallyReturnStreamingResult() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        server.createContext("/v1/chat/completions", exchange -> {
            int attempt = attempts.incrementAndGet();
            if (attempt == 1) {
                respond(exchange, 503, "{\"error\":{\"message\":\"Service temporarily unavailable\"}}");
                return;
            }
            respond(exchange, 200,
                    "data: {\"choices\":[{\"delta\":{\"content\":\"fix: hello\"}}]}\n\n"
                            + "data: [DONE]\n\n",
                    "text/event-stream");
        });
        server.start();

        CommitHttpAiClient client = new CommitHttpAiClient();
        CommitHttpAiClient.Config config = new CommitHttpAiClient.Config(
                "test-key",
                "http://localhost:" + port,
                "gpt-4.1-mini",
                "",
                "codex-http"
        );

        String result = client.generateOpenAiCompatible("hello", config, chunk -> { });

        assertEquals("fix: hello", result);
        assertEquals(2, attempts.get());
    }

    @Test
    public void shouldPreferResponsesApiForGpt5ModelsWhenWireApiIsNotExplicit() throws Exception {
        AtomicInteger chatAttempts = new AtomicInteger();
        AtomicInteger responseAttempts = new AtomicInteger();
        server.createContext("/v1/chat/completions", exchange -> {
            chatAttempts.incrementAndGet();
            respond(exchange, 500, "{\"error\":\"wrong endpoint\"}");
        });
        server.createContext("/v1/responses", exchange -> {
            responseAttempts.incrementAndGet();
            respond(exchange, 200,
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"fix: responses\"}\n\n"
                            + "data: [DONE]\n\n",
                    "text/event-stream");
        });
        server.start();

        CommitHttpAiClient client = new CommitHttpAiClient();
        CommitHttpAiClient.Config config = new CommitHttpAiClient.Config(
                "test-key",
                "http://localhost:" + port,
                "gpt-5.5",
                "",
                "codex-http"
        );

        String result = client.generateOpenAiCompatible("hello", config, chunk -> { });

        assertEquals("fix: responses", result);
        assertEquals(0, chatAttempts.get());
        assertEquals(1, responseAttempts.get());
    }

    @Test
    public void shouldRespectExplicitChatCompletionsBaseUrlForGpt5Models() throws Exception {
        AtomicInteger chatAttempts = new AtomicInteger();
        AtomicInteger responseAttempts = new AtomicInteger();
        server.createContext("/v1/chat/completions", exchange -> {
            chatAttempts.incrementAndGet();
            respond(exchange, 200,
                    "data: {\"choices\":[{\"delta\":{\"content\":\"fix: chat\"}}]}\n\n"
                            + "data: [DONE]\n\n",
                    "text/event-stream");
        });
        server.createContext("/v1/responses", exchange -> {
            responseAttempts.incrementAndGet();
            respond(exchange, 500, "{\"error\":\"wrong endpoint\"}");
        });
        server.start();

        CommitHttpAiClient client = new CommitHttpAiClient();
        CommitHttpAiClient.Config config = new CommitHttpAiClient.Config(
                "test-key",
                "http://localhost:" + port + "/v1/chat/completions",
                "gpt-5.5",
                "",
                "codex-http"
        );

        String result = client.generateOpenAiCompatible("hello", config, chunk -> { });

        assertEquals("fix: chat", result);
        assertEquals(1, chatAttempts.get());
        assertEquals(0, responseAttempts.get());
    }

    @Test
    public void shouldFallbackToNonStreamingResponsesWhenStreamingGetsTemporary503() throws Exception {
        AtomicInteger streamingAttempts = new AtomicInteger();
        AtomicInteger nonStreamingAttempts = new AtomicInteger();
        server.createContext("/v1/responses", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            boolean streaming = body.contains("\"stream\":true") || body.contains("\"stream\": true");
            if (streaming) {
                streamingAttempts.incrementAndGet();
                respond(exchange, 503, "{\"error\":{\"message\":\"Service temporarily unavailable\"}}");
                return;
            }
            nonStreamingAttempts.incrementAndGet();
            respond(exchange, 200,
                    "{\"output_text\":\"fix: fallback\"}",
                    "application/json");
        });
        server.start();

        CommitHttpAiClient client = new CommitHttpAiClient();
        CommitHttpAiClient.Config config = new CommitHttpAiClient.Config(
                "test-key",
                "http://localhost:" + port,
                "gpt-5.5",
                "responses",
                "codex-http"
        );

        String result = client.generateOpenAiCompatible("hello", config, chunk -> { });

        assertEquals("fix: fallback", result);
        assertEquals(3, streamingAttempts.get());
        assertEquals(1, nonStreamingAttempts.get());
    }

    private void respond(HttpExchange exchange, int statusCode, String body) throws IOException {
        respond(exchange, statusCode, body, "application/json");
    }

    private void respond(HttpExchange exchange, int statusCode, String body, String contentType) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.sendResponseHeaders(statusCode, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        } finally {
            exchange.close();
        }
    }
}
