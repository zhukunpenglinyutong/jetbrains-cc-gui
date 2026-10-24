package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** One publishing stream per participant. Every request has a hard IO deadline and exact reply identity. */
final class PetOfficeIpcClient implements AutoCloseable {
    private final PetOfficeEndpointStore.Endpoint endpoint;
    private final String instanceId;
    private final String epoch = UUID.randomUUID().toString();
    private final Socket socket = new Socket();
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor(task -> PetOfficeIpcServer.daemon(task, "Pet Office IPC client deadline"));
    private long lastWatermark = -1;

    PetOfficeIpcClient(PetOfficeEndpointStore.Endpoint endpoint, String instanceId) throws IOException {
        this.endpoint = endpoint;
        this.instanceId = instanceId;
        try {
            socket.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), endpoint.port()), 2000);
            socket.setTcpNoDelay(true);
            JsonObject hello = new JsonObject();
            hello.addProperty("instanceId", instanceId);
            request("HELLO", hello, "WELCOME");
        } catch (IOException | RuntimeException failure) {
            close();
            throw failure;
        }
    }

    void publish(PetOfficeSessionRegistry.CompleteSnapshot snapshot) throws IOException {
        if (snapshot.watermark() <= lastWatermark) {
            heartbeat();
            return;
        }
        long captured = System.nanoTime();
        byte[] bytes = PetOfficeParticipantSnapshotCodec.encode(snapshot, epoch);
        String transfer = UUID.randomUUID().toString();
        JsonObject begin = new JsonObject();
        begin.addProperty("transferId", transfer);
        begin.addProperty("byteLength", bytes.length);
        begin.addProperty("chunkCount", (bytes.length + 32767) / 32768);
        begin.addProperty("digest", PetOfficeAppearanceService.digest(bytes));
        begin.addProperty("watermark", snapshot.watermark());
        begin.addProperty("captureAgeMillis", (System.nanoTime() - captured) / 1_000_000);
        request("SNAPSHOT_BEGIN", begin, "READY");
        int index = 0;
        for (int offset = 0; offset < bytes.length; offset += 32768) {
            if (System.nanoTime() - captured >= TimeUnit.SECONDS.toNanos(10)) {
                close();
                throw new IOException("OFFICE_SNAPSHOT_EXPIRED");
            }
            JsonObject chunk = new JsonObject();
            chunk.addProperty("transferId", transfer);
            chunk.addProperty("index", index++);
            chunk.addProperty("data", Base64.getEncoder().encodeToString(Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + 32768))));
            request("SNAPSHOT_CHUNK", chunk, "CHUNK");
        }
        JsonObject commit = new JsonObject();
        commit.addProperty("transferId", transfer);
        request("SNAPSHOT_COMMIT", commit, "COMMITTED");
        lastWatermark = snapshot.watermark();
    }

    void heartbeat() throws IOException {
        request("INSTANCE_HEARTBEAT", new JsonObject(), "ALIVE");
    }

    void show() throws IOException {
        request("WINDOW_SHOW", new JsonObject(), "SHOW_SCHEDULED");
    }

    void exitOffice() throws IOException { request("WINDOW_EXIT", new JsonObject(), "EXIT_SCHEDULED"); }

    void assetEndpoint(PetOfficeEndpointStore.Endpoint endpoint) throws IOException {
        JsonObject payload = new JsonObject();
        payload.add("endpoint", PetOfficeAppearanceCodec.endpoint(endpoint));
        request("ASSET_ENDPOINT", payload, "ASSET_REGISTERED");
    }

    List<PetOfficeRouteBroker.Command> poll() throws IOException {
        return PetOfficeRouteProtocol.decode(request("ROUTE_POLL", new JsonObject(), "ROUTES").get("commands"), instanceId);
    }

    void complete(PetOfficeRouteBroker.Command command, PetOfficeTabNavigator.Result result) throws IOException {
        JsonObject payload = new JsonObject();
        payload.addProperty("navigationId", command.request().requestId());
        payload.addProperty("ticket", command.ticket());
        payload.addProperty("navigationResult", result.name());
        request("ROUTE_RESULT", payload, "RESULT_RECORDED");
    }

    String navigationPage() {
        return endpoint.leaderEpoch() + ":" + epoch;
    }

    boolean isClosed() {
        return socket.isClosed();
    }

    private JsonObject request(String type, JsonObject payload, String expected) throws IOException {
        JsonObject packet = payload.deepCopy();
        String requestId = UUID.randomUUID().toString();
        packet.addProperty("schemaVersion", PetOfficeEndpointStore.VERSION);
        packet.addProperty("leaderEpoch", endpoint.leaderEpoch());
        packet.addProperty("connectionEpoch", epoch);
        packet.addProperty("requestId", requestId);
        packet.addProperty("type", type);
        if (type.equals("HELLO")) {
            packet.addProperty("authProof", PetOfficeIpcAuthentication.proof(endpoint, "client", instanceId, epoch, requestId));
        }
        ScheduledFuture<?> deadline = null;
        try {
            if (socket.isClosed()) {
                throw new IOException("OFFICE_RUNTIME_CLOSED");
            }
            deadline = deadlines.schedule(this::closeSocket, 5000, TimeUnit.MILLISECONDS);
            PetOfficeIpcFrameCodec.write(socket.getOutputStream(), packet);
            JsonObject reply = PetOfficeIpcFrameCodec.read(socket.getInputStream());
            if (type.equals("HELLO") && "WELCOME".equals(PetOfficeIpcFrameCodec.string(reply, "type", 32))) {
                PetOfficeIpcFrameCodec.fields(reply, "schemaVersion", "leaderEpoch", "connectionEpoch", "requestId", "type", "result", "authProof");
                if (!PetOfficeIpcAuthentication.verify(endpoint, "server", instanceId, epoch, requestId, reply)) {
                    throw new IOException("OFFICE_IPC_AUTH_FAILED");
                }
            } else if (type.equals("ROUTE_POLL") && "ACK".equals(PetOfficeIpcFrameCodec.string(reply, "type", 32))) {
                PetOfficeIpcFrameCodec.fields(reply, "schemaVersion", "leaderEpoch", "connectionEpoch", "requestId", "type", "result", "commands");
            } else {
                PetOfficeIpcFrameCodec.fields(reply, "schemaVersion", "leaderEpoch", "connectionEpoch", "requestId", "type", "result");
            }
            if (PetOfficeIpcFrameCodec.integer(reply, "schemaVersion", PetOfficeEndpointStore.VERSION) != PetOfficeEndpointStore.VERSION
                    || !PetOfficeIpcFrameCodec.identifier(reply, "leaderEpoch", false).equals(endpoint.leaderEpoch())
                    || !PetOfficeIpcFrameCodec.identifier(reply, "connectionEpoch", false).equals(epoch)
                    || !PetOfficeIpcFrameCodec.identifier(reply, "requestId", false).equals(requestId)) {
                throw new IOException("OFFICE_IPC_REPLY_STALE");
            }
            String result = PetOfficeIpcFrameCodec.string(reply, "result", 64);
            String responseType = PetOfficeIpcFrameCodec.string(reply, "type", 32);
            if (responseType.equals("ERROR") && result.matches("OFFICE_[A-Z_]{1,56}")) {
                throw new IOException(result);
            }
            if (!responseType.equals(type.equals("HELLO") ? "WELCOME" : "ACK") || !result.equals(expected)) {
                throw new IOException("OFFICE_IPC_REPLY_INVALID");
            }
            return reply;
        } catch (IOException | RuntimeException failure) {
            close();
            if (failure instanceof IOException checked) {
                throw checked;
            }
            throw new IOException("OFFICE_IPC_UNAVAILABLE");
        } finally {
            if (deadline != null) {
                deadline.cancel(false);
            }
        }
    }

    @Override
    public void close() {
        closeSocket();
        deadlines.shutdownNow();
    }

    private void closeSocket() {
        try {
            socket.close();
        } catch (IOException ignored) {
            // The coordinator retires the exact connection independently of cleanup acknowledgement.
        }
    }
}
