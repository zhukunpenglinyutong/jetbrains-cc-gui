package com.github.claudecodegui.clawbot;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.EnumSet;
import java.util.Set;
import java.nio.file.attribute.PosixFilePermission;

/** Stores the loopback IPC secret separately from non-sensitive leader metadata. */
final class ClawBotIpcSecretStore {

    private static final String SECRET_FILE = "gateway.auth";
    private static final long MAX_SECRET_BYTES = 512L;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Path runtimeDirectory;

    ClawBotIpcSecretStore(Path runtimeDirectory) {
        this.runtimeDirectory = runtimeDirectory.toAbsolutePath().normalize();
    }

    String loadOrCreate() throws IOException {
        prepareDirectory();
        Path path = secretPath();
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return read();
        }
        String token = createToken();
        Path temporary = Files.createTempFile(runtimeDirectory, ".gateway-auth-", ".tmp");
        try {
            Files.writeString(temporary, token, StandardCharsets.UTF_8);
            restrictPermissions(temporary);
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
            return token;
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    String read() throws IOException {
        Path path = secretPath();
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                || Files.size(path) > MAX_SECRET_BYTES) {
            throw new IOException("CLAWBOT_IPC_SECRET_UNAVAILABLE");
        }
        String token = Files.readString(path, StandardCharsets.UTF_8).trim();
        if (token.isBlank() || token.length() > 256 || token.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_IPC_SECRET_INVALID");
        }
        return token;
    }

    private void prepareDirectory() throws IOException {
        Path parent = runtimeDirectory.getParent();
        if (parent == null) {
            throw new IOException("CLAWBOT_RUNTIME_UNAVAILABLE");
        }
        Files.createDirectories(parent);
        if (Files.isSymbolicLink(parent) || Files.isSymbolicLink(runtimeDirectory)) {
            throw new IOException("CLAWBOT_RUNTIME_UNAVAILABLE");
        }
        Files.createDirectories(runtimeDirectory);
        if (!Files.isDirectory(runtimeDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("CLAWBOT_RUNTIME_UNAVAILABLE");
        }
    }

    private Path secretPath() {
        return runtimeDirectory.resolve(SECRET_FILE);
    }

    private static String createToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static void restrictPermissions(Path path) throws IOException {
        try {
            Set<PosixFilePermission> permissions = EnumSet.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE);
            Files.setPosixFilePermissions(path, permissions);
        } catch (UnsupportedOperationException ignored) {
            // Windows ACLs are inherited from the per-user runtime directory.
        }
    }
}
