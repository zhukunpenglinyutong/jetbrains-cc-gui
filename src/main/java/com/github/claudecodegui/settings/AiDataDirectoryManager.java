package com.github.claudecodegui.settings;

import com.github.claudecodegui.settings.AiDataMigrationStateStore.Journal;
import com.github.claudecodegui.settings.AiDataMigrationStateStore.MigrationEntry;
import com.github.claudecodegui.settings.AiDataMigrationStateStore.BackupRecord;
import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.bridge.DshHostProcessCoordinator;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.PathManager;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Safely relocates AI CLI data while preserving the canonical home-directory paths. */
public final class AiDataDirectoryManager {

    private static final Object OPERATION_LOCK = new Object();
    static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    static final String[] DATA_HOME_IDS = {"claude", "codemoss", "codex"};
    static final String JOURNAL_FILE = "migration-journal.json";
    static final String BACKUPS_FILE = "migration-backups.json";
    static final String BACKUPS_QUARANTINE_FILE = "migration-backups-quarantine.json";
    private static final String LEGACY_IMPORT_FILE = "legacy-import.json";
    static final String BACKUP_MARKER = ".cc-gui-backup-";
    static final String STORAGE_MARKER = ".cc-gui-storage";
    static final CancellationChecker NO_CANCELLATION = () -> { };

    private final Path userHome;
    private final AiDataMigrationStateStore stateStore;
    private final Path stateDirectory;
    private final PlatformUtils.PlatformType platform;
    private final boolean wsl;
    private final DirectoryLinkCreator linkCreator;
    private final AiDataProcessGate processGate;
    private final PathDeleter backupPathDeleter;
    private final AiDataMigrationCoordinator migrationCoordinator;
    private final Path legacyStateDirectory;
    private final Path coordinationStateDirectory;
    private final AiDataExternalProcessDetector externalProcessDetector = new AiDataExternalProcessDetector();
    private final boolean scanExternalProcesses;

    public AiDataDirectoryManager() {
        this(Path.of(PlatformUtils.getHomeDirectory()),
                defaultCoordinationDirectory().resolve("state"),
                PlatformUtils.getPlatformType(),
                PlatformUtils.isLinux() && notBlank(PlatformUtils.getEnvIgnoreCase("WSL_DISTRO_NAME")),
                null, AiDataProcessGate.getInstance(), AiDataDirectoryManager::deleteWritablePath,
                defaultCoordinationDirectory());
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator) {
        this(userHome, stateDirectory, platform, wsl, linkCreator, AiDataProcessGate.getInstance());
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator, AiDataProcessGate processGate) {
        this(userHome, stateDirectory, platform, wsl, linkCreator, processGate,
                AiDataDirectoryManager::deleteWritablePath);
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator, AiDataProcessGate processGate,
                           PathDeleter backupPathDeleter) {
        this(userHome, stateDirectory, platform, wsl, linkCreator, processGate, backupPathDeleter,
                defaultCoordinationDirectory());
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator, AiDataProcessGate processGate,
                           PathDeleter backupPathDeleter, Path coordinationDirectory) {
        this(userHome, stateDirectory, platform, wsl, linkCreator, processGate, backupPathDeleter,
                coordinationDirectory, defaultLegacyStateDirectory());
    }

    AiDataDirectoryManager(Path userHome, Path stateDirectory,
                           PlatformUtils.PlatformType platform, boolean wsl,
                           DirectoryLinkCreator linkCreator, AiDataProcessGate processGate,
                           PathDeleter backupPathDeleter, Path coordinationDirectory, Path legacyStateDirectory) {
        this.userHome = userHome.toAbsolutePath().normalize();
        this.stateDirectory = stateDirectory.toAbsolutePath().normalize();
        this.stateStore = new AiDataMigrationStateStore(this.userHome, this.stateDirectory);
        this.platform = Objects.requireNonNull(platform, "platform");
        this.wsl = wsl;
        this.linkCreator = linkCreator == null ? this::createPlatformLink : linkCreator;
        this.processGate = Objects.requireNonNull(processGate, "processGate");
        this.backupPathDeleter = Objects.requireNonNull(backupPathDeleter, "backupPathDeleter");
        this.migrationCoordinator = new AiDataMigrationCoordinator(coordinationDirectory);
        this.coordinationStateDirectory = coordinationDirectory.toAbsolutePath().normalize().resolve("state");
        this.legacyStateDirectory = legacyStateDirectory.toAbsolutePath().normalize();
        this.scanExternalProcesses = this.userHome.equals(Path.of(PlatformUtils.getHomeDirectory()).toAbsolutePath().normalize());
    }

