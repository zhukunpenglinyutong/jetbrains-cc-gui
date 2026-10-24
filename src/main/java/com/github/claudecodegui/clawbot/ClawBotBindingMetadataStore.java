package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.util.PropertiesComponent;

import java.util.Objects;
import java.util.Optional;

final class ClawBotBindingMetadataStore {

    private static final String METADATA_KEY = "ccgui.clawbot.binding.metadata";
    private static final int MAX_BASE_URL_LENGTH = 2048;

    private final MetadataBackend backend;

    ClawBotBindingMetadataStore() {
        this(new PropertiesMetadataBackend());
    }

    ClawBotBindingMetadataStore(MetadataBackend backend) {
        this.backend = Objects.requireNonNull(backend, "backend");
    }

    Optional<BindingMetadata> load() {
        return Optional.ofNullable(readState().metadata());
    }

    ReadResult readState() {
        String raw = backend.read(METADATA_KEY);
        if (raw == null) {
            return new ReadResult(false, true, null);
        }
        if (raw.isBlank()) {
            return new ReadResult(true, false, null);
        }
        try {
            JsonElement element = JsonParser.parseString(raw);
            if (!element.isJsonObject()) {
                return new ReadResult(true, false, null);
            }
            JsonObject object = element.getAsJsonObject();
            String state = readString(object, "state");
            String baseUrl = object.has("baseUrl") && !object.get("baseUrl").isJsonNull()
                    ? readString(object, "baseUrl") : null;
            JsonElement revision = object.get("revision");
            if (revision == null || !revision.isJsonPrimitive() || !revision.getAsJsonPrimitive().isNumber()) {
                return new ReadResult(true, false, null);
            }
            return new ReadResult(true, true, new BindingMetadata(state, baseUrl, revision.getAsLong()));
        } catch (RuntimeException ignored) {
            return new ReadResult(true, false, null);
        }
    }

    void save(BindingMetadata metadata) {
        Objects.requireNonNull(metadata, "metadata");
        JsonObject object = new JsonObject();
        object.addProperty("state", metadata.state());
        if (metadata.baseUrl() != null) {
            object.addProperty("baseUrl", metadata.baseUrl());
        }
        object.addProperty("revision", metadata.revision());
        backend.write(METADATA_KEY, object.toString());
    }

    interface MetadataBackend {

        String read(String key);

        void write(String key, String value);
    }

    record BindingMetadata(String state, String baseUrl, long revision) {

        BindingMetadata {
            Objects.requireNonNull(state, "state");
            if (!"BOUND".equals(state) && !"UNBOUND".equals(state)) {
                throw new IllegalArgumentException("Invalid binding state");
            }
            if (revision < 0L) {
                throw new IllegalArgumentException("revision must not be negative");
            }
            if ("BOUND".equals(state)) {
                if (baseUrl == null || baseUrl.isBlank()) {
                    throw new IllegalArgumentException("BOUND metadata requires a base URL");
                }
                if (baseUrl.length() > MAX_BASE_URL_LENGTH
                        || baseUrl.chars().anyMatch(Character::isISOControl)) {
                    throw new IllegalArgumentException("Invalid binding base URL");
                }
            } else if (baseUrl != null) {
                throw new IllegalArgumentException("UNBOUND metadata cannot have a base URL");
            }
        }
    }

    record ReadResult(boolean present, boolean valid, BindingMetadata metadata) {
    }

    private static String readString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                || value.getAsString().isBlank()) {
            throw new IllegalArgumentException("Invalid binding metadata " + name);
        }
        return value.getAsString();
    }

    private static final class PropertiesMetadataBackend implements MetadataBackend {

        @Override
        public String read(String key) {
            return PropertiesComponent.getInstance().getValue(key);
        }

        @Override
        public void write(String key, String value) {
            PropertiesComponent.getInstance().setValue(key, value);
        }
    }
}
