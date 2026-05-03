package com.github.claudecodegui.service;

import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.LanguageConfigService;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Auto-commit coordinator with turn-level merge semantics.
 *
 * <p>Each turn captures a "before" snapshot and commits only the turn delta.
 * For same-file concurrent edits, it performs a 3-way merge using:
 * current working tree as ours + turn before snapshot as base + turn after snapshot as theirs.
 */
public final class AutoCommitService {

    private static final Logger LOG = Logger.getInstance(AutoCommitService.class);
    private static final int COMMAND_TIMEOUT_SECONDS = 30;

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(
            new DaemonThreadFactory("ccg-auto-commit")
    );

    private AutoCommitService() {
    }

    public static final class TurnCapture {
        private final Path repoRoot;
        private final String beforeSnapshotRef;

        private TurnCapture(@NotNull Path repoRoot, @NotNull String beforeSnapshotRef) {
            this.repoRoot = repoRoot;
            this.beforeSnapshotRef = beforeSnapshotRef;
        }
    }

    private static final class TurnFileSnapshot {
        private final boolean exists;
        private final String content;

        private TurnFileSnapshot(boolean exists, @Nullable String content) {
            this.exists = exists;
            this.content = content;
        }
    }

    private enum MergeResult {
        MERGED,
        UNCHANGED,
        CONFLICT
    }

    public static TurnCapture beginTurnCapture(@Nullable String cwd) {
        if (cwd == null || cwd.trim().isEmpty()) {
            return null;
        }
        Path repoRoot = resolveRepoRoot(cwd);
        if (repoRoot == null) {
            return null;
        }
        String before = snapshotOrHead(repoRoot);
        if (before == null || before.isBlank()) {
            return null;
        }
        return new TurnCapture(repoRoot, before);
    }

    public static void scheduleIfEnabled(
            @Nullable Project project,
            @Nullable String cwd,
            @Nullable String provider,
            @Nullable String sessionId,
            @Nullable TurnCapture turnCapture,
            @Nullable Set<String> touchedFiles
    ) {
        boolean enabled;
        try {
            enabled = new CodemossSettingsService().getAutoCommitEnabled();
        } catch (Exception e) {
            LOG.warn("[AutoCommit] Failed to read auto commit setting: " + e.getMessage());
            return;
        }
        if (!enabled) {
            return;
        }

        Path repoRoot = null;
        String beforeRef = null;
        if (turnCapture != null) {
            repoRoot = turnCapture.repoRoot;
            beforeRef = turnCapture.beforeSnapshotRef;
        }

        if (repoRoot == null && cwd != null && !cwd.trim().isEmpty()) {
            repoRoot = resolveRepoRoot(cwd);
        }
        if (repoRoot == null) {
            return;
        }
        if (beforeRef == null || beforeRef.isBlank()) {
            beforeRef = snapshotOrHead(repoRoot);
        }
        if (beforeRef == null || beforeRef.isBlank()) {
            return;
        }

        String afterRef = snapshotOrHead(repoRoot);
        if (afterRef == null || afterRef.isBlank()) {
            return;
        }

        Set<String> touchedCopy = new LinkedHashSet<>();
        Map<String, TurnFileSnapshot> touchedSnapshots = new LinkedHashMap<>();
        if (touchedFiles != null) {
            for (String raw : touchedFiles) {
                String normalized = normalizeRepoRelativePath(repoRoot, raw);
                if (normalized == null || normalized.isBlank()) {
                    continue;
                }
                touchedCopy.add(normalized);
                Path file = repoRoot.resolve(normalized).normalize();
                if (Files.exists(file)) {
                    touchedSnapshots.put(normalized, new TurnFileSnapshot(true, readWorkingFile(file)));
                } else {
                    touchedSnapshots.put(normalized, new TurnFileSnapshot(false, null));
                }
            }
        }

        final Path finalRepoRoot = repoRoot;
        final String finalBeforeRef = beforeRef;
        final String finalAfterRef = afterRef;
        EXECUTOR.execute(() -> performTurnCommit(
                project,
                finalRepoRoot,
                finalBeforeRef,
                finalAfterRef,
                provider,
                sessionId,
                touchedCopy,
                touchedSnapshots
        ));
    }

