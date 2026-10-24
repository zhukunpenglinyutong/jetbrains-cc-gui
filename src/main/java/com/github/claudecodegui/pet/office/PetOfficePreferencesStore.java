package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** Desktop-session preferences survive renderer/IDE takeover; source Pet settings remain source-owned. */
final class PetOfficePreferencesStore {
    static final String FILE = "preferences-v1.json";
    static final String BACKUP = "preferences-v1.backup.json";
    private static final int LEGACY_MAX_FLOORS = 16;
    private static final Gson JSON = new Gson();
    private static final Set<String> THEMES = Set.of("loft", "cyberpunk", "cultivation", "space", "forest", "library", "ocean", "zen", "retro");
    record Presentation(boolean effects, boolean attention, boolean ambience, boolean depth) { }
    record Preferences(int limitMiB, List<String> floors, int floor, String product, String search,
                       boolean showIdle, boolean paused, boolean topmost, int zoom, Presentation presentation, Map<String, String> appearanceOverrides, String officeName) {
        Preferences(int limitMiB, List<String> floors, int floor, String product, String search,
                    boolean showIdle, boolean paused, boolean topmost, int zoom) {
            this(limitMiB, floors, floor, product, search, showIdle, paused, topmost, zoom, new Presentation(true, true, true, true));
        }
        Preferences(int limitMiB, List<String> floors, int floor, String product, String search,
                    boolean showIdle, boolean paused, boolean topmost, int zoom, Presentation presentation) {
            this(limitMiB, floors, floor, product, search, showIdle, paused, topmost, zoom, presentation, Map.of());
        }
        Preferences(int limitMiB, List<String> floors, int floor, String product, String search,
                    boolean showIdle, boolean paused, boolean topmost, int zoom, Presentation presentation, Map<String, String> appearanceOverrides) {
            this(limitMiB, floors, floor, product, search, showIdle, paused, topmost, zoom, presentation, appearanceOverrides, "");
        }
        Preferences {
            var normalized = new ArrayList<>(floors);
            if (normalized.size() == LEGACY_MAX_FLOORS) {
                while (normalized.size() < PetOfficeSessionRegistry.MAX_FLOORS) {
                    normalized.add("loft");
                }
            }
            floors = List.copyOf(normalized);
            appearanceOverrides = Map.copyOf(appearanceOverrides);
        }
    }
    record Bounds(int x, int y, int width, int height, boolean placed) { }
    record State(int schemaVersion, String revision, Preferences preferences, Bounds bounds) { }
    record Loaded(State state, boolean recovered) { }
    private final PetOfficeEndpointStore files;

    PetOfficePreferencesStore(java.nio.file.Path directory) { files = new PetOfficeEndpointStore(directory); }

    static State defaults() {
        return new State(1, "initial", new Preferences(50, Collections.nCopies(PetOfficeSessionRegistry.MAX_FLOORS, "loft"), 0, "all", "", false, false, true, 100),
                new Bounds(0, 0, 1240, 900, false));
    }

    Loaded read() throws IOException {
        try {
            JsonObject value = files.readPrivate(FILE);
            return new Loaded(value == null ? defaults() : decode(value), false);
        } catch (IOException | RuntimeException invalid) {
            JsonObject backup = files.readPrivate(BACKUP);
            if (backup == null) {
                throw new IOException("OFFICE_PREFERENCES_INVALID");
            }
            return new Loaded(decode(backup), true);
        }
    }

