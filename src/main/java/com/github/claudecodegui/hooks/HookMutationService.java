package com.github.claudecodegui.hooks;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import org.tomlj.Toml;
import org.tomlj.TomlParseResult;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.DosFileAttributeView;
import java.nio.file.attribute.DosFileAttributes;
import java.nio.file.attribute.FileOwnerAttributeView;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFileAttributes;
import java.util.EnumSet;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** Safe source-level read/write operations for supported hook sources. */
public final class HookMutationService {

    private static final Logger LOG = Logger.getInstance(HookMutationService.class);
    private static final long MAX_SOURCE_BYTES = 512L * 1024L;
    private static final Pattern SOURCE_CONTROL_CHARACTERS = Pattern.compile("[\\u0000\\u0008\\u000b\\u000c\\u000e-\\u001f]");

    private final HookPathPolicy pathPolicy;

    public HookMutationService(Path userHome) {
        this.pathPolicy = new HookPathPolicy(userHome.toAbsolutePath().normalize());
    }

    public JsonObject read(String projectRoot, String location) {
        try {
            Path project = normalizeProject(projectRoot);
            Path target = validateTarget(project, location);
            if (target == null) {
                return failure("INVALID_HOOK_PATH");
            }
            long size = Files.size(target);
            if (size > MAX_SOURCE_BYTES) {
                return failure("SOURCE_TOO_LARGE");
            }
            JsonObject result = success();
            result.addProperty("location", target.toString());
            result.addProperty("revision", revision(target));
            result.addProperty("lastModified", Files.getLastModifiedTime(target).toMillis());
            result.addProperty("backupDirectory", backupDirectory(target).toAbsolutePath().normalize().toString());
            result.addProperty("content", Files.readString(target, StandardCharsets.UTF_8));
            return result;
        } catch (IOException e) {
            LOG.debug("[HookMutation] Failed to read hook source", e);
            return failure("READ_FAILED");
        }
    }

    public JsonObject write(String projectRoot, String location, String expectedRevision, String content) {
        if (content == null || content.getBytes(StandardCharsets.UTF_8).length > MAX_SOURCE_BYTES) {
            return failure("SOURCE_TOO_LARGE");
        }
        if (SOURCE_CONTROL_CHARACTERS.matcher(content).find()) {
            return failure("CONTROL_CHARACTER_IN_SOURCE");
        }
        try {
            Path project = normalizeProject(projectRoot);
            Path target = validateTarget(project, location);
            if (target == null) {
                return failure("INVALID_HOOK_PATH");
            }
            String formatError = validateContent(target, project, content);
            if (formatError != null) {
                return failure(formatError);
            }
            Path lockDirectory = backupDirectory(target);
            Files.createDirectories(lockDirectory);
            Path lockPath = lockDirectory.resolve(".ccgui-hooks.lock");
            try (FileChannel channel = FileChannel.open(lockPath, StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE)) {
                FileLock lock;
                try {
                    lock = channel.tryLock();
                } catch (OverlappingFileLockException e) {
                    return failure("HOOK_FILE_LOCKED");
                }
                if (lock == null) {
                    return failure("HOOK_FILE_LOCKED");
                }
                try (FileLock ignored = lock) {
                    if (!revision(target).equals(expectedRevision)) {
                        return failure("HOOK_REVISION_CONFLICT");
                    }
                    Path backup = createBackup(target);
                    replaceAtomically(target, content);
                    JsonObject result = success();
                    result.addProperty("location", target.toString());
                    result.addProperty("revision", revision(target));
                    result.addProperty("backupPath", backup.toString());
                    result.addProperty("lastModified", Files.getLastModifiedTime(target).toMillis());
                    result.addProperty("content", content);
                    return result;
                }
            }
        } catch (IOException e) {
            LOG.warn("[HookMutation] Failed to write hook source", e);
            return failure("WRITE_FAILED");
        }
    }

    public JsonObject restore(String projectRoot, String location, String expectedRevision, String backupPath) {
        try {
            Path project = normalizeProject(projectRoot);
            Path target = validateTarget(project, location);
            Path backup = validateBackup(target, backupPath);
            if (target == null || backup == null || !Files.isRegularFile(backup)) {
                return failure("INVALID_BACKUP_PATH");
            }
            String content = Files.readString(backup, StandardCharsets.UTF_8);
            if (content.getBytes(StandardCharsets.UTF_8).length > MAX_SOURCE_BYTES) {
                return failure("SOURCE_TOO_LARGE");
            }
            return write(projectRoot, location, expectedRevision, content);
        } catch (IOException e) {
            LOG.warn("[HookMutation] Failed to restore hook source", e);
            return failure("RESTORE_FAILED");
        }
    }

    private String validateContent(Path target, Path project, String content) {
        if (pathPolicy.isCodexConfig(target, project)) {
            TomlParseResult parsed = Toml.parse(content);
            return parsed.hasErrors() ? "INVALID_TOML" : null;
        }
        if (!isClaudeSettings(target, project)) {
            return null;
        }
        try {
            JsonElement root = JsonParser.parseString(content);
            if (!root.isJsonObject()) {
                return "SETTINGS_NOT_OBJECT";
            }
            JsonElement hooks = root.getAsJsonObject().get("hooks");
            if (hooks != null && !hooks.isJsonNull() && !hooks.isJsonObject()) {
                return "HOOKS_NOT_OBJECT";
            }
            return null;
        } catch (RuntimeException e) {
            return "INVALID_JSON";
        }
    }

