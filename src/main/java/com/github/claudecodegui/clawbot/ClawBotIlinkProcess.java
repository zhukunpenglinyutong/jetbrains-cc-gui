package com.github.claudecodegui.clawbot;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;

final class ClawBotIlinkProcess implements AutoCloseable {

    private static final String DAEMON_SCRIPT = "weixin-daemon.js";
    private static final int MAX_LINE_LENGTH = 256 * 1024;
    private static final long START_TIMEOUT_MILLIS = 10_000L;
    private static final long REQUEST_TIMEOUT_MILLIS = 45_000L;
    private static final long LONG_REQUEST_TIMEOUT_MILLIS = 50_000L;

    private final BridgeDirectoryResolver directoryResolver;
    private final NodeDetector nodeDetector;
    private final EnvironmentConfigurator environmentConfigurator;
    private final AtomicLong requestCounter = new AtomicLong();
    private final ConcurrentMap<String, CompletableFuture<JsonObject>> pending = new ConcurrentHashMap<>();
    private final Object writerLock = new Object();
    private volatile Process process;
    private volatile BufferedWriter writer;
    private volatile CompletableFuture<Void> ready;
    private volatile boolean closed;

    ClawBotIlinkProcess() {
        this(new BridgeDirectoryResolver(), NodeDetector.getInstance(), new EnvironmentConfigurator());
    }

    ClawBotIlinkProcess(
            BridgeDirectoryResolver directoryResolver,
            NodeDetector nodeDetector,
            EnvironmentConfigurator environmentConfigurator) {
        this.directoryResolver = Objects.requireNonNull(directoryResolver, "directoryResolver");
        this.nodeDetector = Objects.requireNonNull(nodeDetector, "nodeDetector");
        this.environmentConfigurator = Objects.requireNonNull(environmentConfigurator, "environmentConfigurator");
    }