    private static void performTurnCommit(
            @Nullable Project project,
            @NotNull Path repoRoot,
            @NotNull String beforeRef,
            @NotNull String afterRef,
            @Nullable String provider,
            @Nullable String sessionId,
            @NotNull Set<String> touchedFiles,
            @NotNull Map<String, TurnFileSnapshot> touchedSnapshots
    ) {
        if (beforeRef.equals(afterRef)) {
            return;
        }

        boolean autoResolveConflicts = false;
        try {
            autoResolveConflicts = new CodemossSettingsService().getAutoResolveConflictsEnabled();
        } catch (Exception e) {
            LOG.debug("[AutoCommit] Failed to read auto resolve conflict setting: " + e.getMessage());
        }

        List<String> changedFiles = listChangedFilesBetweenSnapshots(repoRoot, beforeRef, afterRef, touchedFiles);
        if (changedFiles.isEmpty()) {
            return;
        }

        List<String> changedByMerge = new ArrayList<>();
        List<String> conflictFiles = new ArrayList<>();
        for (String file : changedFiles) {
            MergeResult mergeResult = mergeFileFromTurnSnapshot(
                    repoRoot,
                    file,
                    beforeRef,
                    afterRef,
                    autoResolveConflicts,
                    touchedSnapshots.get(file)
            );
            if (mergeResult == MergeResult.MERGED) {
                changedByMerge.add(file);
            } else if (mergeResult == MergeResult.CONFLICT) {
                conflictFiles.add(file);
            }
        }

        if (!conflictFiles.isEmpty()) {
            String firstConflict = conflictFiles.get(0);
            String conflictMsg = autoResolveConflicts
                    ? "Auto commit paused: unresolved conflict in " + firstConflict
                    : "Auto commit paused: conflict in " + firstConflict + " (enable auto-resolve to merge)";
            LOG.info("[AutoCommit] " + conflictMsg);
            if (project != null) {
                ClaudeNotifier.showWarning(project, conflictMsg);
            }
            return;
        }

        if (changedByMerge.isEmpty()) {
            return;
        }

        CommandResult add = runGit(repoRoot, buildArgsWithPaths("add", changedByMerge));
        if (!add.isSuccess()) {
            LOG.warn("[AutoCommit] git add failed: " + add.output());
            if (project != null) {
                ClaudeNotifier.showWarning(project, "Auto commit failed: git add error");
            }
            return;
        }

        CommandResult stagedCheck = runGit(repoRoot, "diff", "--cached", "--quiet");
        if (stagedCheck.exitCode == 0) {
            return;
        }
        if (stagedCheck.exitCode > 1) {
            LOG.warn("[AutoCommit] staged diff check failed: " + stagedCheck.output());
            if (project != null) {
                ClaudeNotifier.showWarning(project, "Auto commit failed: staged diff check error");
            }
            return;
        }

        // Guardrail: block commit if files are contaminated by timeout marker lines.
        // Keep the command exact for consistency with team workflow:
        // git grep -n "^command timed out$" -- .
        CommandResult timeoutMarkerCheck = runGit(repoRoot, "grep", "-n", "^command timed out$", "--", ".");
        if (timeoutMarkerCheck.exitCode == 0) {
            String firstMatch = firstLine(timeoutMarkerCheck.output());
            String warning = "Auto commit blocked: found timeout marker contamination"
                    + (firstMatch.isBlank() ? "" : " (" + firstMatch + ")");
            LOG.warn("[AutoCommit] " + warning);
            if (project != null) {
                ClaudeNotifier.showWarning(project, warning);
            }
            return;
        }
        if (timeoutMarkerCheck.exitCode > 1) {
            LOG.warn("[AutoCommit] timeout marker check failed: " + timeoutMarkerCheck.output());
            if (project != null) {
                ClaudeNotifier.showWarning(project, "Auto commit failed: timeout marker check error");
            }
            return;
        }

        String commitMessage = buildCommitMessage(provider, sessionId, changedByMerge.size());
        CommandResult commit = runGit(repoRoot, "commit", "-m", commitMessage);
        if (!commit.isSuccess()) {
            LOG.info("[AutoCommit] git commit skipped/failed: " + commit.output());
            if (project != null) {
                ClaudeNotifier.showWarning(project, "Auto commit skipped: " + firstLine(commit.output()));
            }
            return;
        }

        CommandResult hash = runGit(repoRoot, "rev-parse", "--short", "HEAD");
        String shortHash = hash.isSuccess() ? firstLine(hash.output()) : "";
        if (project != null) {
            String suffix = shortHash.isBlank() ? "" : " (" + shortHash + ")";
            ClaudeNotifier.showSuccess(project, "Auto commit created" + suffix);
        }
    }