    public JsonObject snapshot() throws IOException {
        synchronized (OPERATION_LOCK) {
            if (!isSupported() || !processGate.isCoordinationAvailable()) {
                return buildSnapshot(false);
            }
            if (!needsExclusiveSnapshot()) {
                try (AiDataMigrationCoordinator.ProcessLock readLock = migrationCoordinator.tryAcquireProcessLock()) {
                    if (readLock == null) {
                        return buildBusySnapshot();
                    }
                    if (!needsExclusiveSnapshot()) {
                        return buildSnapshot(false);
                    }
                }
            }
            try (AiDataProcessGate.MigrationPermit recovery = acquireRecoveryPermitIfNeeded()) {
                AiDataMigrationCoordinator.LockHandle migrationLock = recovery == null ? migrationCoordinator.tryAcquire("status") : null;
                if (recovery == null && migrationLock == null) {
                    return buildBusySnapshot();
                }
                try (migrationLock) {
                    importLegacyState();
                    if (Files.isRegularFile(stateStore.journalPath(), LinkOption.NOFOLLOW_LINKS)
                            && hasExternalAiProcess()) {
                        throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
                    }
                    boolean recovered = recoverInterruptedMigration();
                    return buildSnapshot(recovered);
                }
            } catch (AiDataDirectoryException error) {
                if ("AI_DATA_MIGRATION_ACTIVE".equals(error.getMessage())
                        || "AI_PROCESSES_ACTIVE".equals(error.getMessage())) {
                    return buildBusySnapshot();
                }
                throw error;
            }
        }
    }

    private boolean needsExclusiveSnapshot() {
        if (Files.exists(stateStore.journalPath(), LinkOption.NOFOLLOW_LINKS)) {
            return true;
        }
        if (!stateDirectory.equals(coordinationStateDirectory) || stateDirectory.equals(legacyStateDirectory)) {
            return false;
        }
        if (Files.exists(stateDirectory.resolve(LEGACY_IMPORT_FILE), LinkOption.NOFOLLOW_LINKS)) {
            return true;
        }
        for (String filename : new String[]{JOURNAL_FILE, BACKUPS_FILE, BACKUPS_QUARANTINE_FILE}) {
            if (Files.exists(legacyStateDirectory.resolve(filename), LinkOption.NOFOLLOW_LINKS)) {
                return true;
            }
        }
        return false;
    }

    public JsonObject migrate(String requestedRoot) throws IOException {
        synchronized (OPERATION_LOCK) {
            requireSupported();
            if (scanExternalProcesses && DshHostProcessCoordinator.getInstance().hasRunningHost()) {
                throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
            }
            AiDataProcessGate.MigrationPermit migrationPermit = acquireMigrationPermit("migrate");
            try (migrationPermit) {
                importLegacyState();
                if (hasExternalAiProcess()) {
                    throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
                }
                recoverInterruptedMigration();
                checkMigrationCancellation(migrationPermit);
                Path targetRoot = validateTargetRoot(requestedRoot);
                String operationId = UUID.randomUUID().toString();
                List<MigrationEntry> entries = prepareEntries(targetRoot, operationId);
                checkMigrationCancellation(migrationPermit);
                if (entries.isEmpty()) {
                    beginMigrationCommit(migrationPermit);
                    return operationResult("migrate", true, null, buildSnapshot(false));
                }

                Journal journal = new Journal(operationId, entries);
                stateStore.writeJournal(journal);
                try {
                    for (MigrationEntry entry : entries) {
                        checkMigrationCancellation(migrationPermit);
                        prepareTarget(entry, migrationPermit, journal);
                        checkMigrationCancellation(migrationPermit);
                        entry.phase = Phase.TARGET_READY.name();
                        stateStore.writeJournal(journal);
                    }
                    for (MigrationEntry entry : entries) {
                        checkMigrationCancellation(migrationPermit);
                        detachCanonicalPath(entry);
                        checkMigrationCancellation(migrationPermit);
                        entry.phase = Phase.SOURCE_DETACHED.name();
                        stateStore.writeJournal(journal);
                        linkCreator.create(entry.canonicalPath(), entry.targetPath());
                        AiDataDirectoryLinks.validateLink(entry.canonicalPath(), entry.targetPath());
                        validateDetachedSource(entry, () -> checkMigrationCancellation(migrationPermit));
                        checkMigrationCancellation(migrationPermit);
                        entry.phase = Phase.LINKED.name();
                        stateStore.writeJournal(journal);
                    }
                    checkMigrationCancellation(migrationPermit);
                    stateStore.rememberBackups(entries, journal.operationId);
                    checkMigrationCancellation(migrationPermit);
                    beginMigrationCommit(migrationPermit);
                    Files.deleteIfExists(stateStore.journalPath());
                    return operationResult("migrate", true, null, buildSnapshot(false));
                } catch (IOException | RuntimeException error) {
                    try {
                        rollback(journal);
                    } catch (IOException rollbackError) {
                        error.addSuppressed(rollbackError);
                        throw new AiDataDirectoryException("MIGRATION_ROLLBACK_FAILED", error);
                    }
                    throw error;
                }
            }
        }
    }

