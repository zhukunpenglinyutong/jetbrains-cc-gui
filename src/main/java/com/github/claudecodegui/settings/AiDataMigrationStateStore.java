package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import com.github.claudecodegui.settings.AiDataDirectoryManager.AiDataDirectoryException;
import com.github.claudecodegui.settings.AiDataDirectoryManager.SourceKind;
import com.github.claudecodegui.settings.AiDataDirectoryManager.Phase;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.DATA_HOME_IDS;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.JOURNAL_FILE;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.BACKUPS_FILE;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.BACKUPS_QUARANTINE_FILE;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.BACKUP_MARKER;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.GSON;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.appendFailure;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.notBlank;
import static com.github.claudecodegui.settings.AiDataDirectoryLinks.isDirectDirectoryLink;
import static com.github.claudecodegui.settings.AiDataTreeOperations.hasStorageMarker;

/** Persists and validates migration journals, backup ownership and quarantined metadata. */
final class AiDataMigrationStateStore {

    private final Path userHome;
    private final Path stateDirectory;

    AiDataMigrationStateStore(Path userHome, Path stateDirectory) {
        this.userHome = userHome;
        this.stateDirectory = stateDirectory;
    }

    private Path canonicalPath(String id) {
        return userHome.resolve("." + id).normalize();
    }