    private static MergeResult mergeFileFromTurnSnapshot(
            @NotNull Path repoRoot,
            @NotNull String repoRelativePath,
            @NotNull String beforeRef,
            @NotNull String afterRef,
            boolean autoResolveConflicts,
            @Nullable TurnFileSnapshot fallbackTurnSnapshot
    ) {
        String normalizedPath = normalizeRepoRelativePath(repoRoot, repoRelativePath);
        if (normalizedPath == null || normalizedPath.isBlank()) {
            return MergeResult.UNCHANGED;
        }

        boolean baseExists = blobExists(repoRoot, beforeRef, normalizedPath);
        boolean turnBlobExists = blobExists(repoRoot, afterRef, normalizedPath);
        boolean turnFallbackExists = fallbackTurnSnapshot != null && fallbackTurnSnapshot.exists;
        boolean turnExists = turnBlobExists || turnFallbackExists;

        Path absolutePath = repoRoot.resolve(normalizedPath).normalize();
        boolean currentExists = Files.exists(absolutePath);

        String baseContent = baseExists ? readBlobText(repoRoot, beforeRef, normalizedPath) : null;
        String turnContent = turnBlobExists
                ? readBlobText(repoRoot, afterRef, normalizedPath)
                : (turnFallbackExists ? fallbackTurnSnapshot.content : null);
        String currentContent = currentExists ? readWorkingFile(absolutePath) : null;

        if (!turnExists) {
            if (!currentExists) {
                return MergeResult.UNCHANGED;
            }
            if (!baseExists) {
                return MergeResult.UNCHANGED;
            }
            if (safeEquals(currentContent, baseContent)) {
                try {
                    Files.deleteIfExists(absolutePath);
                    return MergeResult.MERGED;
                } catch (Exception e) {
                    LOG.warn("[AutoCommit] Failed to delete file during merge: " + absolutePath + " " + e.getMessage());
                    return MergeResult.CONFLICT;
                }
            }
            return autoResolveConflicts ? MergeResult.UNCHANGED : MergeResult.CONFLICT;
        }

        if (!baseExists) {
            if (!currentExists) {
                return writeWorkingFile(absolutePath, turnContent) ? MergeResult.MERGED : MergeResult.CONFLICT;
            }
            if (safeEquals(currentContent, turnContent)) {
                return MergeResult.UNCHANGED;
            }
            if (!autoResolveConflicts) {
                return MergeResult.CONFLICT;
            }
            String merged = runThreeWayMerge(repoRoot, currentContent, "", turnContent, true);
            if (merged == null || containsConflictMarker(merged)) {
                return MergeResult.CONFLICT;
            }
            return writeWorkingFile(absolutePath, merged) ? MergeResult.MERGED : MergeResult.CONFLICT;
        }

        if (!currentExists) {
            if (safeEquals(baseContent, turnContent)) {
                return MergeResult.UNCHANGED;
            }
            if (!autoResolveConflicts) {
                return MergeResult.CONFLICT;
            }
            return writeWorkingFile(absolutePath, turnContent) ? MergeResult.MERGED : MergeResult.CONFLICT;
        }

        if (safeEquals(currentContent, turnContent)) {
            return MergeResult.UNCHANGED;
        }
        if (safeEquals(currentContent, baseContent)) {
            return writeWorkingFile(absolutePath, turnContent) ? MergeResult.MERGED : MergeResult.CONFLICT;
        }

        String merged = runThreeWayMerge(repoRoot, currentContent, baseContent, turnContent, false);
        if (merged != null && !containsConflictMarker(merged)) {
            return writeWorkingFile(absolutePath, merged) ? MergeResult.MERGED : MergeResult.CONFLICT;
        }
        if (!autoResolveConflicts) {
            return MergeResult.CONFLICT;
        }

        String unionMerged = runThreeWayMerge(repoRoot, currentContent, baseContent, turnContent, true);
        if (unionMerged != null && !containsConflictMarker(unionMerged)) {
            return writeWorkingFile(absolutePath, unionMerged) ? MergeResult.MERGED : MergeResult.CONFLICT;
        }

        return MergeResult.CONFLICT;
    }