    State update(String expected, Preferences preferences, Bounds bounds, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            State current = read().state();
            if (!current.revision().equals(expected)) {
                throw new IOException("OFFICE_PREFERENCES_CONFLICT");
            }
            State next = new State(1, UUID.randomUUID().toString(), preferences == null ? current.preferences() : preferences,
                    bounds == null ? current.bounds() : bounds);
            decode(JSON.toJsonTree(next).getAsJsonObject());
            files.writePrivate(BACKUP, JSON.toJsonTree(current).getAsJsonObject(), lease);
            files.writePrivate(FILE, JSON.toJsonTree(next).getAsJsonObject(), lease);
            return next;
        }
    }

    static Preferences preferences(JsonObject value) throws IOException {
        value = value.deepCopy();
        if (!value.has("presentation")) {
            value.add("presentation", JSON.toJsonTree(new Presentation(true, true, true, true)));
        }
        if (!value.has("appearanceOverrides")) {
            value.add("appearanceOverrides", new JsonObject());
        }
        if (!value.has("officeName")) {
            value.addProperty("officeName", "");
        }
        fields(value, "limitMiB", "floors", "floor", "product", "search", "showIdle", "paused", "topmost", "zoom", "presentation", "appearanceOverrides", "officeName");
        string(value, "officeName", 64);
        if (!value.get("presentation").isJsonObject()) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
        JsonObject presentation = value.getAsJsonObject("presentation");
        fields(presentation, "effects", "attention", "ambience", "depth");
        for (String field : new String[]{"effects", "attention", "ambience", "depth"}) {
            if (!presentation.get(field).isJsonPrimitive() || !presentation.getAsJsonPrimitive(field).isBoolean()) {
                throw new IOException("OFFICE_PREFERENCES_INVALID");
            }
        }
        if (!value.get("appearanceOverrides").isJsonObject()) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
        var overrides = value.getAsJsonObject("appearanceOverrides");
        if (overrides.size() > PetOfficeSessionRegistry.MAX_SOURCES
                || JSON.toJson(overrides).getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 32000) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
        for (var entry : overrides.entrySet()) {
            String[] parts = entry.getKey().split("/", -1);
            if (parts.length != 3 || java.util.Arrays.stream(parts).anyMatch(part -> !part.matches("[A-Za-z0-9._-]{1,128}")
                    || ".".equals(part) || "..".equals(part)) || !entry.getValue().isJsonPrimitive()
                    || !entry.getValue().getAsJsonPrimitive().isString() || !PetOfficeAppearanceService.validPetId(entry.getValue().getAsString())) {
                throw new IOException("OFFICE_PREFERENCES_INVALID");
            }
        }
        long limit = integer(value, "limitMiB", 256);
        integer(value, "floor", PetOfficeSessionRegistry.MAX_FLOORS - 1);
        long zoom = integer(value, "zoom", 150);
        if (limit < 16 || zoom < 75) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
        string(value, "product", 160);
        string(value, "search", 160);
        for (String field : new String[]{"showIdle", "paused", "topmost"}) {
            if (!value.get(field).isJsonPrimitive() || !value.getAsJsonPrimitive(field).isBoolean()) {
                throw new IOException("OFFICE_PREFERENCES_INVALID");
            }
        }
        var floors = value.getAsJsonArray("floors");
        if (floors.size() != PetOfficeSessionRegistry.MAX_FLOORS && floors.size() != LEGACY_MAX_FLOORS) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
        for (var theme : floors) {
            if (!theme.isJsonPrimitive() || !theme.getAsJsonPrimitive().isString() || !THEMES.contains(theme.getAsString())) {
                throw new IOException("OFFICE_PREFERENCES_INVALID");
            }
        }
        return JSON.fromJson(value, Preferences.class);
    }

    private static State decode(JsonObject value) throws IOException {
        try {
            fields(value, "schemaVersion", "revision", "preferences", "bounds");
            if (integer(value, "schemaVersion", 1) != 1 || !string(value, "revision", 64).matches("initial|[a-f0-9-]{36}")) {
                throw new IOException("OFFICE_PREFERENCES_INVALID");
            }
            Preferences preferences = preferences(value.getAsJsonObject("preferences"));
            JsonObject bounds = value.getAsJsonObject("bounds");
            fields(bounds, "x", "y", "width", "height", "placed");
            signed(bounds, "x", -32768, 32768);
            signed(bounds, "y", -32768, 32768);
            signed(bounds, "width", 320, 7680);
            signed(bounds, "height", 320, 4320);
            if (!bounds.get("placed").isJsonPrimitive() || !bounds.getAsJsonPrimitive("placed").isBoolean()) {
                throw new IOException("OFFICE_PREFERENCES_INVALID");
            }
            return new State(1, string(value, "revision", 64), preferences, JSON.fromJson(bounds, Bounds.class));
        } catch (RuntimeException invalid) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
    }

    private static void signed(JsonObject value, String field, int min, int max) throws IOException {
        var raw = value.get(field);
        if (!raw.isJsonPrimitive() || !raw.getAsJsonPrimitive().isNumber() || !raw.getAsString().matches("-?[0-9]{1,6}")) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
        int number = raw.getAsInt();
        if (number < min || number > max) {
            throw new IOException("OFFICE_PREFERENCES_INVALID");
        }
    }
}
