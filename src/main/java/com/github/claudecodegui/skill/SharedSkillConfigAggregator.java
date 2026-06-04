package com.github.claudecodegui.skill;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Read-only aggregator for plugin-managed skill metadata and runtime-specific projections.
 */
public final class SharedSkillConfigAggregator {

    private SharedSkillConfigAggregator() {
    }

    public static JsonObject aggregate(
            List<JsonObject> sharedSkills,
            JsonObject claudeProjection,
            JsonObject codexProjection) {
        JsonObject result = new JsonObject();
        JsonObject shared = new JsonObject();
        JsonObject projections = new JsonObject();
        JsonObject skills = new JsonObject();
        Map<String, String> sharedNameIndex = new LinkedHashMap<>();

        projections.add("claude", claudeProjection != null ? claudeProjection.deepCopy() : new JsonObject());
        projections.add("codex", codexProjection != null ? codexProjection.deepCopy() : new JsonObject());

        if (sharedSkills != null) {
            for (JsonObject source : sharedSkills) {
                if (source == null) {
                    continue;
                }
                String id = readString(source, "id");
                if (isBlank(id)) {
                    id = readString(source, "name");
                }
                if (isBlank(id)) {
                    id = basename(readString(source, "path"));
                }
                if (isBlank(id)) {
                    continue;
                }

                JsonObject normalized = source.deepCopy();
                normalized.addProperty("id", id);
                normalized.addProperty("source", "plugin");
                if (!normalized.has("enabled") || normalized.get("enabled").isJsonNull()) {
                    normalized.addProperty("enabled", true);
                }
                shared.add(id, normalized);
                String name = readString(normalized, "name");
                if (!isBlank(name)) {
                    sharedNameIndex.put(name, id);
                }

                JsonObject aggregate = baseAggregate(id, normalized, "plugin", true);
                aggregate.add("sharedConfig", normalized.deepCopy());
                skills.add(id, aggregate);
            }
        }

        mergeRuntimeProjection(skills, sharedNameIndex, "claude", claudeProjection);
        mergeRuntimeProjection(skills, sharedNameIndex, "codex", codexProjection);

        result.add("shared", shared);
        result.add("projections", projections);
        result.add("skills", skills);
        return result;
    }

    private static void mergeRuntimeProjection(
            JsonObject skills,
            Map<String, String> sharedNameIndex,
            String provider,
            JsonObject projection) {
        if (projection == null) {
            return;
        }

        for (String scope : projection.keySet()) {
            JsonElement bucketElement = projection.get(scope);
            if (bucketElement == null || !bucketElement.isJsonObject()) {
                continue;
            }
            JsonObject bucket = bucketElement.getAsJsonObject();
            for (String runtimeId : bucket.keySet()) {
                JsonElement skillElement = bucket.get(runtimeId);
                if (skillElement == null || !skillElement.isJsonObject()) {
                    continue;
                }
                JsonObject runtimeSkill = skillElement.getAsJsonObject();
                String name = readString(runtimeSkill, "name");
                if (isBlank(name)) {
                    name = basename(readString(runtimeSkill, "path"));
                }
                if (isBlank(name)) {
                    name = runtimeId;
                }

                String aggregateId = sharedNameIndex.get(name);
                if (isBlank(aggregateId)) {
                    aggregateId = provider + ":" + scope + ":" + name;
                }

                JsonObject aggregate;
                if (skills.has(aggregateId) && skills.get(aggregateId).isJsonObject()) {
                    aggregate = skills.getAsJsonObject(aggregateId);
                } else {
                    aggregate = baseAggregate(aggregateId, runtimeSkill, provider, false);
                    skills.add(aggregateId, aggregate);
                }

                boolean enabled = !runtimeSkill.has("enabled")
                        || runtimeSkill.get("enabled").isJsonNull()
                        || runtimeSkill.get("enabled").getAsBoolean();
                if (!aggregate.has("enabled") || aggregate.get("enabled").isJsonNull()) {
                    aggregate.addProperty("enabled", enabled);
                } else {
                    aggregate.addProperty("enabled", aggregate.get("enabled").getAsBoolean() || enabled);
                }

                JsonObject projectionEntry = runtimeSkill.deepCopy();
                projectionEntry.addProperty("provider", provider);
                projectionEntry.addProperty("scope", scope);
                projectionEntry.addProperty("runtimeId", runtimeId);
                aggregate.getAsJsonObject("projections").getAsJsonArray(provider).add(projectionEntry);
            }
        }
    }

    private static JsonObject baseAggregate(String id, JsonObject source, String sourceName, boolean shared) {
        JsonObject aggregate = new JsonObject();
        aggregate.addProperty("id", id);
        aggregate.addProperty("name", firstNonBlank(readString(source, "name"), basename(readString(source, "path")), id));
        String description = readString(source, "description");
        if (!isBlank(description)) {
            aggregate.addProperty("description", description);
        }
        String path = readString(source, "path");
        if (!isBlank(path)) {
            aggregate.addProperty("path", path);
        }
        aggregate.addProperty("enabled", !source.has("enabled")
                || source.get("enabled").isJsonNull()
                || source.get("enabled").getAsBoolean());
        aggregate.addProperty("shared", shared);
        aggregate.addProperty("source", sourceName);
        JsonObject projectionRefs = new JsonObject();
        projectionRefs.add("claude", new JsonArray());
        projectionRefs.add("codex", new JsonArray());
        aggregate.add("projections", projectionRefs);
        return aggregate;
    }

    private static String firstNonBlank(String first, String second, String fallback) {
        if (!isBlank(first)) {
            return first;
        }
        if (!isBlank(second)) {
            return second;
        }
        return fallback;
    }

    private static String basename(String path) {
        if (isBlank(path)) {
            return null;
        }
        return new File(path).getName();
    }

    private static String readString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }
}