    private Path validateTarget(Path project, String location) throws IOException {
        return pathPolicy.validateExistingTarget(project, location);
    }

    private boolean isClaudeSettings(Path target, Path project) {
        return pathPolicy.isClaudeSettings(target, project);
    }

    private static Path normalizeProject(String projectRoot) {
        if (projectRoot == null || projectRoot.isBlank()) {
            return null;
        }
        try {
            return Paths.get(projectRoot).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Path validateBackup(Path target, String backupPath) {
        if (target == null || backupPath == null || backupPath.isBlank()) {
            return null;
        }
        Path backupDirectory = backupDirectory(target).toAbsolutePath().normalize();
        Path backup = Paths.get(backupPath).toAbsolutePath().normalize();
        return backup.startsWith(backupDirectory) ? backup : null;
    }

    private static Path createBackup(Path target) throws IOException {
        Path backupDirectory = backupDirectory(target);
        Files.createDirectories(backupDirectory);
        String name = System.currentTimeMillis() + "-" + UUID.randomUUID() + "-"
                + target.getFileName() + ".bak";
        Path backup = backupDirectory.resolve(name);
        Files.copy(target, backup, StandardCopyOption.COPY_ATTRIBUTES);
        return backup;
    }

    private static void replaceAtomically(Path target, String content) throws IOException {
        Path parent = target.getParent();
        Path temporary = Files.createTempFile(parent, ".ccgui-hook-", ".tmp");
        try {
            Files.writeString(temporary, content, StandardCharsets.UTF_8, StandardOpenOption.TRUNCATE_EXISTING);
            copySecurityAttributes(target, temporary);
            try {
                Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static Path backupDirectory(Path target) {
        Path current = target.getParent();
        while (current != null) {
            Path fileName = current.getFileName();
            if (fileName != null && "hooks".equalsIgnoreCase(fileName.toString())) {
                Path providerDirectory = current.getParent();
                if (providerDirectory != null) {
                    return providerDirectory.resolve(".ccgui-hooks-backups");
                }
            }
            current = current.getParent();
        }
        return target.getParent().resolve(".ccgui-hooks-backups");
    }

    private static void copySecurityAttributes(Path source, Path target) {
        copyPosixAttributes(source, target);
        copyAclAttributes(source, target);
        copyDosAttributes(source, target);
    }

    private static void copyPosixAttributes(Path source, Path target) {
        try {
            PosixFileAttributeView sourceView = Files.getFileAttributeView(source, PosixFileAttributeView.class);
            PosixFileAttributeView targetView = Files.getFileAttributeView(target, PosixFileAttributeView.class);
            if (sourceView == null || targetView == null) {
                return;
            }
            PosixFileAttributes attributes = sourceView.readAttributes();
            Set<PosixFilePermission> permissions = attributes.permissions();
            Set<PosixFilePermission> copiedPermissions = permissions.isEmpty()
                    ? EnumSet.noneOf(PosixFilePermission.class)
                    : EnumSet.copyOf(permissions);
            targetView.setPermissions(copiedPermissions);
            targetView.setOwner(attributes.owner());
            targetView.setGroup(attributes.group());
        } catch (UnsupportedOperationException | IOException | IllegalArgumentException ignored) {
            // Attribute views differ by filesystem; unsupported views are best effort.
        }
    }

    private static void copyAclAttributes(Path source, Path target) {
        try {
            AclFileAttributeView sourceView = Files.getFileAttributeView(source, AclFileAttributeView.class);
            AclFileAttributeView targetView = Files.getFileAttributeView(target, AclFileAttributeView.class);
            if (sourceView == null || targetView == null) {
                return;
            }
            targetView.setAcl(sourceView.getAcl());
            FileOwnerAttributeView ownerView = Files.getFileAttributeView(target, FileOwnerAttributeView.class);
            if (ownerView != null) {
                ownerView.setOwner(sourceView.getOwner());
            }
        } catch (UnsupportedOperationException | IOException | IllegalArgumentException ignored) {
            // Attribute views differ by filesystem; unsupported views are best effort.
        }
    }

    private static void copyDosAttributes(Path source, Path target) {
        try {
            DosFileAttributeView sourceView = Files.getFileAttributeView(source, DosFileAttributeView.class);
            DosFileAttributeView targetView = Files.getFileAttributeView(target, DosFileAttributeView.class);
            if (sourceView == null || targetView == null) {
                return;
            }
            DosFileAttributes attributes = sourceView.readAttributes();
            targetView.setArchive(attributes.isArchive());
            targetView.setHidden(attributes.isHidden());
            targetView.setSystem(attributes.isSystem());
            targetView.setReadOnly(attributes.isReadOnly());
        } catch (UnsupportedOperationException | IOException | IllegalArgumentException ignored) {
            // Attribute views differ by filesystem; unsupported views are best effort.
        }
    }

    private static String revision(Path path) throws IOException {
        return Files.size(path) + ":" + Files.getLastModifiedTime(path).toMillis();
    }

    private static JsonObject success() {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        return result;
    }

    private static JsonObject failure(String code) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("errorCode", code);
        return result;
    }
}
