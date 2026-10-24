package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.UUID;

/** Authenticated loopback IPC client for local Claw Bot gateway requests. */
public final class ClawBotLocalIpcClient {

    private final ClawBotLocalIpcServer.Endpoint endpoint;
    private final String instanceId;
    private final long connectionEpoch;
    private final int connectTimeoutMillis;
    private final int socketTimeoutMillis;

    public ClawBotLocalIpcClient(
            ClawBotLocalIpcServer.Endpoint endpoint,
            String instanceId,
            long connectionEpoch
    ) {
        this(endpoint, instanceId, connectionEpoch, 5_000, 10_000);
    }

    ClawBotLocalIpcClient(
            ClawBotLocalIpcServer.Endpoint endpoint,
            String instanceId,
            long connectionEpoch,
            int connectTimeoutMillis,
            int socketTimeoutMillis
    ) {
        this.endpoint = endpoint;
        this.instanceId = requireValue(instanceId, "instanceId", ClawBotIpcEnvelope.MAX_IDENTIFIER_LENGTH);
        if (connectionEpoch < 0) {
            throw new IllegalArgumentException("Invalid connectionEpoch");
        }
        if (connectTimeoutMillis <= 0) {
            throw new IllegalArgumentException("Invalid connectTimeoutMillis");
        }
        if (socketTimeoutMillis <= 0) {
            throw new IllegalArgumentException("Invalid socketTimeoutMillis");
        }
        this.connectionEpoch = connectionEpoch;
        this.connectTimeoutMillis = connectTimeoutMillis;
        this.socketTimeoutMillis = socketTimeoutMillis;
    }

    /** Sends exactly one request on a newly authenticated loopback connection. */
    public ClawBotIpcEnvelope request(ClawBotIpcEnvelope request) throws IOException {
        if (request == null) {
            throw new NullPointerException("request");
        }
        InetAddress address = InetAddress.getByName(endpoint.host());
        if (!address.isLoopbackAddress()) {
            throw new IOException("CLAWBOT_IPC_NON_LOOPBACK_ENDPOINT");
        }
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(address, endpoint.port()), connectTimeoutMillis);
            socket.setSoTimeout(socketTimeoutMillis);
            ClawBotIpcFrameCodec.write(socket.getOutputStream(), createHello(),
                    ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES);
            JsonObject welcome = ClawBotIpcFrameCodec.read(socket.getInputStream(),
                    ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES);
            validateWelcome(welcome);
            ClawBotIpcFrameCodec.write(socket.getOutputStream(), request.toJson(),
                    ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES);
            JsonObject response = ClawBotIpcFrameCodec.read(socket.getInputStream(),
                    ClawBotIpcFrameCodec.DEFAULT_MAX_FRAME_BYTES);
            if ("GATEWAY_REJECTED".equals(readString(response, "type"))) {
                throw new IOException(readString(response, "code"));
            }
            try {
                return ClawBotIpcEnvelope.fromJson(response);
            } catch (IllegalArgumentException error) {
                throw new IOException("CLAWBOT_IPC_ENVELOPE_INVALID", error);
            }
        }
    }

    private JsonObject createHello() {
        JsonObject hello = new JsonObject();
        hello.addProperty("protocolVersion", endpoint.protocolVersion());
        hello.addProperty("type", "GATEWAY_HELLO");
        hello.addProperty("requestId", UUID.randomUUID().toString());
        hello.addProperty("clientInstanceId", instanceId);
        hello.addProperty("clientConnectionEpoch", connectionEpoch);
        hello.addProperty("authToken", endpoint.authToken());
        return hello;
    }

    private static void validateWelcome(JsonObject welcome) throws IOException {
        int protocolVersion = readInt(welcome, "protocolVersion");
        if (protocolVersion != ClawBotLocalIpcServer.PROTOCOL_VERSION) {
            throw new IOException("CLAWBOT_IPC_PROTOCOL_UNSUPPORTED");
        }
        String type = readString(welcome, "type");
        if ("GATEWAY_REJECTED".equals(type)) {
            throw new IOException(readString(welcome, "code"));
        }
        if (!"GATEWAY_WELCOME".equals(type)) {
            throw new IOException("CLAWBOT_IPC_HANDSHAKE_INVALID");
        }
        readString(welcome, "requestId");
        readString(welcome, "instanceId");
        readLong(welcome, "connectionEpoch");
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
}