    BackupRecord validateBackupRecord(JsonElement element) throws IOException {
        if (!element.isJsonObject()) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
        }
        JsonObject record = element.getAsJsonObject();
        String id = requiredString(record, "id");
        String operationId = requiredString(record, "operationId");
        Path path;
        try {
            path = Path.of(requiredString(record, "path")).toAbsolutePath().normalize();
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID", error);
        }
        validateBackupPath(id, path, operationId);
        Path canonical = canonicalPath(id);
        boolean backupExists = Files.exists(path, LinkOption.NOFOLLOW_LINKS);
        if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)
                && backupExists
                && Files.isSameFile(canonical, path)) {
            throw new AiDataDirectoryException("BACKUP_STILL_ACTIVE");
        }
        return new BackupRecord(record, path, backupExists);
    }

    void persistBackupRecords(List<JsonElement> records) throws IOException {
        if (records.isEmpty()) {
            Files.deleteIfExists(backupsPath());
            return;
        }
        JsonArray metadata = new JsonArray();
        records.forEach(metadata::add);
        writeJson(backupsPath(), metadata);
    }

    void quarantineBackupRecord(JsonElement record, IOException reason) throws IOException {
        JsonArray quarantined = readQuarantinedBackupRecords();
        for (JsonElement element : quarantined) {
            if (element.isJsonObject()
                    && element.getAsJsonObject().has("record")
                    && element.getAsJsonObject().get("record").equals(record)) {
                return;
            }
        }
        JsonObject entry = new JsonObject();
        entry.add("record", JsonParser.parseString(record.toString()));
        entry.addProperty("reason", reason.getMessage() == null
                ? reason.getClass().getSimpleName() : reason.getMessage());
        entry.addProperty("quarantinedAt", Instant.now().toString());
        quarantined.add(entry);
        writeJson(quarantinePath(), quarantined);
    }

    void quarantineBackupMetadata(String rawMetadata, IOException reason) throws IOException {
        JsonArray quarantined = readQuarantinedBackupRecords();
        for (JsonElement element : quarantined) {
            if (element.isJsonObject()
                    && element.getAsJsonObject().has("rawMetadata")
                    && element.getAsJsonObject().get("rawMetadata").isJsonPrimitive()
                    && rawMetadata.equals(element.getAsJsonObject().get("rawMetadata").getAsString())) {
                return;
            }
        }
        JsonObject entry = new JsonObject();
        entry.addProperty("rawMetadata", rawMetadata);
        entry.addProperty("reason", reason.getMessage() == null
                ? reason.getClass().getSimpleName() : reason.getMessage());
        entry.addProperty("quarantinedAt", Instant.now().toString());
        quarantined.add(entry);
        writeJson(quarantinePath(), quarantined);
    }

    void rememberBackups(List<MigrationEntry> entries, String operationId) throws IOException {
        JsonArray records = readBackupRecords();
        for (MigrationEntry entry : entries) {
            Path backup = entry.sourceKind() == SourceKind.LOCAL
                    ? entry.backupPath() : entry.sourcePhysicalPath();
            if (backup == null || backup.equals(entry.targetPath())) {
                continue;
            }
            if (entry.sourceKind() == SourceKind.LINKED && !hasStorageMarker(backup, entry.id)) {
                continue;
            }
            JsonObject record = new JsonObject();
            record.addProperty("id", entry.id);
            record.addProperty("path", backup.toString());
            record.addProperty("createdAt", Instant.now().toString());
            record.addProperty("operationId", operationId);
            records.add(record);
        }
        writeJson(backupsPath(), records);
    }

    void removeBackupRecords(String operationId) throws IOException {
        if (!Files.isRegularFile(backupsPath(), LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        JsonArray retained = new JsonArray();
        for (JsonElement element : readBackupRecords()) {
            JsonObject record = element.getAsJsonObject();
            if (!record.has("operationId")
                    || !operationId.equals(record.get("operationId").getAsString())) {
                retained.add(record);
            }
        }
        if (retained.isEmpty()) {
            Files.deleteIfExists(backupsPath());
        } else {
            writeJson(backupsPath(), retained);
        }
    }

    void validateBackupPath(String id, Path path, String operationId) throws IOException {
        if (!List.of(DATA_HOME_IDS).contains(id) || !isUuid(operationId)) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
        }
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        String name = path.getFileName() == null ? "" : path.getFileName().toString();
        boolean localBackup = Objects.equals(path.getParent(), userHome)
                && isGeneratedBackupName(name, id, operationId);
        boolean relocatedHome = name.equals("." + id) && !path.equals(canonicalPath(id))
                && hasStorageMarker(path, id);
        if ((!localBackup && !relocatedHome) || isDirectDirectoryLink(path)) {
            throw new AiDataDirectoryException("BACKUP_PATH_INVALID");
        }
    }

    JsonArray readBackupRecords() throws IOException {
        if (!Files.isRegularFile(backupsPath(), LinkOption.NOFOLLOW_LINKS)) {
            return new JsonArray();
        }
        JsonElement value = JsonParser.parseString(Files.readString(backupsPath(), StandardCharsets.UTF_8));
        if (!value.isJsonArray()) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
        }
        return value.getAsJsonArray();
    }

    JsonArray readBackupRecordsForCleanup() throws IOException {
        if (!Files.isRegularFile(backupsPath(), LinkOption.NOFOLLOW_LINKS)) {
            return new JsonArray();
        }
        String rawMetadata = Files.readString(backupsPath(), StandardCharsets.UTF_8);
        JsonElement value;
        try {
            value = JsonParser.parseString(rawMetadata);
        } catch (RuntimeException error) {
            return quarantineCorruptBackupMetadata(
                    rawMetadata, new AiDataDirectoryException("BACKUP_METADATA_INVALID", error));
        }
        if (!value.isJsonArray()) {
            return quarantineCorruptBackupMetadata(
                    rawMetadata, new AiDataDirectoryException("BACKUP_METADATA_INVALID"));
        }
        return value.getAsJsonArray();
    }

    JsonArray quarantineCorruptBackupMetadata(String rawMetadata, IOException reason) throws IOException {
        IOException failure = reason;
        try {
            quarantineBackupMetadata(rawMetadata, reason);
            Files.deleteIfExists(backupsPath());
        } catch (IOException quarantineError) {
            failure = appendFailure(failure, quarantineError);
        }
        throw new AiDataDirectoryException("BACKUP_CLEANUP_PARTIAL", failure);
    }

    JsonArray readQuarantinedBackupRecords() throws IOException {
        if (!Files.isRegularFile(quarantinePath(), LinkOption.NOFOLLOW_LINKS)) {
            return new JsonArray();
        }
        try {
            JsonElement value = JsonParser.parseString(
                    Files.readString(quarantinePath(), StandardCharsets.UTF_8));
            if (!value.isJsonArray()) {
                throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
            }
            return value.getAsJsonArray();
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID", error);
        }
    }

    Journal readJournal() throws IOException {
        try {
            Journal journal = GSON.fromJson(
                    Files.readString(journalPath(), StandardCharsets.UTF_8), Journal.class);
            validateJournal(journal);
            return journal;
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID", error);
        }
    }

    void validateJournal(Journal journal) throws IOException {
        if (journal == null || !isUuid(journal.operationId)
                || journal.entries == null || journal.entries.isEmpty()
                || journal.entries.size() > DATA_HOME_IDS.length) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
        }
        Set<String> ids = new HashSet<>();
        for (MigrationEntry entry : journal.entries) {
            if (entry == null || !List.of(DATA_HOME_IDS).contains(entry.id) || !ids.add(entry.id)) {
                throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
            }
            Path canonical = requireAbsolutePath(entry.canonical);
            Path target = requireAbsolutePath(entry.target);
            Path staging = requireAbsolutePath(entry.staging);
            Path backup = requireAbsolutePath(entry.backup);
            Path targetRoot = target.getParent();
            String targetName = target.getFileName() == null ? "" : target.getFileName().toString();
            String stagingName = staging.getFileName() == null ? "" : staging.getFileName().toString();
            String backupName = backup.getFileName() == null ? "" : backup.getFileName().toString();
            if (!canonical.equals(canonicalPath(entry.id))
                    || targetRoot == null || !targetName.equals("." + entry.id)
                    || !Objects.equals(staging.getParent(), targetRoot)
                    || !stagingName.equals(".cc-gui-migration-" + journal.operationId + "-" + entry.id)
                    || !Objects.equals(backup.getParent(), userHome)
                    || !isGeneratedBackupName(backupName, entry.id, journal.operationId)
                    || overlapsCanonicalHome(targetRoot)
                    || !isValidEnum(entry.sourceKind, SourceKind.class)
                    || !isValidEnum(entry.phase, Phase.class)
                    || (entry.targetFingerprint != null && !entry.targetFingerprint.matches("[a-f0-9]{64}"))) {
                throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
            }
            SourceKind kind = entry.sourceKind();
            if (kind == SourceKind.MISSING && entry.sourcePhysical != null) {
                throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
            }
            if (kind != SourceKind.MISSING) {
                Path source = requireAbsolutePath(entry.sourcePhysical);
                if (source.getFileName() == null
                        || !source.getFileName().toString().equals("." + entry.id)) {
                    throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
                }
            }
        }
    }

    boolean overlapsCanonicalHome(Path targetRoot) {
        for (String id : DATA_HOME_IDS) {
            Path canonical = canonicalPath(id);
            if (targetRoot.startsWith(canonical) || canonical.startsWith(targetRoot)) {
                return true;
            }
        }
        return false;
    }

    static Path requireAbsolutePath(String value) throws IOException {
        if (!notBlank(value)) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
        }
        Path path;
        try {
            path = Path.of(value);
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID", error);
        }
        if (!path.isAbsolute() || !path.equals(path.normalize())) {
            throw new AiDataDirectoryException("MIGRATION_JOURNAL_INVALID");
        }
        return path;
    }

    static boolean isUuid(String value) {
        try {
            return value != null && UUID.fromString(value).toString().equals(value);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    static boolean isGeneratedBackupName(String name, String id, String operationId) {
        String prefix = "." + id + BACKUP_MARKER;
        String suffix = "-" + operationId;
        if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
            return false;
        }
        String timestamp = name.substring(prefix.length(), name.length() - suffix.length());
        return !timestamp.isEmpty() && timestamp.chars().allMatch(Character::isDigit);
    }

    static <T extends Enum<T>> boolean isValidEnum(String value, Class<T> type) {
        try {
            Enum.valueOf(type, value);
            return true;
        } catch (RuntimeException error) {
            return false;
        }
    }

    void writeJournal(Journal journal) throws IOException {
        writeJson(journalPath(), GSON.toJsonTree(journal));
    }

    static void writeJson(Path path, JsonElement value) throws IOException {
        Files.createDirectories(path.getParent());
        Path temporary = Files.createTempFile(path.getParent(), ".ai-data-", ".json");
        try {
            Files.writeString(temporary, GSON.toJson(value), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    Path journalPath() {
        return stateDirectory.resolve(JOURNAL_FILE);
    }

    Path backupsPath() {
        return stateDirectory.resolve(BACKUPS_FILE);
    }

    Path quarantinePath() {
        return stateDirectory.resolve(BACKUPS_QUARANTINE_FILE);
    }

    static String requiredString(JsonObject object, String key) throws IOException {
        if (!object.has(key) || !object.get(key).isJsonPrimitive()
                || !object.getAsJsonPrimitive(key).isString()) {
            throw new AiDataDirectoryException("BACKUP_METADATA_INVALID");
        }
        return object.get(key).getAsString();
    }

    static final class Journal {
        String operationId;
        List<MigrationEntry> entries;

        Journal(String operationId, List<MigrationEntry> entries) {
            this.operationId = operationId;
            this.entries = entries;
        }
    }

    static final class MigrationEntry {
        String id;
        String canonical;
        String target;
        String staging;
        String backup;
        String sourcePhysical;
        String sourceKind;
        String phase;
        String targetFingerprint;
        boolean targetExisted;

        MigrationEntry(String id, Path canonical, Path target, Path staging, Path backup,
                               Path sourcePhysical, SourceKind sourceKind, boolean targetExisted) {
            this.id = id;
            this.canonical = canonical.toString();
            this.target = target.toString();
            this.staging = staging.toString();
            this.backup = backup.toString();
            this.sourcePhysical = sourcePhysical == null ? null : sourcePhysical.toString();
            this.sourceKind = sourceKind.name();
            this.phase = Phase.INITIAL.name();
            this.targetExisted = targetExisted;
        }

        Path canonicalPath() {
            return Path.of(canonical);
        }

        Path targetPath() {
            return Path.of(target);
        }

        Path stagingPath() {
            return Path.of(staging);
        }

        Path backupPath() {
            return Path.of(backup);
        }

        Path sourcePhysicalPath() {
            return sourcePhysical == null ? null : Path.of(sourcePhysical);
        }

        SourceKind sourceKind() {
            return SourceKind.valueOf(sourceKind);
        }
    }

    static final class BackupRecord {
        final JsonObject metadata;
        final Path path;
        final boolean existedAtValidation;

        BackupRecord(JsonObject metadata, Path path, boolean existedAtValidation) {
            this.metadata = metadata;
            this.path = path;
            this.existedAtValidation = existedAtValidation;
        }
    }

}
