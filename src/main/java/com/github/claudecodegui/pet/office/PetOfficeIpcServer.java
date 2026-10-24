package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Semaphore;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.identifier;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** One authenticated loopback endpoint. A lease owner remains the sole window authority. */
final class PetOfficeIpcServer implements AutoCloseable {
    private final PetOfficeParticipantRegistry registry;
    private final BooleanSupplier ownsLease;
    private final Runnable show;
    private volatile Runnable exit = () -> { };
    private final PetOfficeRouteBroker routes;
    private final long handshakeMillis;
    private final ServerSocket listener;
    private final PetOfficeEndpointStore.Endpoint endpoint;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final Semaphore pendingHandshakes = new Semaphore(8);
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(24, 24, 0, TimeUnit.MILLISECONDS, new SynchronousQueue<>(),
            task -> daemon(task, "Pet Office IPC peer"));
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor(task -> daemon(task, "Pet Office IPC deadline"));

    PetOfficeIpcServer(String owner, PetOfficeParticipantRegistry registry, BooleanSupplier ownsLease, Runnable show) throws IOException {
        this(owner, registry, ownsLease, show, 2000);
    }

    PetOfficeIpcServer(String owner, PetOfficeParticipantRegistry registry, BooleanSupplier ownsLease, Runnable show, long handshakeMillis) throws IOException {
        this.registry = registry;
        this.ownsLease = ownsLease;
        this.show = show;
        this.routes = new PetOfficeRouteBroker(registry, () -> !closed.get() && ownsLease.getAsBoolean());
        this.handshakeMillis = handshakeMillis;
        String epoch = UUID.randomUUID().toString();
        registry.bindOwner(owner);
        registry.connect(owner, UUID.randomUUID().toString());
        listener = new ServerSocket(0, 24, InetAddress.getByName("127.0.0.1"));
        byte[] token = new byte[32];
        new SecureRandom().nextBytes(token);
        endpoint = new PetOfficeEndpointStore.Endpoint(listener.getLocalPort(), epoch, HexFormat.of().formatHex(token), owner);
        daemon(this::accept, "Pet Office IPC accept").start();
    }

    PetOfficeEndpointStore.Endpoint endpoint() {
        return endpoint;
    }

    PetOfficeRouteBroker routes() {
        return routes;
    }

    void onExit(Runnable action) { exit = action; }

    boolean isRunning() {
        return !closed.get() && !listener.isClosed() && ownsLease.getAsBoolean();
    }

    private void accept() {
        while (!closed.get()) {
            Socket socket = null;
            boolean permit = false;
            try {
                socket = listener.accept();
                if (!ownsLease.getAsBoolean() || !socket.getInetAddress().isLoopbackAddress() || !pendingHandshakes.tryAcquire()) {
                    closeSocket(socket);
                    continue;
                }
                permit = true;
                sockets.add(socket);
                Socket peer = socket;
                workers.execute(() -> serve(peer));
            } catch (IOException | RuntimeException failure) {
                if (socket != null) {
                    sockets.remove(socket);
                    closeSocket(socket);
                    if (permit) {
                        pendingHandshakes.release();
                    }
                }
            }
        }
    }