    private static void checkMigrationCancellation(AiDataProcessGate.MigrationPermit migrationPermit)
            throws AiDataDirectoryException {
        if (migrationPermit.isCancellationRequested()) {
            throw new AiDataDirectoryException("MIGRATION_CANCELLED_FOR_AI_START");
        }
    }

    private static void beginMigrationCommit(AiDataProcessGate.MigrationPermit migrationPermit)
            throws AiDataDirectoryException {
        if (!migrationPermit.beginCommit()) {
            throw new AiDataDirectoryException("MIGRATION_CANCELLED_FOR_AI_START");
        }
    }

    public JsonObject cleanupBackups() throws IOException {
        synchronized (OPERATION_LOCK) {
            requireSupported();
            AiDataProcessGate.MigrationPermit migrationPermit = acquireMigrationPermit("cleanup");
            try (migrationPermit) {
                importLegacyState();
                if (hasExternalAiProcess()) {
                    throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
                }
                recoverInterruptedMigration();
                if (hasExternalAiProcess()
                        || !migrationPermit.beginCommit()) {
                    throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
                }

                JsonArray metadata = stateStore.readBackupRecordsForCleanup();
                List<BackupRecord> records = new ArrayList<>();
                List<JsonElement> retained = new ArrayList<>();
                IOException cleanupFailure = null;
                for (JsonElement element : metadata) {
                    try {
                        BackupRecord record = stateStore.validateBackupRecord(element);
                        records.add(record);
                        retained.add(record.metadata);
                    } catch (IOException error) {
                        cleanupFailure = appendFailure(cleanupFailure, error);
                        try {
                            stateStore.quarantineBackupRecord(element, error);
                        } catch (IOException quarantineError) {
                            retained.add(element);
                            cleanupFailure = appendFailure(cleanupFailure, quarantineError);
                        }
                    }
                }
                if (retained.size() < metadata.size()) {
                    try {
                        stateStore.persistBackupRecords(retained);
                    } catch (IOException error) {
                        cleanupFailure = appendFailure(cleanupFailure, error);
                    }
                }
                for (BackupRecord record : records) {
                    if (record.existedAtValidation) {
                        try {
                            deleteTree(record.path, backupPathDeleter);
                        } catch (IOException error) {
                            cleanupFailure = appendFailure(cleanupFailure, error);
                            continue;
                        }
                    }

                    removeMetadata(retained, record.metadata);
                    try {
                        stateStore.persistBackupRecords(retained);
                    } catch (IOException error) {
                        cleanupFailure = appendFailure(cleanupFailure, error);
                        break;
                    }
                }
                if (cleanupFailure != null) {
                    throw new AiDataDirectoryException("BACKUP_CLEANUP_PARTIAL", cleanupFailure);
                }
                return operationResult("cleanup", true, null, buildSnapshot(false));
            }
        }
    }

    private static void removeMetadata(List<JsonElement> records, JsonObject metadata) {
        for (int index = 0; index < records.size(); index++) {
            if (records.get(index) == metadata) {
                records.remove(index);
                return;
            }
        }
    }

    static IOException appendFailure(IOException current, IOException next) {
        if (current == null) {
            return next;
        }
        current.addSuppressed(next);
        return current;
    }

