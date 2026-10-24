package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.identifier;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** Durable display fencing, on the same desktop namespace/OS lease as Office ownership. */
final class PetOfficeModeStore {
    static final String FILE = "control-v1.json";
    private static final Gson JSON = new Gson();
    enum Mode { IDE_OVERLAY, ENTERING_OFFICE, OFFICE, EXITING_OFFICE }
    record Member(String id, long pid, long startedAt, String acknowledgedEpoch) { }
    record Control(int schemaVersion, String epoch, String leaderEpoch, Mode mode, List<Member> participants) {
        Control { participants = List.copyOf(participants); }
    }
    private final PetOfficeEndpointStore files;

    PetOfficeModeStore(java.nio.file.Path directory) { files = new PetOfficeEndpointStore(directory); }

    Control read() throws IOException {
        JsonObject value = files.readPrivate(FILE);
        if (value == null) {
            return new Control(1, "initial", "initial", Mode.IDE_OVERLAY, List.of());
        }
        try {
            fields(value, "schemaVersion", "epoch", "leaderEpoch", "mode", "participants");
            if (integer(value, "schemaVersion", 1) != 1) {
                throw new IOException("OFFICE_MODE_INVALID");
            }
            identifier(value, "epoch", false);
            identifier(value, "leaderEpoch", false);
            Mode.valueOf(string(value, "mode", 32));
            var members = value.getAsJsonArray("participants");
            if (members.size() > PetOfficeParticipantRegistry.MAX_PARTICIPANTS) {
                throw new IOException("OFFICE_PARTICIPANT_CAPACITY");
            }
            java.util.Set<String> seen = new java.util.HashSet<>();
            for (var raw : members) {
                Member member = member(raw.getAsJsonObject());
                if (!seen.add(member.id())) {
                    throw new IOException("OFFICE_MODE_INVALID");
                }
            }
            return JSON.fromJson(value, Control.class);
        } catch (RuntimeException invalid) {
            throw new IOException("OFFICE_MODE_INVALID");
        }
    }

    void register(Member member) throws IOException {
        member(JSON.toJsonTree(member).getAsJsonObject());
        if (files.byteLength(PetOfficeEndpointStore.memberName(member.id())) == 0) {
            int live = 0;
            for (String id : files.members()) {
                JsonObject raw = files.readPrivate(PetOfficeEndpointStore.memberName(id));
                if (raw == null) {
                    continue;
                }
                Member previous = member(raw);
                if (dead(previous)) {
                    files.removeMember(id);
                } else if (!previous.acknowledgedEpoch().equals("retired")) {
                    live++;
                }
            }
            if (live >= PetOfficeParticipantRegistry.MAX_PARTICIPANTS) {
                throw new IOException("OFFICE_PARTICIPANT_CAPACITY");
            }
        }
        files.writeMember(member.id(), JSON.toJsonTree(member).getAsJsonObject());
    }

    void unregister(Member member) throws IOException { files.removeMember(member.id()); }

    /** Keep proof for an in-flight entry snapshot after this live process has detached every overlay. */
    void retire(Member member) throws IOException {
        register(new Member(member.id(), member.pid(), member.startedAt(), "retired"));
    }

    Control beginEnter(String leader, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            read();
            Control entering = new Control(1, UUID.randomUUID().toString(), leader, Mode.ENTERING_OFFICE, List.of());
            write(entering, lease);
            // Publish the fence before collecting members. Every overlay permission is issued after its marker exists.
            List<Member> members = new ArrayList<>();
            for (String id : files.members()) {
                var raw = files.readPrivate(PetOfficeEndpointStore.memberName(id));
                if (raw == null) {
                    throw new IOException("OFFICE_MODE_UNRESOLVED");
                }
                Member member = member(raw);
                if (!member.id().equals(id)) {
                    throw new IOException("OFFICE_MODE_INVALID");
                }
                if (dead(member)) {
                    files.removeMember(id);
                } else if (!member.acknowledgedEpoch().equals("retired")) {
                    members.add(member);
                }
            }
            if (members.size() > PetOfficeParticipantRegistry.MAX_PARTICIPANTS) {
                throw new IOException("OFFICE_PARTICIPANT_CAPACITY");
            }
            entering = new Control(1, entering.epoch(), leader, Mode.ENTERING_OFFICE, members);
            write(entering, lease);
            return entering;
        }
    }

    boolean commitOffice(Control expected, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            Control current = read();
            if (!current.equals(expected)) {
                throw new IOException("OFFICE_MODE_STALE");
            }
            for (Member member : expected.participants()) {
                if (dead(member)) {
                    continue;
                }
                JsonObject value = files.readPrivate(PetOfficeEndpointStore.memberName(member.id()));
                if (value == null) {
                    return false;
                }
                Member observed = member(value);
                if (!observed.id().equals(member.id()) || observed.pid() != member.pid() || observed.startedAt() != member.startedAt()
                        || !observed.acknowledgedEpoch().equals(expected.epoch()) && !observed.acknowledgedEpoch().equals("retired")) {
                    return false;
                }
            }
            write(new Control(1, expected.epoch(), expected.leaderEpoch(), Mode.OFFICE, expected.participants()), lease);
            return true;
        }
    }

    void beginExit(String leader, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            Control current = read();
            if (!current.leaderEpoch().equals(leader)) {
                throw new IOException("OFFICE_MODE_STALE");
            }
            write(new Control(1, UUID.randomUUID().toString(), leader, Mode.EXITING_OFFICE, current.participants()), lease);
        }
    }

    /** Only called after window/browser disposal or by an administrative holder of the same free OS lock. */
    void commitOverlay(PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            read();
            write(new Control(1, UUID.randomUUID().toString(), "initial", Mode.IDE_OVERLAY, List.of()), lease);
        }
    }

    private void write(Control value, PetOfficeRuntimeLease lease) throws IOException {
        files.writePrivate(FILE, JSON.toJsonTree(value).getAsJsonObject(), lease);
    }

    private static Member member(JsonObject value) throws IOException {
        fields(value, "id", "pid", "startedAt", "acknowledgedEpoch");
        String id = identifier(value, "id", false);
        PetOfficeEndpointStore.memberName(id);
        long pid = integer(value, "pid", 9_007_199_254_740_991L);
        long started = integer(value, "startedAt", 9_007_199_254_740_991L);
        String epoch = identifier(value, "acknowledgedEpoch", true);
        if (pid == 0 || started == 0) {
            throw new IOException("OFFICE_MODE_INVALID");
        }
        return new Member(id, pid, started, epoch);
    }

    private static boolean dead(Member member) {
        var process = ProcessHandle.of(member.pid());
        return process.isEmpty() || !process.get().isAlive() || process.get().info().startInstant()
                .map(start -> start.toEpochMilli() != member.startedAt()).orElse(false);
    }
}