    private void serve(Socket socket) {
        boolean unauthenticated = true;
        PetOfficeParticipantRegistry.Connection connection = null;
        ScheduledFuture<?> deadline = null;
        try (socket) {
            deadline = deadlines.schedule(() -> closeSocket(socket), handshakeMillis, TimeUnit.MILLISECONDS);
            socket.setTcpNoDelay(true);
            JsonObject hello = PetOfficeIpcFrameCodec.read(socket.getInputStream());
            fields(hello, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "instanceId", "authProof");
            validateEnvelope(hello, identifier(hello, "connectionEpoch", false));
            if (!"HELLO".equals(string(hello, "type", 32)) || !ownsLease.getAsBoolean()
                    || !PetOfficeIpcAuthentication.verify(endpoint, "client", identifier(hello, "instanceId", false),
                    identifier(hello, "connectionEpoch", false), identifier(hello, "requestId", false), hello)) {
                throw new IOException("OFFICE_IPC_AUTH_FAILED");
            }
            try {
                connection = registry.connect(identifier(hello, "instanceId", false), identifier(hello, "connectionEpoch", false));
            } catch (IOException rejected) {
                reply(socket, hello, "ERROR", rejected.getMessage());
                return;
            }
            reply(socket, hello, "WELCOME", "WELCOME");
            deadline.cancel(false);
            pendingHandshakes.release();
            unauthenticated = false;
            Staging staging = null;
            while (!closed.get() && ownsLease.getAsBoolean()) {
                deadline = deadlines.schedule(() -> closeSocket(socket), 5000, TimeUnit.MILLISECONDS);
                JsonObject packet = PetOfficeIpcFrameCodec.read(socket.getInputStream());
                validateEnvelope(packet, connection.epoch());
                registry.heartbeat(connection);
                String type = string(packet, "type", 32);
                try {
                    switch (type) {
                    case "ASSET_ENDPOINT":
                        fields(packet, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "endpoint");
                        registry.assetEndpoint(connection, PetOfficeAppearanceCodec.endpoint(packet.getAsJsonObject("endpoint"), connection.instanceId()));
                        reply(socket, packet, "ACK", "ASSET_REGISTERED");
                        break;
                    case "ROUTE_POLL":
                        fields(packet, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch");
                        reply(socket, packet, "ACK", "ROUTES", PetOfficeRouteProtocol.encode(routes.poll(connection)));
                        break;
                    case "ROUTE_RESULT":
                        fields(packet, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "navigationId", "ticket", "navigationResult");
                        routes.complete(connection, PetOfficeRouteProtocol.decodeReply(packet));
                        reply(socket, packet, "ACK", "RESULT_RECORDED");
                        break;
                    case "INSTANCE_HEARTBEAT":
                    case "WINDOW_SHOW":
                    case "WINDOW_EXIT":
                    case "GOODBYE":
                        fields(packet, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch");
                        if (type.equals("WINDOW_SHOW")) {
                            show.run();
                        } else if (type.equals("WINDOW_EXIT")) {
                            exit.run();
                        }
                        reply(socket, packet, "ACK", type.equals("WINDOW_SHOW") ? "SHOW_SCHEDULED" : type.equals("WINDOW_EXIT") ? "EXIT_SCHEDULED" : "ALIVE");
                        if (type.equals("GOODBYE")) {
                            return;
                        }
                        break;
                    case "SNAPSHOT_BEGIN":
                        fields(packet, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "transferId", "byteLength", "chunkCount", "digest", "watermark", "captureAgeMillis");
                        staging = new Staging(packet);
                        reply(socket, packet, "ACK", "READY");
                        break;
                    case "SNAPSHOT_CHUNK":
                        fields(packet, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "transferId", "index", "data");
                        stage(staging, packet).chunk(packet);
                        reply(socket, packet, "ACK", "CHUNK");
                        break;
                    case "SNAPSHOT_COMMIT":
                        fields(packet, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "transferId");
                        Staging complete = stage(staging, packet);
                        staging = null;
                        byte[] bytes = complete.finish();
                        registry.commit(connection, bytes, (System.nanoTime() - complete.startedAt) / 1_000_000 + complete.captureAgeMillis, complete.watermark);
                        reply(socket, packet, "ACK", "COMMITTED");
                        break;
                    default:
                        throw new IOException("OFFICE_IPC_REQUEST_UNSUPPORTED");
                    }
                } catch (IOException rejected) {
                    String code = rejected.getMessage();
                    reply(socket, packet, "ERROR", code != null && code.matches("OFFICE_[A-Z_]{1,56}") ? code : "OFFICE_IPC_UNAVAILABLE");
                    return;
                }
                deadline.cancel(false);
            }
        } catch (IOException | RuntimeException rejected) {
            // Do not log packet bodies, paths, tokens or peer-supplied exception text.
        } finally {
            if (deadline != null) {
                deadline.cancel(false);
            }
            if (unauthenticated) {
                pendingHandshakes.release();
            }
            if (connection != null) {
                registry.disconnect(connection);
            }
            sockets.remove(socket);
        }
    }

    private void validateEnvelope(JsonObject packet, String epoch) throws IOException {
        if (!ownsLease.getAsBoolean() || closed.get()) {
            throw new IOException("OFFICE_LEADER_LOST");
        }
        if (integer(packet, "schemaVersion", PetOfficeEndpointStore.VERSION) != PetOfficeEndpointStore.VERSION
                || !identifier(packet, "leaderEpoch", false).equals(endpoint.leaderEpoch())
                || !identifier(packet, "connectionEpoch", false).equals(epoch)) {
            throw new IOException("OFFICE_IPC_EPOCH_INVALID");
        }
        identifier(packet, "requestId", false);
    }

    private void reply(Socket socket, JsonObject request, String type, String result) throws IOException {
        reply(socket, request, type, result, null);
    }

    private void reply(Socket socket, JsonObject request, String type, String result, com.google.gson.JsonArray commands) throws IOException {
        JsonObject reply = new JsonObject();
        reply.addProperty("schemaVersion", PetOfficeEndpointStore.VERSION);
        reply.addProperty("leaderEpoch", endpoint.leaderEpoch());
        reply.addProperty("connectionEpoch", identifier(request, "connectionEpoch", false));
        reply.addProperty("requestId", identifier(request, "requestId", false));
        reply.addProperty("type", type);
        reply.addProperty("result", result);
        if (commands != null) {
            reply.add("commands", commands);
        }
        if (type.equals("WELCOME")) {
            reply.addProperty("authProof", PetOfficeIpcAuthentication.proof(endpoint, "server", identifier(request, "instanceId", false),
                    identifier(request, "connectionEpoch", false), identifier(request, "requestId", false)));
        }
        PetOfficeIpcFrameCodec.write(socket.getOutputStream(), reply);
    }

    private static Staging stage(Staging staging, JsonObject packet) throws IOException {
        if (staging == null || !identifier(packet, "transferId", false).equals(staging.id)
                || System.nanoTime() - staging.startedAt >= TimeUnit.SECONDS.toNanos(10)) {
            throw new IOException("OFFICE_SNAPSHOT_EXPIRED");
        }
        return staging;
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            routes.close();
            try {
                listener.close();
            } catch (IOException ignored) {
                // Closing the accepted sockets below still ends every admitted connection.
            }
            sockets.forEach(PetOfficeIpcServer::closeSocket);
            workers.shutdownNow();
            deadlines.shutdownNow();
        }
    }

    static Thread daemon(Runnable task, String name) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        return thread;
    }