    private List<MigrationEntry> prepareEntries(Path targetRoot, String operationId) throws IOException {
        List<MigrationEntry> entries = new ArrayList<>();
        for (String id : DATA_HOME_IDS) {
            Path canonical = canonicalPath(id);
            Path target = targetRoot.resolve("." + id).normalize();
            if (!Objects.equals(target.getParent(), targetRoot)) {
                throw new AiDataDirectoryException("TARGET_PATH_INVALID");
            }

            SourceKind sourceKind = SourceKind.MISSING;
            Path sourcePhysical = null;
            if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
                if (!Files.isDirectory(canonical)) {
                    throw new AiDataDirectoryException("SOURCE_NOT_DIRECTORY");
                }
                sourcePhysical = canonical.toRealPath();
                sourceKind = isDirectDirectoryLink(canonical) ? SourceKind.LINKED : SourceKind.LOCAL;
            }
            if (sourcePhysical != null && Files.exists(target, LinkOption.NOFOLLOW_LINKS)
                    && Files.isSameFile(sourcePhysical, target)) {
                continue;
            }
            if (sourcePhysical != null && targetRoot.startsWith(sourcePhysical)) {
                throw new AiDataDirectoryException("TARGET_INSIDE_SOURCE");
            }
            boolean targetExisted = Files.exists(target, LinkOption.NOFOLLOW_LINKS);
            if (targetExisted) {
                if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)
                        || isDirectDirectoryLink(target) || !isDirectoryEmpty(target)) {
                    throw new AiDataDirectoryException("TARGET_NOT_EMPTY");
                }
            }
            Path staging = targetRoot.resolve(".cc-gui-migration-" + operationId + "-" + id);
            Path backup = userHome.resolve("." + id + BACKUP_MARKER
                    + Instant.now().toEpochMilli() + "-" + operationId);
            entries.add(new MigrationEntry(id, canonical, target, staging, backup,
                    sourcePhysical, sourceKind, targetExisted));
        }
        return entries;
    }

    private Path validateTargetRoot(String value) throws IOException {
        if (!notBlank(value)) {
            throw new AiDataDirectoryException("TARGET_ROOT_REQUIRED");
        }
        Path requested;
        try {
            requested = Path.of(value);
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("TARGET_PATH_INVALID", error);
        }
        if (!requested.isAbsolute()) {
            throw new AiDataDirectoryException("TARGET_PATH_INVALID");
        }
        requested = requested.normalize();
        for (String id : DATA_HOME_IDS) {
            Path canonical = canonicalPath(id);
            if (requested.startsWith(canonical) || canonical.startsWith(requested)) {
                throw new AiDataDirectoryException("TARGET_OVERLAPS_HOME");
            }
        }
        Files.createDirectories(requested);
        if (!Files.isDirectory(requested, LinkOption.NOFOLLOW_LINKS)
                || isDirectDirectoryLink(requested) || !Files.isWritable(requested)) {
            throw new AiDataDirectoryException("TARGET_ROOT_UNAVAILABLE");
        }
        return requested.toRealPath();
    }

    private void prepareTarget(MigrationEntry entry, AiDataProcessGate.MigrationPermit migrationPermit, Journal journal)
            throws IOException {
        CancellationChecker cancellationChecker = () -> checkMigrationCancellation(migrationPermit);
        Path staging = entry.stagingPath();
        if (Files.exists(staging, LinkOption.NOFOLLOW_LINKS)) {
            throw new AiDataDirectoryException("STAGING_PATH_EXISTS");
        }
        validateStorageMarker(entry);
        Files.createDirectory(staging);
        Path source = entry.sourcePhysicalPath();
        Map<Path, Path> internalDirectoryLinks = Map.of();
        if (source != null) {
            Map<String, ManifestEntry> before = buildDataManifest(source, cancellationChecker);
            internalDirectoryLinks = copyDirectory(source, staging, cancellationChecker);
            Map<String, ManifestEntry> copied = buildDataManifest(staging, cancellationChecker);
            Map<String, ManifestEntry> after = buildDataManifest(source, cancellationChecker);
            if (!before.equals(copied) || !before.equals(after)) {
                throw new AiDataDirectoryException("SOURCE_CHANGED_DURING_MIGRATION");
            }
        }
        Path target = entry.targetPath();
        if (entry.targetExisted) {
            Files.delete(target);
        }
        Path marker = staging.resolve(STORAGE_MARKER);
        if (Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
            if (!AiDataTreeOperations.hasStorageMarker(staging, entry.id)) {
                throw new AiDataDirectoryException("STORAGE_MARKER_CONFLICT");
            }
        } else {
            Files.writeString(marker, entry.id, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
        }
        // Persist the verified contents before publishing a path that external tools can write.
        entry.targetFingerprint = targetFingerprint(staging, cancellationChecker);
        stateStore.writeJournal(journal);
        for (Path relativeLink : internalDirectoryLinks.keySet()) {
            cancellationChecker.check();
            AiDataDirectoryLinks.deleteDirectoryLink(staging.resolve(relativeLink));
        }
        cancellationChecker.check();
        move(staging, target);
        for (Map.Entry<Path, Path> link : internalDirectoryLinks.entrySet()) {
            cancellationChecker.check();
            createPlatformLink(target.resolve(link.getKey()), target.resolve(link.getValue()));
        }
    }

    private static String targetFingerprint(Path path, CancellationChecker cancellationChecker) throws IOException {
        String manifest = GSON.toJson(new java.util.TreeMap<>(buildDataManifest(path, cancellationChecker)));
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(manifest.getBytes(StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IOException("SHA-256 is unavailable", impossible);
        }
    }

    private static void validateStorageMarker(MigrationEntry entry) throws IOException {
        Path source = entry.sourcePhysicalPath();
        if (source == null) {
            return;
        }
        Path marker = source.resolve(STORAGE_MARKER);
        if (!Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (entry.sourceKind() != SourceKind.LINKED || !AiDataTreeOperations.hasStorageMarker(source, entry.id)) {
            throw new AiDataDirectoryException("STORAGE_MARKER_CONFLICT");
        }
    }

    private void detachCanonicalPath(MigrationEntry entry) throws IOException {
        Path canonical = entry.canonicalPath();
        if (entry.sourceKind() == SourceKind.LOCAL) {
            move(canonical, entry.backupPath());
        } else if (entry.sourceKind() == SourceKind.LINKED) {
            AiDataDirectoryLinks.deleteDirectoryLink(canonical);
        }
    }

    private static void validateDetachedSource(MigrationEntry entry, CancellationChecker cancellationChecker)
            throws IOException {
        Path detachedSource = entry.sourceKind() == SourceKind.LOCAL
                ? entry.backupPath() : entry.sourcePhysicalPath();
        if (detachedSource != null
                && !buildDataManifest(detachedSource, entry.sourcePhysicalPath(), entry.targetPath(), cancellationChecker)
                        .equals(buildDataManifest(entry.targetPath(), cancellationChecker))) {
            throw new AiDataDirectoryException("SOURCE_CHANGED_DURING_MIGRATION");
        }
    }

    private boolean recoverInterruptedMigration() throws IOException {
        if (!Files.isRegularFile(stateStore.journalPath(), LinkOption.NOFOLLOW_LINKS)) {
            return false;
        }
        rollback(stateStore.readJournal());
        return true;
    }

    private AiDataProcessGate.MigrationPermit acquireRecoveryPermitIfNeeded() throws IOException {
        if (!Files.isRegularFile(stateStore.journalPath(), LinkOption.NOFOLLOW_LINKS)
                && (stateDirectory.equals(legacyStateDirectory)
                    || !Files.exists(legacyStateDirectory.resolve(JOURNAL_FILE), LinkOption.NOFOLLOW_LINKS))) {
            return null;
        }
        return acquireMigrationPermit("recovery");
    }

    private AiDataProcessGate.MigrationPermit acquireMigrationPermit(String operation) throws IOException {
        AiDataProcessGate.MigrationPermit permit = processGate.tryAcquireCoordinatedMigrationPermit(operation);
        if (permit == null) {
            if (!processGate.isCoordinationAvailable()) {
                throw new AiDataDirectoryException("AI_DATA_COORDINATION_UNAVAILABLE");
            }
            JsonObject owner = migrationCoordinator.readActiveOwner();
            if (owner != null) {
                throw new AiDataDirectoryException("AI_DATA_MIGRATION_ACTIVE", owner);
            }
            throw new AiDataDirectoryException("AI_PROCESSES_ACTIVE");
        }
        return permit;
    }

    private boolean hasExternalAiProcess() {
        // Only the canonical user home can be used by independently launched hosts.
        return scanExternalProcesses && (DshHostProcessCoordinator.getInstance().hasRunningHost()
                || externalProcessDetector.hasRunningProcess());
    }

    private void importLegacyState() throws IOException {
        if (!stateDirectory.equals(coordinationStateDirectory) || stateDirectory.equals(legacyStateDirectory)) {
            return;
        }
        if (Files.isSymbolicLink(stateDirectory)) {
            throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
        }
        Path intent = stateDirectory.resolve(LEGACY_IMPORT_FILE);
        if (Files.exists(intent, LinkOption.NOFOLLOW_LINKS)) {
            resumeLegacyImport(readLegacyImportIntent(intent));
            return;
        }
        List<String> filenames = new ArrayList<>();
        for (String filename : new String[]{JOURNAL_FILE, BACKUPS_FILE, BACKUPS_QUARANTINE_FILE}) {
            Path source = legacyStateDirectory.resolve(filename);
            if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS)) {
                continue;
            }
            Path destination = stateDirectory.resolve(filename);
            if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)
                    || Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) {
                throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
            }
            filenames.add(filename);
        }
        if (filenames.isEmpty()) {
            return;
        }
        Files.createDirectories(stateDirectory);
        JsonArray plannedFiles = new JsonArray();
        filenames.forEach(plannedFiles::add);
        AiDataMigrationStateStore.writeJson(intent, plannedFiles);
        resumeLegacyImport(filenames);
    }

    private List<String> readLegacyImportIntent(Path intent) throws IOException {
        try {
            if (!Files.isRegularFile(intent, LinkOption.NOFOLLOW_LINKS)) {
                throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
            }
            JsonElement parsed = JsonParser.parseString(Files.readString(intent, StandardCharsets.UTF_8));
            if (!parsed.isJsonArray() || parsed.getAsJsonArray().isEmpty()
                    || parsed.getAsJsonArray().size() > 3) {
                throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
            }
            List<String> filenames = new ArrayList<>();
            for (JsonElement item : parsed.getAsJsonArray()) {
                if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()) {
                    throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
                }
                String filename = item.getAsString();
                if (!List.of(JOURNAL_FILE, BACKUPS_FILE, BACKUPS_QUARANTINE_FILE).contains(filename)
                        || filenames.contains(filename)) {
                    throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
                }
                filenames.add(filename);
            }
            return filenames;
        } catch (RuntimeException error) {
            throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT", error);
        }
    }

    private void resumeLegacyImport(List<String> filenames) throws IOException {
        for (String filename : filenames) {
            Path source = legacyStateDirectory.resolve(filename);
            Path destination = stateDirectory.resolve(filename);
            boolean sourcePresent = Files.exists(source, LinkOption.NOFOLLOW_LINKS);
            boolean destinationPresent = Files.exists(destination, LinkOption.NOFOLLOW_LINKS);
            if ((sourcePresent && !Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS))
                    || (destinationPresent && !Files.isRegularFile(destination, LinkOption.NOFOLLOW_LINKS))
                    || (!sourcePresent && !destinationPresent)) {
                throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
            }
            if (!destinationPresent) {
                Path temporary = Files.createTempFile(stateDirectory, ".legacy-import-", ".json");
                try {
                    Files.copy(source, temporary, StandardCopyOption.REPLACE_EXISTING, LinkOption.NOFOLLOW_LINKS);
                    move(temporary, destination);
                } finally {
                    Files.deleteIfExists(temporary);
                }
            }
            if (sourcePresent) {
                if (Files.mismatch(source, destination) != -1L) {
                    throw new AiDataDirectoryException("LEGACY_MIGRATION_STATE_CONFLICT");
                }
                Files.delete(source);
            }
        }
        Files.delete(stateDirectory.resolve(LEGACY_IMPORT_FILE));
    }

    private void rollback(Journal journal) throws IOException {
        stateStore.validateJournal(journal);
        IOException failure = null;
        List<MigrationEntry> reverse = new ArrayList<>(journal.entries);
        reverse.sort(Comparator.comparingInt((MigrationEntry entry) -> phaseOrder(entry.phase)).reversed());
        for (MigrationEntry entry : reverse) {
            try {
                rollbackEntry(entry);
            } catch (IOException error) {
                if (failure == null) {
                    failure = error;
                } else {
                    failure.addSuppressed(error);
                }
            }
        }
        if (failure != null) {
            throw failure;
        }
        stateStore.removeBackupRecords(journal.operationId);
        Files.deleteIfExists(stateStore.journalPath());
    }

    private void rollbackEntry(MigrationEntry entry) throws IOException {
        Path canonical = entry.canonicalPath();
        Path target = entry.targetPath();
        if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
            if (isDirectDirectoryLink(canonical)) {
                boolean pointsToTarget = AiDataTreeOperations.hasStorageMarker(target, entry.id) && AiDataDirectoryLinks.isLinkTo(canonical, target);
                Path previous = entry.sourcePhysicalPath();
                boolean pointsToPrevious = entry.sourceKind() == SourceKind.LINKED
                        && previous != null && AiDataDirectoryLinks.isLinkTo(canonical, previous);
                if (!pointsToTarget && !pointsToPrevious) {
                    throw new AiDataDirectoryException("RECOVERY_PATH_CONFLICT");
                }
                AiDataDirectoryLinks.deleteDirectoryLink(canonical);
            } else if (entry.sourceKind() != SourceKind.LOCAL) {
                throw new AiDataDirectoryException("RECOVERY_PATH_CONFLICT");
            }
        }
        if (entry.sourceKind() == SourceKind.LOCAL && Files.exists(entry.backupPath(), LinkOption.NOFOLLOW_LINKS)) {
            if (Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
                throw new AiDataDirectoryException("RECOVERY_PATH_CONFLICT");
            }
            move(entry.backupPath(), canonical);
        } else if (entry.sourceKind() == SourceKind.LINKED
                && !Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
            Path previous = entry.sourcePhysicalPath();
            if (previous == null || !Files.isDirectory(previous, LinkOption.NOFOLLOW_LINKS)) {
                throw new AiDataDirectoryException("RECOVERY_SOURCE_MISSING");
            }
            linkCreator.create(canonical, previous);
            AiDataDirectoryLinks.validateLink(canonical, previous);
        }
        if (Files.exists(entry.stagingPath(), LinkOption.NOFOLLOW_LINKS)) {
            deleteTree(entry.stagingPath());
        }
        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            if (AiDataTreeOperations.hasStorageMarker(target, entry.id)) {
                if (entry.targetFingerprint != null
                        && !entry.targetFingerprint.equals(targetFingerprint(target, NO_CANCELLATION))) {
                    throw new AiDataDirectoryException("RECOVERY_TARGET_CHANGED");
                }
                deleteTree(target);
            } else if (!entry.targetExisted || !isDirectoryEmpty(target)) {
                throw new AiDataDirectoryException("RECOVERY_TARGET_CONFLICT");
            }
        }
        if (entry.targetExisted && !Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            Files.createDirectory(target);
        }
    }

    private JsonObject inspectEntry(String id) {
        JsonObject entry = new JsonObject();
        Path canonical = canonicalPath(id);
        entry.addProperty("id", id);
        entry.addProperty("canonicalPath", canonical.toString());
        try {
            if (!Files.exists(canonical, LinkOption.NOFOLLOW_LINKS)) {
                entry.addProperty("state", "missing");
                return entry;
            }
            if (!Files.isDirectory(canonical)) {
                entry.addProperty("state", "unavailable");
                return entry;
            }
            entry.addProperty("state", isDirectDirectoryLink(canonical) ? "linked" : "local");
            entry.addProperty("physicalPath", canonical.toRealPath().toString());
        } catch (IOException error) {
            entry.addProperty("state", "unavailable");
        }
        return entry;
    }

    public boolean isSupportedPlatform() {
        return isSupported();
    }

    public boolean isWslPlatform() {
        return wsl;
    }

    private boolean isSupported() {
        return !wsl && platform == PlatformUtils.PlatformType.WINDOWS;
    }

    private void requireSupported() throws AiDataDirectoryException {
        if (wsl) {
            throw new AiDataDirectoryException("WSL_NOT_SUPPORTED");
        }
        if (platform != PlatformUtils.PlatformType.WINDOWS) {
            throw new AiDataDirectoryException("PLATFORM_NOT_SUPPORTED");
        }
    }

    private JsonObject buildSnapshot(boolean recovered) throws IOException {
        JsonObject result = new JsonObject();
        result.addProperty("supported", isSupported() && processGate.isCoordinationAvailable());
        result.addProperty("platform", platform.name().toLowerCase());
        result.addProperty("wsl", wsl);
        result.addProperty("homeDirectory", userHome.toString());
        result.addProperty("recovered", recovered);
        if (wsl) {
            result.addProperty("error", "WSL_NOT_SUPPORTED");
        } else if (!isSupported()) {
            result.addProperty("error", "PLATFORM_NOT_SUPPORTED");
        } else if (!processGate.isCoordinationAvailable()) {
            result.addProperty("error", "AI_DATA_COORDINATION_UNAVAILABLE");
        }

        JsonArray entries = new JsonArray();
        Path commonRoot = null;
        boolean commonRootAvailable = true;
        for (String id : DATA_HOME_IDS) {
            JsonObject entry = inspectEntry(id);
            entries.add(entry);
            if (!"linked".equals(entry.get("state").getAsString())) {
                commonRootAvailable = false;
                continue;
            }
            Path physical = Path.of(entry.get("physicalPath").getAsString());
            Path parent = physical.getParent();
            if (parent == null || (commonRoot != null && !commonRoot.equals(parent))) {
                commonRootAvailable = false;
            } else if (commonRoot == null) {
                commonRoot = parent;
            }
        }
        result.add("directories", entries);
        if (commonRootAvailable && commonRoot != null) {
            result.addProperty("storageRoot", commonRoot.toString());
        }
        JsonArray backups = stateStore.readBackupRecords();
        result.add("backups", backups);
        result.addProperty("backupCount", backups.size());
        return result;
    }

    private JsonObject buildBusySnapshot() throws IOException {
        JsonObject result = buildSnapshot(false);
        result.addProperty("migrationInProgress", true);
        JsonObject owner = migrationCoordinator.readActiveOwner();
        if (owner != null) {
            result.add("migrationOwner", owner);
        } else {
            result.addProperty("migrationInProgress", false);
            result.addProperty("error", "AI_PROCESSES_ACTIVE");
            return result;
        }
        result.addProperty("error", "AI_DATA_MIGRATION_ACTIVE");
        return result;
    }

    private Path canonicalPath(String id) {
        return userHome.resolve("." + id).normalize();
    }

    private void createPlatformLink(Path canonical, Path target) throws IOException {
        AiDataDirectoryLinks.createPlatformLink(canonical, target, platform);
    }

    static boolean isDirectDirectoryLink(Path path) throws IOException {
        return AiDataDirectoryLinks.isDirectDirectoryLink(path);
    }

    private Map<Path, Path> copyDirectory(Path source, Path target, CancellationChecker cancellationChecker) throws IOException {
        return AiDataTreeOperations.copyDirectory(source, target, cancellationChecker, this::createPlatformLink);
    }

    static Map<String, ManifestEntry> buildManifest(Path root) throws IOException {
        return AiDataTreeOperations.buildManifest(root);
    }

    private static Map<String, ManifestEntry> buildDataManifest(Path root) throws IOException {
        return AiDataTreeOperations.buildDataManifest(root);
    }

    private static Map<String, ManifestEntry> buildDataManifest(Path root, CancellationChecker cancellationChecker) throws IOException {
        return AiDataTreeOperations.buildDataManifest(root, cancellationChecker);
    }

    private static Map<String, ManifestEntry> buildDataManifest(Path root, Path originalRoot, Path relocatedRoot) throws IOException {
        return AiDataTreeOperations.buildDataManifest(root, originalRoot, relocatedRoot);
    }

    private static Map<String, ManifestEntry> buildDataManifest(
            Path root, Path originalRoot, Path relocatedRoot, CancellationChecker cancellationChecker) throws IOException {
        return AiDataTreeOperations.buildDataManifest(root, originalRoot, relocatedRoot, cancellationChecker);
    }

    static void deleteTree(Path root) throws IOException {
        AiDataTreeOperations.deleteTree(root);
    }

    static void deleteTree(Path root, PathDeleter pathDeleter) throws IOException {
        AiDataTreeOperations.deleteTree(root, pathDeleter);
    }

    static void deleteWritablePath(Path path) throws IOException {
        AiDataTreeOperations.deleteWritablePath(path);
    }

    private static void move(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(source, target);
        }
    }

    private static boolean isDirectoryEmpty(Path directory) throws IOException {
        try (java.util.stream.Stream<Path> children = Files.list(directory)) {
            return children.findAny().isEmpty();
        }
    }

    private static JsonObject operationResult(String operation, boolean success, String error, JsonObject status) {
        JsonObject result = new JsonObject();
        result.addProperty("operation", operation);
        result.addProperty("success", success);
        if (error != null) {
            result.addProperty("error", error);
        }
        result.add("status", status);
        return result;
    }

    private static int phaseOrder(String phase) {
        try {
            return Phase.valueOf(phase).ordinal();
        } catch (RuntimeException error) {
            return 0;
        }
    }

    static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }

    private static Path defaultCoordinationDirectory() {
        return AiDataMigrationCoordinator.defaultCoordinationDirectory();
    }

    private static Path defaultLegacyStateDirectory() {
        return Path.of(PathManager.getSystemPath(), "cc-gui", "ai-data-storage").toAbsolutePath().normalize();
    }

    interface DirectoryLinkCreator {
        void create(Path canonical, Path target) throws IOException;
    }

    interface PathDeleter {
        void delete(Path path) throws IOException;
    }

    @FunctionalInterface
    interface CancellationChecker {
        void check() throws IOException;
    }

    static final class ManifestEntry {
        private final String type;
        private final long size;
        private final String fingerprint;

        ManifestEntry(String type, long size, String fingerprint) {
            this.type = type;
            this.size = size;
            this.fingerprint = fingerprint;
        }

        @Override
        public boolean equals(Object value) {
            if (this == value) {
                return true;
            }
            if (!(value instanceof ManifestEntry other)) {
                return false;
            }
            return size == other.size && Objects.equals(type, other.type)
                    && Objects.equals(fingerprint, other.fingerprint);
        }

        @Override
        public int hashCode() {
            return Objects.hash(type, size, fingerprint);
        }
    }

    enum SourceKind {
        LOCAL,
        LINKED,
        MISSING
    }

    enum Phase {
        INITIAL,
        TARGET_READY,
        SOURCE_DETACHED,
        LINKED
    }

    public static final class AiDataDirectoryException extends IOException {
        private final JsonObject details;

        public AiDataDirectoryException(String message) {
            this(message, null, null);
        }

        public AiDataDirectoryException(String message, JsonObject details) {
            this(message, null, details);
        }

        public AiDataDirectoryException(String message, Throwable cause) {
            this(message, cause, null);
        }

        private AiDataDirectoryException(String message, Throwable cause, JsonObject details) {
            super(message, cause);
            this.details = details;
        }

        public JsonObject getDetails() {
            return details;
        }
    }
}
