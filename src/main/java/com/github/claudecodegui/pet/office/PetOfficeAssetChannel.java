package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** Two bounded authenticated art streams per source IDE; never occupies the control publisher. */
final class PetOfficeAssetChannel implements AutoCloseable {
    private static final int CHUNK = 32 * 1024;
    private final PetOfficeAppearancePublisher publisher;
    private final ServerSocket listener;
    private final PetOfficeEndpointStore.Endpoint endpoint;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new SynchronousQueue<>(),
            task -> PetOfficeIpcServer.daemon(task, "Pet Office asset peer"));
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor(task -> PetOfficeIpcServer.daemon(task, "Pet Office asset deadline"));

    PetOfficeAssetChannel(String owner, PetOfficeAppearancePublisher publisher) throws IOException {
        this.publisher = publisher;
        listener = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        byte[] token = new byte[32];
        new SecureRandom().nextBytes(token);
        endpoint = new PetOfficeEndpointStore.Endpoint(listener.getLocalPort(), UUID.randomUUID().toString(), HexFormat.of().formatHex(token), owner);
        PetOfficeIpcServer.daemon(this::accept, "Pet Office asset accept").start();
    }

    PetOfficeEndpointStore.Endpoint endpoint() { return endpoint; }

    private void accept() {
        while (!closed.get()) {
            Socket socket = null;
            try {
                socket = listener.accept();
                if (!socket.getInetAddress().isLoopbackAddress() || closed.get()) {
                    closeSocket(socket);
                    continue;
                }
                sockets.add(socket);
                Socket peer = socket;
                workers.execute(() -> serve(peer));
            } catch (IOException | RuntimeException failure) {
                if (socket != null) {
                    sockets.remove(socket);
                    closeSocket(socket);
                }
            }
        }
    }

    private void serve(Socket socket) {
        ScheduledFuture<?> deadline = null;
        try (socket) {
            socket.setTcpNoDelay(true);
            deadline = deadlines.schedule(() -> closeSocket(socket), 2, TimeUnit.SECONDS);
            JsonObject hello = PetOfficeIpcFrameCodec.read(socket.getInputStream());
            fields(hello, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "instanceId", "authProof");
            String requester = PetOfficeIpcFrameCodec.identifier(hello, "instanceId", false);
            validate(hello, "HELLO");
            if (!PetOfficeIpcAuthentication.verify(endpoint, "client", requester, string(hello, "connectionEpoch", 128), string(hello, "requestId", 128), hello)) {
                throw new IOException("OFFICE_IPC_AUTH_FAILED");
            }
            JsonObject welcome = envelope(hello, "WELCOME");
            welcome.addProperty("authProof", PetOfficeIpcAuthentication.proof(endpoint, "server", requester,
                    string(hello, "connectionEpoch", 128), string(hello, "requestId", 128)));
            PetOfficeIpcFrameCodec.write(socket.getOutputStream(), welcome);
            deadline.cancel(false);
            deadline = deadlines.schedule(() -> closeSocket(socket), 15, TimeUnit.SECONDS);
            JsonObject request = PetOfficeIpcFrameCodec.read(socket.getInputStream());
            String type = string(request, "type", 32);
            validate(request, type);
            if (!string(request, "connectionEpoch", 128).equals(string(hello, "connectionEpoch", 128))) {
                throw new IOException("OFFICE_IPC_EPOCH_INVALID");
            }
            byte[] bytes;
            BooleanSupplier current;
            if (type.equals("CATALOG")) {
                fields(request, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch");
                bytes = PetOfficeAppearanceCodec.encode(publisher.catalog(), endpoint.ownerInstanceId());
                current = () -> !closed.get();
            } else if (type.equals("ASSET")) {
                fields(request, "schemaVersion", "leaderEpoch", "type", "requestId", "connectionEpoch", "sourceKey", "revision", "digest");
                String key = string(request, "sourceKey", 512);
                String revision = string(request, "revision", 64);
                String digest = string(request, "digest", 64);
                if (!PetOfficeSessionRegistry.parseKey(key).instanceId().equals(endpoint.ownerInstanceId())
                        || !revision.matches("[a-f0-9]{64}") || !digest.matches("[a-f0-9]{64}")) {
                    throw new IOException("OFFICE_ASSET_INVALID");
                }
                bytes = publisher.bytes(key, revision, digest);
                current = () -> !closed.get() && publisher.current(key, revision, digest);
            } else {
                throw new IOException("OFFICE_IPC_REQUEST_UNSUPPORTED");
            }
            JsonObject begin = envelope(request, "BEGIN");
            begin.addProperty("byteLength", bytes.length);
            begin.addProperty("digest", PetOfficeAppearanceService.digest(bytes));
            PetOfficeIpcFrameCodec.write(socket.getOutputStream(), begin);
            for (int offset = 0; offset < bytes.length; offset += CHUNK) {
                if (!current.getAsBoolean()) {
                    throw new IOException("OFFICE_ASSET_STALE");
                }
                JsonObject chunk = envelope(request, "CHUNK");
                chunk.addProperty("index", offset / CHUNK);
                chunk.addProperty("data", Base64.getEncoder().encodeToString(Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + CHUNK))));
                PetOfficeIpcFrameCodec.write(socket.getOutputStream(), chunk);
            }
            if (!current.getAsBoolean()) {
                throw new IOException("OFFICE_ASSET_STALE");
            }
            PetOfficeIpcFrameCodec.write(socket.getOutputStream(), envelope(request, "COMMIT"));
        } catch (IOException | RuntimeException ignored) {
            // Closing a partial transfer leaves the last complete appearance and control stream intact.
        } finally {
            if (deadline != null) {
                deadline.cancel(false);
            }
            sockets.remove(socket);
        }
    }

    private void validate(JsonObject value, String type) throws IOException {
        if (closed.get() || integer(value, "schemaVersion", PetOfficeEndpointStore.VERSION) != PetOfficeEndpointStore.VERSION
                || !string(value, "leaderEpoch", 128).equals(endpoint.leaderEpoch()) || !string(value, "type", 32).equals(type)) {
            throw new IOException("OFFICE_IPC_EPOCH_INVALID");
        }
        PetOfficeIpcFrameCodec.identifier(value, "connectionEpoch", false);
        PetOfficeIpcFrameCodec.identifier(value, "requestId", false);
    }

    private static JsonObject envelope(JsonObject request, String type) {
        JsonObject value = new JsonObject();
        for (String field : new String[]{"schemaVersion", "leaderEpoch", "requestId", "connectionEpoch"}) {
            value.add(field, request.get(field));
        }
        value.addProperty("type", type);
        return value;
    }

    static Map<String, PetOfficeAppearanceService.Appearance> catalog(PetOfficeEndpointStore.Endpoint endpoint, String requester,
                                                                    BooleanSupplier current) throws IOException {
        return PetOfficeAppearanceCodec.decode(fetch(endpoint, requester, "CATALOG", new JsonObject(), PetOfficeAppearanceCodec.MAX_CATALOG_BYTES, current),
                endpoint.ownerInstanceId());
    }

    static byte[] asset(PetOfficeEndpointStore.Endpoint endpoint, String requester, String key,
                        PetOfficeAppearanceService.Appearance appearance, BooleanSupplier current) throws IOException {
        JsonObject request = new JsonObject();
        request.addProperty("sourceKey", key);
        request.addProperty("revision", appearance.revision());
        request.addProperty("digest", appearance.manifest().digest());
        byte[] bytes = fetch(endpoint, requester, "ASSET", request, PetOfficeAppearanceService.MAX_IMAGE_BYTES, current);
        if (bytes.length != appearance.manifest().byteLength() || !PetOfficeAppearanceService.digest(bytes).equals(appearance.manifest().digest())) {
            throw new IOException("OFFICE_ASSET_INVALID");
        }
        return bytes;
    }

    private static byte[] fetch(PetOfficeEndpointStore.Endpoint endpoint, String requester, String type, JsonObject payload,
                                int max, BooleanSupplier current) throws IOException {
        if (!current.getAsBoolean()) {
            throw new IOException("OFFICE_ASSET_STALE");
        }
        ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(task -> PetOfficeIpcServer.daemon(task, "Pet Office asset client deadline"));
        try (Socket socket = new Socket()) {
            ScheduledFuture<?> expiry = timer.schedule(() -> closeSocket(socket), 15, TimeUnit.SECONDS);
            ScheduledFuture<?> handshake = timer.schedule(() -> closeSocket(socket), 2, TimeUnit.SECONDS);
            try {
                socket.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), endpoint.port()), 2000);
                socket.setTcpNoDelay(true);
                JsonObject hello = new JsonObject();
                hello.addProperty("schemaVersion", PetOfficeEndpointStore.VERSION);
                hello.addProperty("leaderEpoch", endpoint.leaderEpoch());
                hello.addProperty("connectionEpoch", UUID.randomUUID().toString());
                hello.addProperty("requestId", UUID.randomUUID().toString());
                hello.addProperty("type", "HELLO");
                hello.addProperty("instanceId", requester);
                hello.addProperty("authProof", PetOfficeIpcAuthentication.proof(endpoint, "client", requester,
                        string(hello, "connectionEpoch", 128), string(hello, "requestId", 128)));
                PetOfficeIpcFrameCodec.write(socket.getOutputStream(), hello);
                JsonObject welcome = PetOfficeIpcFrameCodec.read(socket.getInputStream());
                fields(welcome, "schemaVersion", "leaderEpoch", "requestId", "connectionEpoch", "type", "authProof");
                correlate(hello, welcome, "WELCOME");
                if (!PetOfficeIpcAuthentication.verify(endpoint, "server", requester,
                        string(hello, "connectionEpoch", 128), string(hello, "requestId", 128), welcome)) {
                    throw new IOException("OFFICE_IPC_AUTH_FAILED");
                }
                handshake.cancel(false);
                if (!current.getAsBoolean()) {
                    throw new IOException("OFFICE_ASSET_STALE");
                }
                JsonObject request = envelope(hello, type);
                request.addProperty("requestId", UUID.randomUUID().toString());
                payload.entrySet().forEach(entry -> request.add(entry.getKey(), entry.getValue()));
                PetOfficeIpcFrameCodec.write(socket.getOutputStream(), request);
                JsonObject begin = PetOfficeIpcFrameCodec.read(socket.getInputStream());
                fields(begin, "schemaVersion", "leaderEpoch", "requestId", "connectionEpoch", "type", "byteLength", "digest");
                correlate(request, begin, "BEGIN");
                int length = (int) integer(begin, "byteLength", max);
                String digest = string(begin, "digest", 64);
                if (length == 0 || !digest.matches("[a-f0-9]{64}")) {
                    throw new IOException("OFFICE_ASSET_INVALID");
                }
                ByteArrayOutputStream bytes = new ByteArrayOutputStream(length);
                for (int offset = 0; offset < length; offset += CHUNK) {
                    if (!current.getAsBoolean()) {
                        throw new IOException("OFFICE_ASSET_STALE");
                    }
                    JsonObject chunk = PetOfficeIpcFrameCodec.read(socket.getInputStream());
                    fields(chunk, "schemaVersion", "leaderEpoch", "requestId", "connectionEpoch", "type", "index", "data");
                    correlate(request, chunk, "CHUNK");
                    String data = string(chunk, "data", 44000);
                    byte[] part = Base64.getDecoder().decode(data);
                    if (integer(chunk, "index", 128) != offset / CHUNK || part.length != Math.min(CHUNK, length - offset)
                            || !Base64.getEncoder().encodeToString(part).equals(data)) {
                        throw new IOException("OFFICE_ASSET_INVALID");
                    }
                    bytes.write(part);
                }
                JsonObject commit = PetOfficeIpcFrameCodec.read(socket.getInputStream());
                fields(commit, "schemaVersion", "leaderEpoch", "requestId", "connectionEpoch", "type");
                correlate(request, commit, "COMMIT");
                byte[] complete = bytes.toByteArray();
                if (!current.getAsBoolean() || !digest.equals(PetOfficeAppearanceService.digest(complete))) {
                    throw new IOException("OFFICE_ASSET_STALE");
                }
                return complete;
            } catch (RuntimeException invalid) {
                throw new IOException("OFFICE_ASSET_INVALID");
            } finally {
                expiry.cancel(false);
                handshake.cancel(false);
            }
        } finally {
            timer.shutdownNow();
        }
    }

    private static void correlate(JsonObject request, JsonObject reply, String type) throws IOException {
        for (String field : new String[]{"schemaVersion", "leaderEpoch", "requestId", "connectionEpoch"}) {
            if (!request.get(field).equals(reply.get(field))) {
                throw new IOException("OFFICE_IPC_REPLY_STALE");
            }
        }
        if (!string(reply, "type", 32).equals(type)) {
            throw new IOException("OFFICE_IPC_REPLY_INVALID");
        }
    }

    private static void closeSocket(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // The closed channel cannot publish partial bytes.
        }
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) {
            try {
                listener.close();
            } catch (IOException ignored) {
                // Accepted streams are closed independently below.
            }
            sockets.forEach(PetOfficeAssetChannel::closeSocket);
            workers.shutdownNow();
            deadlines.shutdownNow();
            publisher.close();
        }
    }
}