    private static String runThreeWayMerge(
            @NotNull Path repoRoot,
            @Nullable String currentContent,
            @Nullable String baseContent,
            @Nullable String turnContent,
            boolean unionMode
    ) {
        Path tempDir = null;
        try {
            tempDir = Files.createTempDirectory("ccg-auto-merge-");
            Path ours = tempDir.resolve("ours.txt");
            Path base = tempDir.resolve("base.txt");
            Path theirs = tempDir.resolve("theirs.txt");

            Files.writeString(ours, currentContent == null ? "" : currentContent, StandardCharsets.UTF_8);
            Files.writeString(base, baseContent == null ? "" : baseContent, StandardCharsets.UTF_8);
            Files.writeString(theirs, turnContent == null ? "" : turnContent, StandardCharsets.UTF_8);

            List<String> args = new ArrayList<>();
            args.add("merge-file");
            if (unionMode) {
                args.add("--union");
            }
            args.add("-p");
            args.add(ours.toString());
            args.add(base.toString());
            args.add(theirs.toString());

            CommandResult result = runGit(repoRoot, args);
            if (result.exitCode == 0) {
                return result.output();
            }
            if (unionMode && !result.output().isBlank()) {
                return result.output();
            }
            return null;
        } catch (Exception e) {
            LOG.debug("[AutoCommit] runThreeWayMerge failed: " + e.getMessage());
            return null;
        } finally {
            deleteTempDirectory(tempDir);
        }
    }

    private static void deleteTempDirectory(@Nullable Path dir) {
        if (dir == null) {
            return;
        }
        try {
            Files.deleteIfExists(dir.resolve("ours.txt"));
            Files.deleteIfExists(dir.resolve("base.txt"));
            Files.deleteIfExists(dir.resolve("theirs.txt"));
            Files.deleteIfExists(dir);
        } catch (Exception ignored) {
        }
    }

    private static boolean containsConflictMarker(@NotNull String text) {
        return text.contains("<<<<<<<") || text.contains("=======") || text.contains(">>>>>>>");
    }

    private static boolean writeWorkingFile(@NotNull Path file, @Nullable String content) {
        try {
            Path parent = file.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            Files.writeString(file, content == null ? "" : content, StandardCharsets.UTF_8);
            return true;
        } catch (Exception e) {
            LOG.warn("[AutoCommit] Failed to write merged file: " + file + " " + e.getMessage());
            return false;
        }
    }

    @Nullable
    private static String readWorkingFile(@NotNull Path file) {
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (Exception e) {
            LOG.debug("[AutoCommit] Failed to read working file: " + file + " " + e.getMessage());
            return null;
        }
    }

    private static boolean blobExists(@NotNull Path repoRoot, @NotNull String ref, @NotNull String repoRelativePath) {
        CommandResult result = runGit(repoRoot, "cat-file", "-e", ref + ":" + repoRelativePath);
        return result.isSuccess();
    }

    @Nullable
    private static String readBlobText(@NotNull Path repoRoot, @NotNull String ref, @NotNull String repoRelativePath) {
        CommandResult result = runGit(repoRoot, "show", ref + ":" + repoRelativePath);
        return result.isSuccess() ? result.output() : null;
    }

