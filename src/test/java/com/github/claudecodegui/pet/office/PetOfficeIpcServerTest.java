package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.DataOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

public class PetOfficeIpcServerTest {
    @Test
    public void independentClientsPublishIntoOneRosterAndOnlyRequestVisibility() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        AtomicInteger show = new AtomicInteger();
        try (var server = new PetOfficeIpcServer("host", registry, () -> true, show::incrementAndGet);
             var idea = new PetOfficeIpcClient(server.endpoint(), "idea");
             var pycharm = new PetOfficeIpcClient(server.endpoint(), "pycharm")) {
            idea.publish(PetOfficeParticipantFixture.snapshot("idea", 2, 1, 1));
            pycharm.publish(PetOfficeParticipantFixture.snapshot("pycharm", 2, 1, 1));
            assertEquals(4, registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().size());
            idea.show();
            assertEquals(1, show.get());
            idea.heartbeat();
            assertEquals(4, registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().size());
        }
    }

    @Test
    public void wrongSecretUnknownVersionAndOversizedFramesCannotRegisterSources() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        try (var server = new PetOfficeIpcServer("host", registry, () -> true, () -> { })) {
            var bad = new PetOfficeEndpointStore.Endpoint(server.endpoint().port(), server.endpoint().leaderEpoch(), "a".repeat(64), "host");
            assertThrows(IOException.class, () -> new PetOfficeIpcClient(bad, "bad"));
            for (int length : new int[]{-1, 65537, Integer.MAX_VALUE}) {
                try (Socket socket = new Socket("127.0.0.1", server.endpoint().port())) {
                    socket.setSoTimeout(3000);
                    new DataOutputStream(socket.getOutputStream()).writeInt(length);
                    assertEquals(-1, socket.getInputStream().read());
                }
            }
            try (Socket socket = new Socket("127.0.0.1", server.endpoint().port())) {
                socket.setSoTimeout(3000);
                JsonObject hello = new JsonObject();
                hello.addProperty("schemaVersion", PetOfficeEndpointStore.VERSION + 1);
                PetOfficeIpcFrameCodec.write(socket.getOutputStream(), hello);
                assertEquals(-1, socket.getInputStream().read());
            }
            assertTrue(registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().isEmpty());
        }
    }

    @Test
    public void aReusedPortCannotReflectTheClientProofOrObtainTheSecret() throws Exception {
        AtomicReference<JsonObject> captured = new AtomicReference<>();
        try (ServerSocket listener = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            var endpoint = new PetOfficeEndpointStore.Endpoint(listener.getLocalPort(), UUID.randomUUID().toString(), "b".repeat(64), "host");
            Thread fake = PetOfficeIpcServer.daemon(() -> {
                try (Socket socket = listener.accept()) {
                    JsonObject hello = PetOfficeIpcFrameCodec.read(socket.getInputStream());
                    captured.set(hello);
                    JsonObject reply = hello.deepCopy();
                    reply.remove("instanceId");
                    reply.addProperty("type", "WELCOME");
                    reply.addProperty("result", "WELCOME");
                    PetOfficeIpcFrameCodec.write(socket.getOutputStream(), reply);
                } catch (IOException failure) {
                    throw new AssertionError(failure);
                }
            }, "Pet Office test reused port");
            fake.start();
            IOException failure = assertThrows(IOException.class, () -> new PetOfficeIpcClient(endpoint, "idea"));
            assertEquals("OFFICE_IPC_AUTH_FAILED", failure.getMessage());
            fake.join(3000);
            assertFalse(fake.isAlive());
            assertNotNull(captured.get());
            assertFalse(captured.get().has("token"));
            assertFalse(captured.get().toString().contains(endpoint.token()));
            assertFalse(endpoint.toString().contains(endpoint.token()));
        }
    }

    @Test
    public void slowHandshakeHasAnAbsoluteDeadlineEvenWhileBytesContinueArriving() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        try (var server = new PetOfficeIpcServer("host", registry, () -> true, () -> { }, 150);
             Socket socket = new Socket("127.0.0.1", server.endpoint().port())) {
            socket.setSoTimeout(2000);
            new DataOutputStream(socket.getOutputStream()).writeInt(1000);
            long started = System.nanoTime();
            for (int i = 0; i < 8; i++) {
                try {
                    socket.getOutputStream().write(' ');
                } catch (IOException closed) {
                    break;
                }
                Thread.sleep(25);
            }
            try {
                assertEquals(-1, socket.getInputStream().read());
            } catch (SocketException reset) {
                // Windows can reset a socket closed by the deadline with unread incoming bytes.
                assertNotNull(reset.getMessage());
            }
            assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 1500);
            assertTrue(registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().isEmpty());
        }
    }

    @Test
    public void partialReplacementAndDigestFailureRetainTheLastCommittedRoster() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        try (var server = new PetOfficeIpcServer("host", registry, () -> true, () -> { });
             RawPeer peer = new RawPeer(server.endpoint(), "peer")) {
            byte[] first = peer.bytes(64, 1);
            assertTrue(first.length > 32768);
            String initial = peer.begin(first, 1, PetOfficeAppearanceService.digest(first));
            peer.chunks(initial, first, Integer.MAX_VALUE);
            assertEquals("COMMITTED", peer.commit(initial).get("result").getAsString());
            byte[] replacement = peer.bytes(65, 2);
            String pending = peer.begin(replacement, 2, PetOfficeAppearanceService.digest(replacement));
            peer.chunks(pending, replacement, 1);
            assertEquals(64, registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().size());
            JsonObject rejected = peer.commit(pending);
            assertEquals("ERROR", rejected.get("type").getAsString());
            assertEquals("OFFICE_SNAPSHOT_DIGEST_INVALID", rejected.get("result").getAsString());
            assertEquals(64, registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().size());
        }
    }

    @Test
    public void corruptedDigestCannotCreateSources() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        try (var server = new PetOfficeIpcServer("host", registry, () -> true, () -> { });
             RawPeer peer = new RawPeer(server.endpoint(), "peer")) {
            byte[] bytes = peer.bytes(1, 1);
            String id = peer.begin(bytes, 1, "0".repeat(64));
            peer.chunks(id, bytes, Integer.MAX_VALUE);
            assertEquals("OFFICE_SNAPSHOT_DIGEST_INVALID", peer.commit(id).get("result").getAsString());
            assertTrue(registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().isEmpty());
        }
    }

    @Test
    public void authenticatedUnknownCommandsCannotInvokeTheWindowOrAnyGeneralHandler() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        AtomicInteger show = new AtomicInteger();
        try (var server = new PetOfficeIpcServer("host", registry, () -> true, show::incrementAndGet);
             RawPeer peer = new RawPeer(server.endpoint(), "peer")) {
            JsonObject rejected = peer.request("send_message", new JsonObject());
            assertEquals("ERROR", rejected.get("type").getAsString());
            assertEquals("OFFICE_IPC_REQUEST_UNSUPPORTED", rejected.get("result").getAsString());
            assertEquals(0, show.get());
            assertTrue(registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().isEmpty());
        }
    }

    @Test
    public void obsoleteSocketCleanupCannotEraseTheNewConnectionAndCapacityReportsItsReason() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        try (var server = new PetOfficeIpcServer("host", registry, () -> true, () -> { });
             var old = new PetOfficeIpcClient(server.endpoint(), "idea");
             var latest = new PetOfficeIpcClient(server.endpoint(), "idea")) {
            latest.publish(PetOfficeParticipantFixture.snapshot("idea", 256, 2, 2));
            old.close();
            latest.heartbeat();
            var view = registry.view("host", server.endpoint().leaderEpoch());
            assertEquals(256, view.snapshot().sources().size());
            assertEquals(SessionExecutionState.Phase.RUNNING, view.snapshot().sources().get(0).execution().phase());
            try (var peer = new PetOfficeIpcClient(server.endpoint(), "pycharm")) {
                IOException error = assertThrows(IOException.class, () -> peer.publish(PetOfficeParticipantFixture.snapshot("pycharm", 1, 1, 1)));
                assertEquals("OFFICE_SOURCE_CAPACITY", error.getMessage());
            }
            assertTrue(registry.view("host", server.endpoint().leaderEpoch()).snapshot().capacityReached());
        }
    }

    @Test
    public void losingLeaseAuthorityRejectsVisibilityAndDisposalClosesExistingStreams() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        AtomicBoolean owns = new AtomicBoolean(true);
        AtomicInteger show = new AtomicInteger();
        try (var server = new PetOfficeIpcServer("host", registry, owns::get, show::incrementAndGet);
             var client = new PetOfficeIpcClient(server.endpoint(), "idea")) {
            owns.set(false);
            assertThrows(IOException.class, client::show);
            assertEquals(0, show.get());
            server.close();
            assertThrows(IOException.class, client::heartbeat);
        }
    }

    private static final class RawPeer implements AutoCloseable {
        private final PetOfficeEndpointStore.Endpoint endpoint;
        private final String owner;
        private final String epoch = UUID.randomUUID().toString();
        private final Socket socket;

        private RawPeer(PetOfficeEndpointStore.Endpoint endpoint, String owner) throws IOException {
            this.endpoint = endpoint;
            this.owner = owner;
            socket = new Socket("127.0.0.1", endpoint.port());
            socket.setSoTimeout(3000);
            JsonObject hello = new JsonObject();
            hello.addProperty("instanceId", owner);
            JsonObject packet = packet("HELLO", hello);
            packet.addProperty("authProof", PetOfficeIpcAuthentication.proof(endpoint, "client", owner, epoch, packet.get("requestId").getAsString()));
            PetOfficeIpcFrameCodec.write(socket.getOutputStream(), packet);
            JsonObject welcome = PetOfficeIpcFrameCodec.read(socket.getInputStream());
            assertTrue(PetOfficeIpcAuthentication.verify(endpoint, "server", owner, epoch, packet.get("requestId").getAsString(), welcome));
        }

        private byte[] bytes(int count, long watermark) throws IOException {
            return PetOfficeParticipantSnapshotCodec.encode(PetOfficeParticipantFixture.snapshot(owner, count, watermark, watermark), epoch);
        }

        private String begin(byte[] bytes, long watermark, String digest) throws IOException {
            String id = UUID.randomUUID().toString();
            JsonObject begin = new JsonObject();
            begin.addProperty("transferId", id);
            begin.addProperty("byteLength", bytes.length);
            begin.addProperty("chunkCount", (bytes.length + 32767) / 32768);
            begin.addProperty("digest", digest);
            begin.addProperty("watermark", watermark);
            begin.addProperty("captureAgeMillis", 0);
            assertEquals("READY", request("SNAPSHOT_BEGIN", begin).get("result").getAsString());
            return id;
        }

        private void chunks(String id, byte[] bytes, int max) throws IOException {
            int index = 0;
            for (int offset = 0; offset < bytes.length && index < max; offset += 32768) {
                JsonObject chunk = new JsonObject();
                chunk.addProperty("transferId", id);
                chunk.addProperty("index", index++);
                chunk.addProperty("data", Base64.getEncoder().encodeToString(Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + 32768))));
                assertEquals("CHUNK", request("SNAPSHOT_CHUNK", chunk).get("result").getAsString());
            }
        }

        private JsonObject commit(String id) throws IOException {
            JsonObject commit = new JsonObject();
            commit.addProperty("transferId", id);
            return request("SNAPSHOT_COMMIT", commit);
        }

        private JsonObject request(String type, JsonObject payload) throws IOException {
            PetOfficeIpcFrameCodec.write(socket.getOutputStream(), packet(type, payload));
            return PetOfficeIpcFrameCodec.read(socket.getInputStream());
        }

        private JsonObject packet(String type, JsonObject payload) {
            JsonObject packet = payload.deepCopy();
            packet.addProperty("schemaVersion", PetOfficeEndpointStore.VERSION);
            packet.addProperty("leaderEpoch", endpoint.leaderEpoch());
            packet.addProperty("connectionEpoch", epoch);
            packet.addProperty("requestId", UUID.randomUUID().toString());
            packet.addProperty("type", type);
            return packet;
        }

        @Override
        public void close() throws IOException {
            socket.close();
        }
    }
}