    synchronized void start() throws IOException {
        if (closed) {
            throw new IOException("CLAWBOT_ILINK_PROCESS_CLOSED");
        }
        Process current = process;
        if (current != null && current.isAlive()) {
            return;
        }
        File bridgeDirectory = directoryResolver.findSdkDir();
        if (bridgeDirectory == null) {
            throw new IOException("CLAWBOT_ILINK_BRIDGE_UNAVAILABLE");
        }
        File daemonScript = new File(bridgeDirectory, DAEMON_SCRIPT);
        if (!daemonScript.isFile()) {
            throw new IOException("CLAWBOT_ILINK_DAEMON_UNAVAILABLE");
        }
        String nodePath = nodeDetector.findNodeExecutable();
        List<String> command = NodeDetector.buildNodeScriptCommand(nodePath, daemonScript.getAbsolutePath());
        ProcessBuilder processBuilder = new ProcessBuilder(command);
        processBuilder.directory(bridgeDirectory);
        environmentConfigurator.updateProcessEnvironment(processBuilder, nodePath);
        processBuilder.redirectErrorStream(false);
        Process started = processBuilder.start();
        BufferedWriter startedWriter = new BufferedWriter(
                new OutputStreamWriter(started.getOutputStream(), StandardCharsets.UTF_8));
        CompletableFuture<Void> startedReady = new CompletableFuture<>();
        process = started;
        writer = startedWriter;
        ready = startedReady;
        startReader(started, startedReady);
        startErrorReader(started);
        try {
            startedReady.get(START_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            closeProcess(started);
            throw new IOException("CLAWBOT_ILINK_START_INTERRUPTED", error);
        } catch (TimeoutException error) {
            closeProcess(started);
            throw new IOException("CLAWBOT_ILINK_START_TIMEOUT", error);
        } catch (java.util.concurrent.ExecutionException error) {
            closeProcess(started);
            throw new IOException("CLAWBOT_ILINK_START_FAILED", error.getCause());
        }
    }

    boolean isRunning() {
        Process current = process;
        return current != null && current.isAlive();
    }

    JsonObject request(String method, JsonObject params) throws IOException {
        if (method == null || method.isBlank() || method.length() > 64
                || method.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_ILINK_METHOD_INVALID");
        }
        Process current = process;
        BufferedWriter currentWriter = writer;
        if (current == null || !current.isAlive() || currentWriter == null) {
            throw new IOException("CLAWBOT_ILINK_PROCESS_UNAVAILABLE");
        }
        String requestId = Long.toString(requestCounter.incrementAndGet());
        CompletableFuture<JsonObject> response = new CompletableFuture<>();
        pending.put(requestId, response);
        try {
            JsonObject request = new JsonObject();
            request.addProperty("id", requestId);
            request.addProperty("method", method);
            request.add("params", params == null ? new JsonObject() : params.deepCopy());
            synchronized (writerLock) {
                currentWriter.write(request.toString());
                currentWriter.newLine();
                currentWriter.flush();
            }
            long timeout = "get_updates".equals(method) ? LONG_REQUEST_TIMEOUT_MILLIS : REQUEST_TIMEOUT_MILLIS;
            return response.get(timeout, TimeUnit.MILLISECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("CLAWBOT_ILINK_REQUEST_INTERRUPTED", error);
        } catch (TimeoutException error) {
            throw new IOException("CLAWBOT_ILINK_REQUEST_TIMEOUT", error);
        } catch (java.util.concurrent.ExecutionException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IlinkDaemonException daemonError) {
                throw new IOException(daemonError.code(), daemonError);
            }
            throw new IOException("CLAWBOT_ILINK_REQUEST_FAILED", cause);
        } finally {
            pending.remove(requestId, response);
        }
    }

    @Override
    public synchronized void close() {
        Process current;
        if (closed) {
            return;
        }
        closed = true;
        current = process;
        process = null;
        writer = null;
        CompletableFuture<Void> currentReady = ready;
        if (currentReady != null && !currentReady.isDone()) {
            currentReady.completeExceptionally(new IOException("CLAWBOT_ILINK_PROCESS_CLOSED"));
        }
        IOException failure = new IOException("CLAWBOT_ILINK_PROCESS_CLOSED");
        pending.forEach((requestId, response) -> response.completeExceptionally(failure));
        pending.clear();
        closeProcess(current);
    }

    private void startReader(Process started, CompletableFuture<Void> startedReady) {
        Thread reader = new Thread(() -> readResponses(started, startedReady), "clawbot-ilink-reader");
        reader.setDaemon(true);
        reader.start();
    }

    private void startErrorReader(Process started) {
        Thread errorReader = new Thread(() -> {
            try (BufferedReader input = new BufferedReader(
                    new InputStreamReader(started.getErrorStream(), StandardCharsets.UTF_8))) {
                while (input.readLine() != null) {
                }
            } catch (IOException ignored) {
            }
        }, "clawbot-ilink-stderr");
        errorReader.setDaemon(true);
        errorReader.start();
    }

    private void readResponses(Process started, CompletableFuture<Void> startedReady) {
        try (BufferedReader input = new BufferedReader(
                new InputStreamReader(started.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                if (line.isEmpty() || line.length() > MAX_LINE_LENGTH) {
                    continue;
                }
                dispatchLine(line, startedReady);
            }
            if (!startedReady.isDone()) {
                startedReady.completeExceptionally(new IOException("CLAWBOT_ILINK_PROCESS_EXITED"));
            }
        } catch (IOException error) {
            if (!startedReady.isDone()) {
                startedReady.completeExceptionally(new IOException("CLAWBOT_ILINK_READER_FAILED", error));
            }
        } finally {
            IOException failure = new IOException("CLAWBOT_ILINK_PROCESS_EXITED");
            pending.forEach((requestId, response) -> response.completeExceptionally(failure));
            pending.clear();
        }
    }

    private void dispatchLine(String line, CompletableFuture<Void> startedReady) {
        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(line);
        } catch (RuntimeException ignored) {
            return;
        }
        if (!parsed.isJsonObject()) {
            return;
        }
        JsonObject object = parsed.getAsJsonObject();
        if ("daemon".equals(readString(object, "type")) && "ready".equals(readString(object, "event"))) {
            startedReady.complete(null);
            return;
        }
        String requestId = readString(object, "id");
        if (requestId == null) {
            return;
        }
        CompletableFuture<JsonObject> response = pending.get(requestId);
        if (response == null) {
            return;
        }
        JsonElement error = object.get("error");
        if (error != null && error.isJsonObject()) {
            JsonObject errorObject = error.getAsJsonObject();
            String code = readString(errorObject, "code");
            String detail = readDiagnosticDetail(errorObject);
            response.completeExceptionally(new IlinkDaemonException(
                    code == null ? "CLAWBOT_ILINK_REQUEST_FAILED" : code, detail));
            return;
        }
        JsonElement result = object.get("result");
        if (result == null || !result.isJsonObject()) {
            response.completeExceptionally(new IlinkDaemonException("CLAWBOT_ILINK_RESPONSE_INVALID"));
            return;
        }
        response.complete(result.getAsJsonObject());
    }

    private static String readString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            return null;
        }
        return value.getAsString();
    }

    private static String readDiagnosticDetail(JsonObject object) {
        String detail = readString(object, "detail");
        if (detail == null || detail.length() > 512
                || detail.chars().anyMatch(Character::isISOControl)) {
            return null;
        }
        return detail;
    }

    private void closeProcess(Process target) {
        if (target == null) {
            return;
        }
        target.destroy();
        try {
            if (!target.waitFor(2, TimeUnit.SECONDS)) {
                target.destroyForcibly();
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            target.destroyForcibly();
        }
    }

    static final class IlinkDaemonException extends Exception {

        private final String code;
        private final String detail;

        private IlinkDaemonException(String code) {
            this(code, null);
        }

        private IlinkDaemonException(String code, String detail) {
            this.code = code;
            this.detail = detail;
        }

        private String code() {
            return code;
        }

        String detail() {
            return detail;
        }
    }
}