    @NotNull
    private static List<String> listChangedFilesBetweenSnapshots(
            @NotNull Path repoRoot,
            @NotNull String beforeRef,
            @NotNull String afterRef,
            @NotNull Set<String> touchedFiles
    ) {
        CommandResult diff = runGit(repoRoot, "diff", "--name-only", beforeRef, afterRef);
        if (!diff.isSuccess() || diff.output().isBlank()) {
            return new ArrayList<>();
        }

        List<String> changed = new ArrayList<>();
        for (String line : diff.output().split("\\R")) {
            String p = normalizeRepoRelativePath(repoRoot, line);
            if (p != null && !p.isBlank()) {
                changed.add(p);
            }
        }
        if (changed.isEmpty()) {
            return changed;
        }

        Set<String> normalizedTouched = new LinkedHashSet<>();
        for (String rawTouched : touchedFiles) {
            String normalized = normalizeRepoRelativePath(repoRoot, rawTouched);
            if (normalized != null && !normalized.isBlank()) {
                normalizedTouched.add(normalized);
            }
        }

        if (normalizedTouched.isEmpty()) {
            return changed;
        }

        List<String> filtered = new ArrayList<>();
        for (String file : changed) {
            if (normalizedTouched.contains(file)) {
                filtered.add(file);
            }
        }
        List<String> result = filtered.isEmpty() ? changed : filtered;
        for (String touched : normalizedTouched) {
            if (!result.contains(touched)) {
                result.add(touched);
            }
        }
        return result;
    }

    @Nullable
    private static String normalizeRepoRelativePath(@NotNull Path repoRoot, @Nullable String rawPath) {
        if (rawPath == null) {
            return null;
        }
        String cleaned = rawPath.trim();
        if (cleaned.isEmpty()) {
            return null;
        }
        if ((cleaned.startsWith("\"") && cleaned.endsWith("\""))
                || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
            cleaned = cleaned.substring(1, cleaned.length() - 1).trim();
        }
        if (cleaned.isEmpty()) {
            return null;
        }

        cleaned = cleaned.replace("\\", "/");
        while (cleaned.startsWith("./")) {
            cleaned = cleaned.substring(2);
        }

        try {
            Path candidate = Paths.get(cleaned);
            Path relative;

            if (candidate.isAbsolute()) {
                Path normalizedAbs = candidate.toAbsolutePath().normalize();
                if (!normalizedAbs.startsWith(repoRoot)) {
                    return null;
                }
                relative = repoRoot.relativize(normalizedAbs);
            } else {
                relative = candidate.normalize();
            }

            String result = relative.toString().replace("\\", "/");
            if (result.isEmpty() || result.startsWith("..")) {
                return null;
            }
            return result;
        } catch (Exception e) {
            return null;
        }
    }

    @Nullable
    private static Path resolveRepoRoot(@NotNull String cwd) {
        Path cwdPath;
        try {
            cwdPath = Paths.get(cwd).toAbsolutePath().normalize();
        } catch (Exception e) {
            return null;
        }

        CommandResult result = runGit(cwdPath, "rev-parse", "--show-toplevel");
        if (!result.isSuccess()) {
            return null;
        }

        String repoRoot = firstLine(result.output());
        if (repoRoot.isBlank()) {
            return null;
        }
        try {
            return Paths.get(repoRoot).toAbsolutePath().normalize();
        } catch (Exception e) {
            return null;
        }
    }

    @Nullable
    private static String snapshotOrHead(@NotNull Path repoRoot) {
        CommandResult snapshot = runGit(repoRoot, "stash", "create");
        if (snapshot.isSuccess()) {
            String snapRef = firstLine(snapshot.output());
            if (!snapRef.isBlank()) {
                return snapRef;
            }
        }
        CommandResult head = runGit(repoRoot, "rev-parse", "HEAD");
        if (head.isSuccess()) {
            String ref = firstLine(head.output());
            if (!ref.isBlank()) {
                return ref;
            }
        }
        return null;
    }