    private static void closeSocket(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // The socket remains fenced by its exact registry connection and owner lease.
        }
    }

    private static final class Staging {
        private final String id;
        private final int length;
        private final int chunks;
        private final String digest;
        private final long watermark;
        private final long captureAgeMillis;
        private final long startedAt = System.nanoTime();
        private final ByteArrayOutputStream bytes;
        private int nextIndex;

        private Staging(JsonObject packet) throws IOException {
            id = identifier(packet, "transferId", false);
            length = (int) integer(packet, "byteLength", PetOfficeParticipantSnapshotCodec.MAX_BYTES);
            chunks = (int) integer(packet, "chunkCount", 64);
            watermark = integer(packet, "watermark", 9_007_199_254_740_991L);
            captureAgeMillis = integer(packet, "captureAgeMillis", 10_000);
            digest = string(packet, "digest", 64);
            if (length == 0 || chunks != (length + 32767) / 32768 || !digest.matches("[a-f0-9]{64}")) {
                throw new IOException("OFFICE_SNAPSHOT_INVALID");
            }
            bytes = new ByteArrayOutputStream(length);
        }

        private void chunk(JsonObject packet) throws IOException {
            if (integer(packet, "index", chunks) != nextIndex || nextIndex >= chunks) {
                throw new IOException("OFFICE_SNAPSHOT_CHUNK_INVALID");
            }
            String data = string(packet, "data", 44000);
            byte[] chunk;
            try {
                chunk = Base64.getDecoder().decode(data);
            } catch (IllegalArgumentException invalid) {
                throw new IOException("OFFICE_SNAPSHOT_CHUNK_INVALID");
            }
            if (chunk.length != Math.min(32768, length - nextIndex * 32768) || !Base64.getEncoder().encodeToString(chunk).equals(data)) {
                throw new IOException("OFFICE_SNAPSHOT_CHUNK_INVALID");
            }
            bytes.write(chunk);
            nextIndex++;
        }

        private byte[] finish() throws IOException {
            byte[] result = bytes.toByteArray();
            if (nextIndex != chunks || result.length != length || !digest.equals(PetOfficeAppearanceService.digest(result))) {
                throw new IOException("OFFICE_SNAPSHOT_DIGEST_INVALID");
            }
            return result;
        }
    }
}
