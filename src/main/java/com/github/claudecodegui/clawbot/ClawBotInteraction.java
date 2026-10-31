package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;

/** Immutable dialog snapshot. The token remains internal to the IDE and gateway. */
public record ClawBotInteraction(String token, Kind kind, JsonObject data, long sequence, long deadlineMs) {
    public enum Kind { QUESTION, PERMISSION, PLAN }

    public ClawBotInteraction {
        data = data.deepCopy();
    }

    @Override
    public JsonObject data() {
        return data.deepCopy();
    }
}
