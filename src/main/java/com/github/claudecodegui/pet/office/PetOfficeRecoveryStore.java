package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.file.Path;
import java.util.UUID;

/** Opt-in recovery intent, not a display-mode or shared scene-preference record. Only the lease owner writes it. */
final class PetOfficeRecoveryStore {
    static final String FILE = "recovery-v1.json";
    private final PetOfficeEndpointStore files;

    record Intent(String revision, String leaderEpoch, boolean enabled, boolean visible) { }

    PetOfficeRecoveryStore(Path directory) {
        files = new PetOfficeEndpointStore(directory);
    }

    Intent read() throws IOException {
        JsonObject value = files.readPrivate(FILE);
        if (value == null) {
            return null;
        }
        PetOfficeIpcFrameCodec.fields(value, "schemaVersion", "revision", "leaderEpoch", "enabled", "visible");
        if (PetOfficeIpcFrameCodec.integer(value, "schemaVersion", 1) != 1 || !booleanField(value, "enabled") && booleanField(value, "visible")) {
            throw new IOException("OFFICE_RECOVERY_INVALID");
        }
        return new Intent(PetOfficeIpcFrameCodec.identifier(value, "revision", false), PetOfficeIpcFrameCodec.identifier(value, "leaderEpoch", false),
                booleanField(value, "enabled"), booleanField(value, "visible"));
    }

    Intent write(String leaderEpoch, boolean enabled, boolean visible, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            // Unknown/corrupt records are never silently replaced, including on explicit Open Office.
            Intent old = read();
            if (old != null && !old.leaderEpoch().equals(leaderEpoch)) {
                throw new IOException("OFFICE_RECOVERY_STALE");
            }
            return replace(leaderEpoch, enabled, visible, lease);
        }
    }

    Intent adopt(String leaderEpoch, Intent expected, boolean explicit, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            Intent current = read();
            if (!java.util.Objects.equals(current, expected) || !explicit && (current == null || !current.enabled())) {
                throw new IOException("OFFICE_RECOVERY_STALE");
            }
            return replace(leaderEpoch, true, explicit || current.visible(), lease);
        }
    }

    /** Explicit administrative exit holds the same free OS lock, without publishing a renderer endpoint. */
    void disable(PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            read();
            replace(UUID.randomUUID().toString(), false, false, lease);
        }
    }

    private Intent replace(String leaderEpoch, boolean enabled, boolean visible, PetOfficeRuntimeLease lease) throws IOException {
        if (!enabled && visible) {
            throw new IOException("OFFICE_RECOVERY_INVALID");
        }
        Intent intent = new Intent(UUID.randomUUID().toString(), leaderEpoch, enabled, visible);
        JsonObject value = new JsonObject();
        value.addProperty("schemaVersion", 1);
        value.addProperty("revision", intent.revision());
        value.addProperty("leaderEpoch", leaderEpoch);
        value.addProperty("enabled", enabled);
        value.addProperty("visible", visible);
        files.writePrivate(FILE, value, lease);
        return intent;
    }

    private static boolean booleanField(JsonObject value, String name) throws IOException {
        if (!value.has(name) || !value.get(name).isJsonPrimitive() || !value.getAsJsonPrimitive(name).isBoolean()) {
            throw new IOException("OFFICE_RECOVERY_INVALID");
        }
        return value.get(name).getAsBoolean();
    }
}