    @NotNull
    private static List<String> buildArgsWithPaths(@NotNull String command, @NotNull List<String> repoRelativePaths) {
        List<String> args = new ArrayList<>();
        args.add(command);
        args.add("--");
        args.addAll(repoRelativePaths);
        return args;
    }

    private static String buildCommitMessage(@Nullable String provider, @Nullable String sessionId, int fileCount) {
        String normalizedProvider = (provider == null || provider.isBlank()) ? "ai" : provider.trim();
        String sessionSuffix = "";
        if (sessionId != null && !sessionId.isBlank()) {
            String trimmed = sessionId.trim();
            sessionSuffix = trimmed.length() > 8 ? trimmed.substring(0, 8) : trimmed;
        }
        String currentLanguage = LanguageConfigService.getCurrentLanguage();
        try {
            currentLanguage = new CodemossSettingsService().getUiLanguage();
        } catch (Exception e) {
            LOG.debug("[AutoCommit] Failed to read ui language config: " + e.getMessage());
        }
        String base = ("zh".equals(currentLanguage) || "zh-TW".equals(currentLanguage))
                ? "chore(auto-commit): 应用 AI 改动"
                : "chore(auto-commit): apply AI changes";
        StringBuilder message = new StringBuilder(base);
        message.append(" [").append(normalizedProvider);
        if (!sessionSuffix.isBlank()) {
            message.append("/").append(sessionSuffix);
        }
        message.append("/").append(fileCount).append("f]");
        return message.toString();
    }

    private static boolean safeEquals(@Nullable String a, @Nullable String b) {
        if (a == null && b == null) {
            return true;
        }
        if (a == null || b == null) {
            return false;
        }
        return a.equals(b);
    }

    private static String firstLine(@Nullable String text) {
        if (text == null || text.isBlank()) {
            return "";
        }
        String[] lines = text.split("\\R");
        return lines.length == 0 ? "" : lines[0].trim();
    }

    private static CommandResult runGit(@NotNull Path workDir, @NotNull String... args) {
        List<String> command = new ArrayList<>();
        command.add("git");
        for (String arg : args) {
            command.add(arg);
        }
        return runCommand(workDir, command);
    }

    private static CommandResult runGit(@NotNull Path workDir, @NotNull List<String> args) {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.addAll(args);
        return runCommand(workDir, command);
    }

    private static CommandResult runCommand(@NotNull Path workDir, @NotNull List<String> command) {
        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(workDir.toFile());
            pb.redirectErrorStream(true);
            process = pb.start();

            boolean finished = process.waitFor(COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return CommandResult.timeout(command);
            }

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            return new CommandResult(process.exitValue(), output.toString(), command);
        } catch (Exception e) {
            return CommandResult.error(command, e);
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }

    private static final class CommandResult {
        private final int exitCode;
        private final String output;
        private final String commandSummary;
        private final Exception exception;

        private CommandResult(int exitCode, String output, List<String> command) {
            this(exitCode, output, String.join(" ", command), null);
        }

        private CommandResult(int exitCode, String output, String commandSummary, Exception exception) {
            this.exitCode = exitCode;
            this.output = output == null ? "" : output;
            this.commandSummary = commandSummary;
            this.exception = exception;
        }

        private static CommandResult timeout(List<String> command) {
            return new CommandResult(124, "command timed out", command);
        }

        private static CommandResult error(List<String> command, Exception e) {
            return new CommandResult(125, e.getMessage(), String.join(" ", command), e);
        }

        private boolean isSuccess() {
            return exitCode == 0;
        }

        private String output() {
            if (exception == null) {
                return output;
            }
            return output + " (" + commandSummary + ")";
        }
    }

    private static final class DaemonThreadFactory implements ThreadFactory {
        private final String name;

        private DaemonThreadFactory(String name) {
            this.name = name;
        }

        @Override
        public Thread newThread(@NotNull Runnable runnable) {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(true);
            return thread;
        }
    }
}
