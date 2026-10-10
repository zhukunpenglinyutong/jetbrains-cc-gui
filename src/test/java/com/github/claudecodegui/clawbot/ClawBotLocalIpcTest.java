package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class ClawBotLocalIpcTest {

    @Test
    public void roundTripUsesAuthenticatedLoopbackConnection() throws Exception {
        try (ClawBotLocalIpcServer server = new ClawBotLocalIpcServer(
                "gateway-instance",
                11,
                request -> {
                    JsonObject payload = new JsonObject();
                    payload.addProperty("acceptedType", request.type());
                    return new ClawBotIpcEnvelope(
                            1,
                            "PONG",
                            request.requestId(),
                            "gateway-instance",
                            11,
                            payload);
                })) {
            ClawBotLocalIpcServer.Endpoint endpoint = server.start();
            ClawBotLocalIpcClient client = new ClawBotLocalIpcClient(endpoint, "client-instance", 3);
            JsonObject requestPayload = new JsonObject();
            requestPayload.addProperty("text", "ping");

            ClawBotIpcEnvelope response = client.request(new ClawBotIpcEnvelope(
                    1,
                    "PING",
                    "request-1",
                    "client-instance",
                    3,
                    requestPayload));

            assertEquals("PONG", response.type());
            assertEquals("PING", response.payload().get("acceptedType").getAsString());
            assertEquals("gateway-instance", response.instanceId());
            assertEquals(11, response.connectionEpoch());
        }
    }

    @Test
    public void acceptsInternalStatusRequest() throws Exception {
        try (ClawBotLocalIpcServer server = new ClawBotLocalIpcServer(
                "gateway-instance", 11, request -> new ClawBotIpcEnvelope(
                1,
                "CLAWBOT_STATUS_RESULT",
                request.requestId(),
                "gateway-instance",
                11,
                new JsonObject()))) {
            ClawBotLocalIpcServer.Endpoint endpoint = server.start();
            ClawBotIpcEnvelope response = new ClawBotLocalIpcClient(
                    endpoint, "client-instance", 3).request(new ClawBotIpcEnvelope(
                    1,
                    "CLAWBOT_STATUS",
                    "request-status",
                    "client-instance",
                    3,
                    new JsonObject()));

            assertEquals("CLAWBOT_STATUS_RESULT", response.type());
        }
    }

    @Test
    public void rejectsWrongAuthenticationToken() throws Exception {
        try (ClawBotLocalIpcServer server = new ClawBotLocalIpcServer(
                "gateway-instance", 1, "expected-token", request -> request)) {
            ClawBotLocalIpcServer.Endpoint endpoint = server.start();
            ClawBotLocalIpcServer.Endpoint wrongEndpoint = new ClawBotLocalIpcServer.Endpoint(
                    endpoint.host(), endpoint.port(), endpoint.protocolVersion(), "wrong-token");
            ClawBotLocalIpcClient client = new ClawBotLocalIpcClient(wrongEndpoint, "client-instance", 1);

            try {
                client.request(new ClawBotIpcEnvelope(
                        1,
                        "PING",
                        "request-2",
                        "client-instance",
                        1,
                        new JsonObject()));
                fail("Expected authentication failure");
            } catch (IOException error) {
                assertTrue(error.getMessage().contains("CLAWBOT_IPC_AUTH_FAILED"));
            }
        }
    }

    @Test
    public void rejectsOversizedFrameBeforeAllocatingPayload() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        DataOutputStream data = new DataOutputStream(output);
        data.writeInt(ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES + 1);
        data.flush();

        try {
            ClawBotIpcFrameCodec.read(
                    new ByteArrayInputStream(output.toByteArray()),
                    ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES);
            fail("Expected oversized frame rejection");
        } catch (IOException error) {
            assertEquals("CLAWBOT_IPC_FRAME_TOO_LARGE", error.getMessage());
        }
    }

    @Test
    public void rejectsInvalidJsonFrame() throws Exception {
        byte[] bytes = "not-json".getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        DataOutputStream data = new DataOutputStream(output);
        data.writeInt(bytes.length);
        data.write(bytes);
        data.flush();

        try {
            ClawBotIpcFrameCodec.read(
                    new ByteArrayInputStream(output.toByteArray()),
                    ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES);
            fail("Expected invalid JSON rejection");
        } catch (IOException error) {
            assertEquals("CLAWBOT_IPC_JSON_INVALID", error.getMessage());
        }
    }
}
