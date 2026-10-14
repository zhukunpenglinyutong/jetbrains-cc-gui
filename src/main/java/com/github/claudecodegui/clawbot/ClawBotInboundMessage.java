package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Objects;

/** A bounded, normalized inbound message received from the external channel. */
public record ClawBotInboundMessage(
        String messageId,
        String fromUserId,
        String contextToken,
        String text,
        ClawBotInboundAction action,
        ClawBotSessionTarget target,
        long routeRevision,
        String interactionToken
) {

    static final int MAX_MESSAGE_ID_LENGTH = 512;
    static final int MAX_USER_ID_LENGTH = 512;
    static final int MAX_CONTEXT_TOKEN_LENGTH = 16 * 1024;
    static final int MAX_TEXT_LENGTH = 64 * 1024;

    public ClawBotInboundMessage {
        messageId = requireBounded(messageId, "messageId", MAX_MESSAGE_ID_LENGTH);
        fromUserId = requireBounded(fromUserId, "fromUserId", MAX_USER_ID_LENGTH);
        contextToken = requireBounded(contextToken, "contextToken", MAX_CONTEXT_TOKEN_LENGTH);
        action = Objects.requireNonNull(action, "action");
        interactionToken = interactionToken == null ? "" : interactionToken;
        if (!interactionToken.isEmpty()) {
            requireBounded(interactionToken, "interactionToken", 256);
        }
        text = action == ClawBotInboundAction.UNSUPPORTED_MEDIA ? requireOptionalText(text) : requireText(text);
        if (routeRevision < 0) {
            throw new IllegalArgumentException("Invalid route revision");
        }
    }

    public ClawBotInboundMessage(String messageId, String fromUserId, String contextToken, String text,
                                 ClawBotInboundAction action, ClawBotSessionTarget target, long routeRevision) {
        this(messageId, fromUserId, contextToken, text, action, target, routeRevision, "");
    }

    ClawBotInboundMessage forInteraction(String token) {
        return new ClawBotInboundMessage(messageId, fromUserId, contextToken, text, ClawBotInboundAction.ANSWER, target, routeRevision, token);
    }

    public ClawBotInboundMessage(String messageId, String fromUserId, String contextToken, String text) {
        this(messageId, fromUserId, contextToken, text, ClawBotInboundAction.MESSAGE);
    }

    public ClawBotInboundMessage(String messageId, String fromUserId, String contextToken, String text, ClawBotInboundAction action) {
        this(messageId, fromUserId, contextToken, text, action, null, 0);
    }

    ClawBotInboundMessage forTarget(ClawBotSessionSnapshot session) {
        return new ClawBotInboundMessage(messageId, fromUserId, contextToken, text, action, ClawBotSessionTarget.of(session), routeRevision, interactionToken);
    }

    ClawBotInboundMessage forRoute(long revision) {
        return new ClawBotInboundMessage(messageId, fromUserId, contextToken, text, action, target, revision, interactionToken);
    }

    static ClawBotInboundMessage command(ClawBotInboundMessage source, ClawBotInboundAction action) {
        Objects.requireNonNull(source, "source");
        if (action == null || action == ClawBotInboundAction.MESSAGE
                || action == ClawBotInboundAction.UNSUPPORTED_MEDIA) {
            throw new IllegalArgumentException("Invalid inbound action");
        }
        return new ClawBotInboundMessage(
                source.messageId(), source.fromUserId(), source.contextToken(), source.text(), action);
    }

    JsonObject toJson() {
        JsonObject result = new JsonObject();
        result.addProperty("messageId", messageId);
        result.addProperty("fromUserId", fromUserId);
        result.addProperty("contextToken", contextToken);
        result.addProperty("text", text);
        result.addProperty("interactionToken", interactionToken);
        if (action != ClawBotInboundAction.MESSAGE) {
            result.addProperty("action", action.name());
        }
        if (target != null) {
            result.add("target", target.toJson());
            result.addProperty("routeRevision", routeRevision);
        }
        return result;
    }

    static ClawBotInboundMessage fromJson(JsonObject object) {
        if (object == null) {
            throw new IllegalArgumentException("Invalid inbound message");
        }
        try {
            JsonElement targetElement = object.get("target");
            if (targetElement != null && !targetElement.isJsonObject()) {
                throw new IllegalArgumentException("Invalid target");
            }
            long revision = object.has("routeRevision") ? object.get("routeRevision").getAsLong() : 0;
            return new ClawBotInboundMessage(
                    readString(object, "messageId"),
                    readString(object, "fromUserId"),
                    readString(object, "contextToken"),
                    readString(object, "text"),
                    readAction(object),
                    targetElement == null ? null : ClawBotSessionTarget.fromJson(targetElement.getAsJsonObject()),
                    revision, object.has("interactionToken") ? readString(object, "interactionToken") : "");
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Invalid inbound message", error);
        }
    }

    private static ClawBotInboundAction readAction(JsonObject object) {
        JsonElement value = object.get("action");
        if (value == null || value.isJsonNull()) {
            return ClawBotInboundAction.MESSAGE;
        }
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("Invalid action");
        }
        try {
            return ClawBotInboundAction.valueOf(value.getAsString());
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Invalid action", error);
        }
    }

    private static String readString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("Invalid " + name);
        }
        return value.getAsString();
    }

    private static String requireBounded(String value, String name, int maxLength) {
        if (value == null || value.isEmpty() || value.length() > maxLength
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid " + name);
        }
        return value;
    }

    private static String requireText(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_TEXT_LENGTH
                || value.chars().anyMatch(character -> character < 0x20
                && character != '\t' && character != '\n' && character != '\r' || character == 0x7F)) {
            throw new IllegalArgumentException("Invalid text");
        }
        return value;
    }

    private static String requireOptionalText(String value) {
        return value != null && value.isEmpty() ? value : requireText(value);
    }
}
