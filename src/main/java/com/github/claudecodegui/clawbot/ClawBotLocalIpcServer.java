package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Objects;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/** Authenticated loopback IPC server for the local Claw Bot gateway. */
public final class ClawBotLocalIpcServer implements AutoCloseable {

    static final int PROTOCOL_VERSION = ClawBotIpcEnvelope.PROTOCOL_VERSION;
    static final int DEFAULT_SOCKET_TIMEOUT_MILLIS = 10_000;
    private static final int MAX_WORKERS = 4;
    private static final int MAX_QUEUED_CONNECTIONS = 16;
    private static final int MAX_TOKEN_LENGTH = 256;
    private static final String HELLO_TYPE = "GATEWAY_HELLO";
    private static final String WELCOME_TYPE = "GATEWAY_WELCOME";
    private static final String REJECTED_TYPE = "GATEWAY_REJECTED";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final String instanceId;
    private final long connectionEpoch;
    private final String authToken;
    private final Function<ClawBotIpcEnvelope, ClawBotIpcEnvelope> handler;
    private final int maxFrameBytes;
    private final int socketTimeoutMillis;
    private final ExecutorService workers;
    private final Object lifecycleLock = new Object();
    private volatile boolean running;
    private boolean closed;
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private Endpoint endpoint;

    public ClawBotLocalIpcServer(
            String instanceId,
            long connectionEpoch,
            Function<ClawBotIpcEnvelope, ClawBotIpcEnvelope> handler
    ) {
        this(instanceId, connectionEpoch, createAuthToken(), handler,
                ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES, DEFAULT_SOCKET_TIMEOUT_MILLIS);
    }

    public ClawBotLocalIpcServer(
            String instanceId,
            long connectionEpoch,
            String authToken,
            Function<ClawBotIpcEnvelope, ClawBotIpcEnvelope> handler
    ) {
        this(instanceId, connectionEpoch, authToken, handler,
                ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES, DEFAULT_SOCKET_TIMEOUT_MILLIS);
    }

    ClawBotLocalIpcServer(
            String instanceId,
            long connectionEpoch,
            String authToken,
            Function<ClawBotIpcEnvelope, ClawBotIpcEnvelope> handler,
            int maxFrameBytes,
            int socketTimeoutMillis
    ) {
        this.instanceId = requireValue(instanceId, "instanceId", ClawBotIpcEnvelope.MAX_IDENTIFIER_LENGTH);
        if (connectionEpoch < 0) {
            throw new IllegalArgumentException("Invalid connectionEpoch");
        }
        this.connectionEpoch = connectionEpoch;
        this.authToken = requireValue(authToken, "authToken", MAX_TOKEN_LENGTH);
        this.handler = Objects.requireNonNull(handler, "handler");
        if (maxFrameBytes <= 0) {
            throw new IllegalArgumentException("Invalid maxFrameBytes");
        }
        if (socketTimeoutMillis <= 0) {
            throw new IllegalArgumentException("Invalid socketTimeoutMillis");
        }
        this.maxFrameBytes = maxFrameBytes;
        this.socketTimeoutMillis = socketTimeoutMillis;
        this.workers = new ThreadPoolExecutor(
                MAX_WORKERS,
                MAX_WORKERS,
                0L,
                TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(MAX_QUEUED_CONNECTIONS),
                daemonThreadFactory("clawbot-ipc-worker-"),
                new ThreadPoolExecutor.AbortPolicy());
    }

    /** Binds to an ephemeral loopback port and starts accepting authenticated clients. */
    public Endpoint start() throws IOException {
        synchronized (lifecycleLock) {
            if (closed) {
                throw new IllegalStateException("CLAWBOT_IPC_SERVER_CLOSED");
            }
            if (endpoint != null) {
                return endpoint;
            }
            ServerSocket socket = new ServerSocket();
            try {
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
            } catch (IOException | RuntimeException error) {
                closeQuietly(socket);
                throw error;
            }
            serverSocket = socket;
            running = true;
            endpoint = new Endpoint(
                    InetAddress.getLoopbackAddress().getHostAddress(),
                    socket.getLocalPort(),
                    PROTOCOL_VERSION,
                    authToken);
            acceptThread = new Thread(this::acceptLoop, "clawbot-ipc-acceptor");
            acceptThread.setDaemon(true);
            acceptThread.start();
            return endpoint;
        }
    }

