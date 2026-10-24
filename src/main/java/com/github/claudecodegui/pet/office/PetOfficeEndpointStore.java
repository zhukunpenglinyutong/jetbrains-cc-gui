package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.UserPrincipal;
import java.util.EnumSet;
import java.util.List;

/** Current-user endpoint metadata, separate from ClawBot and relocatable AI data. */
final class PetOfficeEndpointStore {
    static final int VERSION = 3;
    private static final String FILE = "coordinator-v1.json";
    private final Path directory;

    record Endpoint(int port, String leaderEpoch, String token, String ownerInstanceId) {
        @Override
        public String toString() {
            return "PetOfficeEndpoint[port=" + port + ", protocolVersion=" + VERSION + "]";
        }
    }

    PetOfficeEndpointStore(Path directory) {
        this.directory = directory.toAbsolutePath().normalize();
    }

    Endpoint read() throws IOException {
        JsonObject value = readPrivate(FILE);
        return value == null ? null : decode(value);
    }

    void publish(Endpoint endpoint, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            publishOwned(endpoint, lease);
        }
    }

    /** Serialize the small endpoint mutation with lease release, so an old writer cannot cross ownership. */
    private void publishOwned(Endpoint endpoint, PetOfficeRuntimeLease lease) throws IOException {
        writePrivate(FILE, encode(endpoint), lease);
    }

    JsonObject readPrivate(String name) throws IOException {
        byte[] bytes = readBytes(name);
        return bytes == null ? null : PetOfficeIpcFrameCodec.parse(bytes);
    }

    byte[] readBytes(String name) throws IOException {
        UserPrincipal owner = validateDirectory();
        Path file = privatePath(name);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            return null;
        }
        validateFile(file, owner);
        try (InputStream input = Files.newInputStream(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            byte[] bytes = input.readNBytes(limit(name) + 1);
            if (bytes.length > limit(name)) {
                throw new IOException("OFFICE_ENDPOINT_INVALID");
            }
            return bytes;
        }
    }

    long byteLength(String name) throws IOException {
        UserPrincipal owner = validateDirectory();
        Path file = privatePath(name);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            return 0;
        }
        validateFile(file, owner);
        long length = Files.size(file);
        if (length > limit(name)) {
            throw new IOException("OFFICE_ENDPOINT_INVALID");
        }
        return length;
    }

    void removeBytes(String name, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            if (!lease.isValid()) {
                throw new IOException("OFFICE_LEADER_LOST");
            }
            UserPrincipal owner = validateDirectory();
            Path file = privatePath(name);
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                validateFile(file, owner);
                Files.delete(file);
            }
        }
    }

    void writePrivate(String name, JsonObject value, PetOfficeRuntimeLease lease) throws IOException {
        writeBytes(name, value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8), lease);
    }

    void writeBytes(String name, byte[] bytes, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            writePrivateOwned(name, bytes, lease);
        }
    }

    void writeMember(String id, JsonObject value) throws IOException {
        writePrivateOwned(memberName(id), value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8), null);
    }

    void removeMember(String id) throws IOException {
        UserPrincipal owner = validateDirectory();
        Path file = privatePath(memberName(id));
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            validateFile(file, owner);
            Files.delete(file);
        }
    }

    List<String> members() throws IOException {
        validateDirectory();
        List<String> result = new java.util.ArrayList<>();
        try (var files = Files.newDirectoryStream(directory, "overlay-*.json")) {
            for (Path file : files) {
                if (result.size() >= 64) {
                    throw new IOException("OFFICE_PARTICIPANT_CAPACITY");
                }
                String name = file.getFileName().toString();
                privatePath(name);
                result.add(name.substring(8, name.length() - 5));
            }
        }
        return List.copyOf(result);
    }

    static String memberName(String id) throws IOException {
        try {
            if (!java.util.UUID.fromString(id).toString().equals(id)) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException invalid) {
            throw new IOException("OFFICE_PARTICIPANT_INVALID");
        }
        return "overlay-" + id + ".json";
    }

    private void writePrivateOwned(String name, byte[] bytes, PetOfficeRuntimeLease lease) throws IOException {
        if (lease != null && !lease.isValid()) {
            throw new IOException("OFFICE_LEADER_LOST");
        }
        UserPrincipal owner = validateDirectory();
        Path file = privatePath(name);
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            validateFile(file, owner);
        }
        Path temporary = Files.createTempFile(directory, "coordinator-", ".json");
        try {
            // Only a newly created file may have its owner adjusted for an elevated Windows token.
            Files.setOwner(temporary, owner);
            AclFileAttributeView acl = Files.getFileAttributeView(temporary, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
            if (acl == null) {
                throw new IOException("OFFICE_RUNTIME_ACL_UNAVAILABLE");
            }
            acl.setAcl(List.of(AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(owner)
                    .setPermissions(EnumSet.allOf(AclEntryPermission.class)).build()));
            if (bytes.length == 0 || bytes.length > limit(name)) {
                throw new IOException("OFFICE_ENDPOINT_INVALID");
            }
            Files.write(temporary, bytes, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING, LinkOption.NOFOLLOW_LINKS);
            if (lease != null && !lease.isValid()) {
                throw new IOException("OFFICE_LEADER_LOST");
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private Path privatePath(String name) throws IOException {
        if (!FILE.equals(name) && !PetOfficeRecoveryStore.FILE.equals(name) && !PetOfficeModeStore.FILE.equals(name)
                && !PetOfficePreferencesStore.FILE.equals(name) && !PetOfficePreferencesStore.BACKUP.equals(name)
                && !name.matches("overlay-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json")
                && !backgroundName(name)) {
            throw new IOException("OFFICE_ENDPOINT_INVALID");
        }
        return directory.resolve(name);
    }

    private static boolean backgroundName(String name) {
        return name.matches("background-(0|[1-9][0-9]?)\\.bin")
                && Integer.parseInt(name.substring(11, name.length() - 4)) < PetOfficeSessionRegistry.MAX_FLOORS;
    }

    private int limit(String name) throws IOException {
        privatePath(name);
        if (name.equals(PetOfficePreferencesStore.FILE) || name.equals(PetOfficePreferencesStore.BACKUP)) {
            return PetOfficeIpcFrameCodec.MAX_FRAME_BYTES;
        }
        return name.startsWith("background-") ? PetOfficeAppearanceService.MAX_IMAGE_BYTES
                : name.equals(PetOfficeModeStore.FILE) ? 8192 : 1024;
    }

    void removeOwned(Endpoint endpoint, PetOfficeRuntimeLease lease) throws IOException {
        synchronized (lease) {
            if (lease.isValid()) {
                Endpoint current = read();
                if (current != null && current.leaderEpoch().equals(endpoint.leaderEpoch())) {
                    Files.deleteIfExists(directory.resolve(FILE));
                }
            }
        }
    }

    private UserPrincipal validateDirectory() throws IOException {
        for (Path path = directory; path != null; path = path.getParent()) {
            BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isDirectory() || attributes.isSymbolicLink() || attributes.isOther()) {
                throw new IOException("OFFICE_RUNTIME_PATH_UNSAFE");
            }
        }
        UserPrincipal owner = Files.getOwner(directory, LinkOption.NOFOLLOW_LINKS);
        validateAcl(directory, owner);
        return owner;
    }

    private static void validateFile(Path file, UserPrincipal owner) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isRegularFile() || attributes.isSymbolicLink() || attributes.isOther()
                || !Files.getOwner(file, LinkOption.NOFOLLOW_LINKS).equals(owner)) {
            throw new IOException("OFFICE_ENDPOINT_UNSAFE");
        }
        validateAcl(file, owner);
    }

    private static void validateAcl(Path path, UserPrincipal owner) throws IOException {
        AclFileAttributeView view = Files.getFileAttributeView(path, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (view == null) {
            throw new IOException("OFFICE_RUNTIME_ACL_UNAVAILABLE");
        }
        List<AclEntry> entries = view.getAcl();
        if (entries.stream().anyMatch(entry -> entry.type() == AclEntryType.ALLOW && !entry.principal().equals(owner))
                || entries.stream().noneMatch(entry -> entry.type() == AclEntryType.ALLOW && entry.principal().equals(owner)
                && entry.permissions().contains(AclEntryPermission.READ_DATA))) {
            throw new IOException("OFFICE_ENDPOINT_ACL_UNSAFE");
        }
    }

    private static JsonObject encode(Endpoint value) throws IOException {
        JsonObject result = new JsonObject();
        result.addProperty("schemaVersion", VERSION);
        result.addProperty("port", value.port());
        result.addProperty("leaderEpoch", value.leaderEpoch());
        result.addProperty("token", value.token());
        result.addProperty("ownerInstanceId", value.ownerInstanceId());
        decode(result);
        return result;
    }

    private static Endpoint decode(JsonObject value) throws IOException {
        PetOfficeIpcFrameCodec.fields(value, "schemaVersion", "port", "leaderEpoch", "token", "ownerInstanceId");
        if (PetOfficeIpcFrameCodec.integer(value, "schemaVersion", VERSION) != VERSION) {
            throw new IOException("OFFICE_PROTOCOL_UNSUPPORTED");
        }
        int port = (int) PetOfficeIpcFrameCodec.integer(value, "port", 65535);
        String epoch = PetOfficeIpcFrameCodec.identifier(value, "leaderEpoch", false);
        String token = PetOfficeIpcFrameCodec.string(value, "token", 64);
        if (port == 0 || !token.matches("[a-f0-9]{64}")) {
            throw new IOException("OFFICE_ENDPOINT_INVALID");
        }
        return new Endpoint(port, epoch, token, PetOfficeIpcFrameCodec.identifier(value, "ownerInstanceId", false));
    }
}