    @Override
    public void close() {
        ServerSocket socket;
        Thread thread;
        synchronized (lifecycleLock) {
            if (closed) {
                return;
            }
            closed = true;
            running = false;
            socket = serverSocket;
            thread = acceptThread;
            serverSocket = null;
            acceptThread = null;
            endpoint = null;
        }
        closeQuietly(socket);
        if (thread != null) {
            thread.interrupt();
        }
        workers.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            ServerSocket socket = serverSocket;
            if (socket == null) {
                return;
            }
            try {
                Socket client = socket.accept();
                try {
                    workers.execute(() -> handleConnection(client));
                } catch (RejectedExecutionException error) {
                    closeQuietly(client);
                }
            } catch (SocketException error) {
                if (running) {
                    closeQuietly(serverSocket);
                }
                return;
            } catch (IOException error) {
                if (running) {
                    closeQuietly(serverSocket);
                }
                return;
            }
        }
    }

    private void handleConnection(Socket socket) {
        try (Socket client = socket) {
            client.setSoTimeout(socketTimeoutMillis);
            JsonObject hello = ClawBotIpcFrameCodec.read(client.getInputStream(), maxFrameBytes);
            if (!HELLO_TYPE.equals(readString(hello, "type"))) {
                writeRejected(client, "CLAWBOT_IPC_HANDSHAKE_REQUIRED");
                return;
            }
            int protocolVersion = readInt(hello, "protocolVersion");
            if (protocolVersion != PROTOCOL_VERSION) {
                writeRejected(client, "CLAWBOT_IPC_PROTOCOL_UNSUPPORTED");
                return;
            }
            String requestId = readString(hello, "requestId");
            readString(hello, "clientInstanceId");
            readLong(hello, "clientConnectionEpoch");
            String candidateToken = readString(hello, "authToken");
            if (!constantTimeEquals(authToken, candidateToken)) {
                writeRejected(client, "CLAWBOT_IPC_AUTH_FAILED");
                return;
            }
            ClawBotIpcFrameCodec.write(client.getOutputStream(), createWelcome(requestId), maxFrameBytes);

            JsonObject requestJson = ClawBotIpcFrameCodec.read(client.getInputStream(), maxFrameBytes);
            ClawBotIpcEnvelope request;
            try {
                request = ClawBotIpcEnvelope.fromJson(requestJson);
            } catch (IllegalArgumentException error) {
                writeRejected(client, "CLAWBOT_IPC_ENVELOPE_INVALID");
                return;
            }
            ClawBotIpcEnvelope response;
            try {
                response = Objects.requireNonNull(handler.apply(request), "handler response");
            } catch (RuntimeException error) {
                writeRejected(client, "CLAWBOT_IPC_HANDLER_FAILED");
                return;
            }
            ClawBotIpcFrameCodec.write(client.getOutputStream(), response.toJson(), maxFrameBytes);
        } catch (IOException | RuntimeException ignored) {
            closeQuietly(socket);
        }
    }

    private JsonObject createWelcome(String requestId) {
        JsonObject welcome = new JsonObject();
        welcome.addProperty("protocolVersion", PROTOCOL_VERSION);
        welcome.addProperty("type", WELCOME_TYPE);
        welcome.addProperty("requestId", requestId);
        welcome.addProperty("instanceId", instanceId);
        welcome.addProperty("connectionEpoch", connectionEpoch);
        return welcome;
    }

    private void writeRejected(Socket socket, String code) throws IOException {
        JsonObject rejected = new JsonObject();
        rejected.addProperty("protocolVersion", PROTOCOL_VERSION);
        rejected.addProperty("type", REJECTED_TYPE);
        rejected.addProperty("code", code);
        ClawBotIpcFrameCodec.write(socket.getOutputStream(), rejected, maxFrameBytes);
    }

    private static String createAuthToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static boolean constantTimeEquals(String expected, String candidate) {
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8),
                candidate.getBytes(StandardCharsets.UTF_8));
    }

    private static String readString(JsonObject object, String name) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        String result = value.getAsString();
        if (result.isBlank() || result.length() > 256 || result.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        return result;
    }

    private static int readInt(JsonObject object, String name) throws IOException {
        try {
            return object.get(name).getAsInt();
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase(), error);
        }
    }

    private static long readLong(JsonObject object, String name) throws IOException {
        try {
            long value = object.get(name).getAsLong();
            if (value < 0) {
                throw new NumberFormatException("negative");
            }
            return value;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase(), error);
        }
    }

    private static String requireValue(String value, String name, int maxLength) {
        if (value == null || value.isBlank() || value.length() > maxLength
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid " + name);
        }
        return value;
    }

    private static ThreadFactory daemonThreadFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return runnable -> {
            Thread thread = new Thread(runnable, prefix + sequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }

    private static void closeQuietly(ServerSocket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private static void closeQuietly(Socket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    /** Immutable endpoint descriptor; its string form intentionally omits the authentication token. */
    public static final class Endpoint {
        private final String host;
        private final int port;
        private final int protocolVersion;
        private final String authToken;

        public Endpoint(String host, int port, int protocolVersion, String authToken) {
            this.host = requireValue(host, "host", 128);
            this.port = port;
            if (port < 1 || port > 65535) {
                throw new IllegalArgumentException("Invalid port");
            }
            if (protocolVersion != PROTOCOL_VERSION) {
                throw new IllegalArgumentException("CLAWBOT_IPC_PROTOCOL_UNSUPPORTED");
            }
            this.protocolVersion = protocolVersion;
            this.authToken = requireValue(authToken, "authToken", MAX_TOKEN_LENGTH);
        }

        public String host() {
            return host;
        }

        public int port() {
            return port;
        }

        public int protocolVersion() {
            return protocolVersion;
        }

        String authToken() {
            return authToken;
        }

        @Override
        public String toString() {
            return "Endpoint{" + host + ':' + port + ", protocolVersion=" + protocolVersion + '}';
        }
    }
}
