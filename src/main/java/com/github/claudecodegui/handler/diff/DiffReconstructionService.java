package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.util.LineSeparatorUtil;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * Deterministic diff content reconstruction service.
 * <p>
 * Design principle: "可靠则全量，不可靠则回退局部"
 * (reliable = full file, unreliable = fallback to fragment).
 * <p>
 * Rules:
 * <ol>
 *   <li>Read the full file from disk</li>
 *   <li>Normalize all content to LF for consistent matching</li>
 *   <li>Try exact match only — no fuzzy/guessing logic</li>
 *   <li>If exact match fails, fall back to showing the fragment diff</li>
 * </ol>
 * <p>
 * Empty string guards are applied everywhere to prevent catastrophic
 * behavior from Java's {@code indexOf("")==0}, {@code contains("")==true},
 * and {@code replace("", x)} inserting between every character.
 */
public final class DiffReconstructionService {

    private static final Logger LOG = Logger.getInstance(DiffReconstructionService.class);

    private DiffReconstructionService() {
    }

    @NotNull
    public static DiffReconstructionResult reconstruct(
            @NotNull String filePath,
            @NotNull String oldString,
            @NotNull String newString,
            boolean replaceAll
    ) {
        return reconstruct(filePath, oldString, newString, replaceAll, null);
    }

    @NotNull
    public static DiffReconstructionResult reconstruct(
            @NotNull String filePath,
            @NotNull String oldString,
            @NotNull String newString,
            boolean replaceAll,
            @Nullable String originalContent
    ) {
        // If cached original content is provided and non-empty, use it directly
        if (originalContent != null && !originalContent.isEmpty()) {
            return reconstructFromOriginal(originalContent, oldString, newString, replaceAll, filePath);
        }

        // Read full file from disk — this is the single source of truth
        String rawDiskContent = readFileContent(filePath);
        if (rawDiskContent == null) {
            LOG.info("File not found on disk, falling back to fragment diff: " + filePath);
            return DiffReconstructionResult.fragment(oldString, newString);
        }

        String normalizedFile = LineSeparatorUtil.normalizeToLF(rawDiskContent);
        String normalizedOld = LineSeparatorUtil.normalizeToLF(oldString);
        String normalizedNew = LineSeparatorUtil.normalizeToLF(newString);

        return reconstructFromFile(normalizedFile, normalizedOld, normalizedNew, replaceAll, filePath, rawDiskContent);
    }

    /**
     * Reconstruct using cached original content (before modifications).
     */
    @NotNull
    private static DiffReconstructionResult reconstructFromOriginal(
            @NotNull String originalContent,
            @NotNull String oldString,
            @NotNull String newString,
            boolean replaceAll,
            @NotNull String filePath
    ) {
        String normalizedOriginal = LineSeparatorUtil.normalizeToLF(originalContent);
        String normalizedOld = LineSeparatorUtil.normalizeToLF(oldString);
        String normalizedNew = LineSeparatorUtil.normalizeToLF(newString);

        // Read current disk content for snapshot
        String rawDiskContent = readFileContent(filePath);

        if (normalizedOld.isEmpty() && normalizedNew.isEmpty()) {
            return DiffReconstructionResult.fullFile(normalizedOriginal, normalizedOriginal, rawDiskContent);
        }

        // Reconstruct afterContent from cached original
        String afterContent = null;

        if (replaceAll) {
            if (normalizedOld.isEmpty()) {
                LOG.warn("replaceAll with empty oldString, falling back to fragment: " + filePath);
                return DiffReconstructionResult.fragment(oldString, newString);
            }
            afterContent = normalizedOriginal.replace(normalizedOld, normalizedNew);
        } else if (!normalizedOld.isEmpty()) {
            int index = normalizedOriginal.indexOf(normalizedOld);
            if (index >= 0) {
                if (normalizedOriginal.indexOf(normalizedOld, index + 1) >= 0) {
                    LOG.info("oldString appears multiple times in cached original, falling back to fragment: " + filePath);
                    return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
                }
                afterContent = normalizedOriginal.substring(0, index)
                        + normalizedNew
                        + normalizedOriginal.substring(index + normalizedOld.length());
            }
        } else {
            // Pure insertion — use file on disk
            if (rawDiskContent != null) {
                String normalizedFile = LineSeparatorUtil.normalizeToLF(rawDiskContent);
                return handleInsertion(normalizedFile, normalizedNew, filePath, rawDiskContent);
            }
        }

        // If reconstruction succeeded, verify disk matches either before or after state.
        // Disk matching before = edit not yet applied; disk matching after = already applied.
        // Disk matching neither = external modification, unsafe to Apply.
        if (afterContent != null) {
            if (rawDiskContent != null) {
                String normalizedDisk = LineSeparatorUtil.normalizeToLF(rawDiskContent);
                if (!normalizedDisk.equals(normalizedOriginal) && !normalizedDisk.equals(afterContent)) {
                    LOG.warn("Disk matches neither before nor after state, falling back to fragment: " + filePath);
                    return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
                }
            }
            return DiffReconstructionResult.fullFile(normalizedOriginal, afterContent, rawDiskContent);
        }

        // oldString not found in cached original — try file on disk
        if (rawDiskContent != null) {
            String normalizedFile = LineSeparatorUtil.normalizeToLF(rawDiskContent);
            return reconstructFromFile(normalizedFile, normalizedOld, normalizedNew, false, filePath, rawDiskContent);
        }

        LOG.warn("oldString not found in cached original, falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(oldString, newString);
    }

    /**
     * Core reconstruction logic from the current file on disk.
     * rawDiskContent is the exact bytes read from disk (pre-normalization) — threaded into results for snapshot.
     */
    @NotNull
    private static DiffReconstructionResult reconstructFromFile(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String normalizedNew,
            boolean replaceAll,
            @NotNull String filePath,
            @NotNull String rawDiskContent
    ) {
        if (normalizedOld.isEmpty() && normalizedNew.isEmpty()) {
            return DiffReconstructionResult.fullFile(normalizedFile, normalizedFile, rawDiskContent);
        }

        if (replaceAll) {
            return handleReplaceAll(normalizedFile, normalizedOld, normalizedNew, filePath, rawDiskContent);
        }

        if (!normalizedOld.isEmpty() && !normalizedNew.isEmpty()) {
            return handleReplacement(normalizedFile, normalizedOld, normalizedNew, filePath, rawDiskContent);
        }

        if (normalizedOld.isEmpty()) {
            return handleInsertion(normalizedFile, normalizedNew, filePath, rawDiskContent);
        }

        return handleDeletion(normalizedFile, normalizedOld, filePath, rawDiskContent);
    }

    @NotNull
    private static DiffReconstructionResult handleReplaceAll(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String normalizedNew,
            @NotNull String filePath,
            @NotNull String rawDiskContent
    ) {
        if (normalizedOld.isEmpty()) {
            LOG.warn("replaceAll with empty oldString, falling back to fragment: " + filePath);
            return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
        }

        if (normalizedFile.contains(normalizedOld)) {
            String afterContent = normalizedFile.replace(normalizedOld, normalizedNew);
            LOG.info("replaceAll: oldString found in file (not yet applied): " + filePath);
            return DiffReconstructionResult.fullFile(normalizedFile, afterContent, rawDiskContent);
        }

        LOG.info("replaceAll: oldString not found in file, falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
    }

    @NotNull
    private static DiffReconstructionResult handleReplacement(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String normalizedNew,
            @NotNull String filePath,
            @NotNull String rawDiskContent
    ) {
        int oldCount = countOccurrences(normalizedFile, normalizedOld);
        int newCount = countOccurrences(normalizedFile, normalizedNew);

        if (oldCount == 1 && newCount == 0) {
            int oldIdx = normalizedFile.indexOf(normalizedOld);
            String afterContent = normalizedFile.substring(0, oldIdx)
                    + normalizedNew
                    + normalizedFile.substring(oldIdx + normalizedOld.length());
            LOG.info("Reconstructed full diff (old=1 new=0, edit not yet applied): " + filePath);
            return DiffReconstructionResult.fullFile(normalizedFile, afterContent, rawDiskContent);
        }

        if (oldCount == 0 && newCount == 1) {
            int newIdx = normalizedFile.indexOf(normalizedNew);
            String beforeContent = normalizedFile.substring(0, newIdx)
                    + normalizedOld
                    + normalizedFile.substring(newIdx + normalizedNew.length());
            LOG.info("Reconstructed full diff (old=0 new=1, edit already applied): " + filePath);
            return DiffReconstructionResult.fullFile(beforeContent, normalizedFile, rawDiskContent);
        }

        LOG.info("Ambiguous state (old=" + oldCount + " new=" + newCount
                + "), falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
    }

    private static int countOccurrences(@NotNull String text, @NotNull String target) {
        if (target.isEmpty()) return 0;
        int count = 0;
        int idx = 0;
        while ((idx = text.indexOf(target, idx)) >= 0) {
            count++;
            idx += 1;
        }
        return count;
    }

    @NotNull
    private static DiffReconstructionResult handleInsertion(
            @NotNull String normalizedFile,
            @NotNull String normalizedNew,
            @NotNull String filePath,
            @NotNull String rawDiskContent
    ) {
        int newIdx = normalizedFile.indexOf(normalizedNew);
        if (newIdx >= 0) {
            if (normalizedFile.indexOf(normalizedNew, newIdx + 1) >= 0) {
                LOG.info("Insertion newString appears multiple times, falling back to fragment: " + filePath);
                return DiffReconstructionResult.fragment("", normalizedNew);
            }
            String beforeContent = normalizedFile.substring(0, newIdx)
                    + normalizedFile.substring(newIdx + normalizedNew.length());
            LOG.info("Insertion already applied, reconstructed before (unique match): " + filePath);
            return DiffReconstructionResult.fullFile(beforeContent, normalizedFile, rawDiskContent);
        }

        LOG.info("Insertion newString not found in file, falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment("", normalizedNew);
    }

    @NotNull
    private static DiffReconstructionResult handleDeletion(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String filePath,
            @NotNull String rawDiskContent
    ) {
        int oldIdx = normalizedFile.indexOf(normalizedOld);
        if (oldIdx >= 0) {
            if (normalizedFile.indexOf(normalizedOld, oldIdx + 1) >= 0) {
                LOG.info("Deletion oldString appears multiple times, falling back to fragment: " + filePath);
                return DiffReconstructionResult.fragment(normalizedOld, "");
            }
            String afterContent = normalizedFile.substring(0, oldIdx)
                    + normalizedFile.substring(oldIdx + normalizedOld.length());
            LOG.info("Deletion not yet applied, reconstructed after (unique match): " + filePath);
            return DiffReconstructionResult.fullFile(normalizedFile, afterContent, rawDiskContent);
        }

        LOG.info("Deletion oldString not found in file (already deleted), falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(normalizedOld, "");
    }

    /**
     * Read file content from disk via VirtualFile.
     * Package-visible so that AdjustableDiffManager can use it for Apply-time comparison.
     */
    @Nullable
    static String readFileContent(@NotNull String filePath) {
        try {
            VirtualFile file = LocalFileSystem.getInstance()
                    .refreshAndFindFileByPath(filePath.replace('\\', '/'));
            if (file != null && file.exists() && !file.isDirectory()) {
                file.refresh(false, false);
                Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;
                return new String(file.contentsToByteArray(), charset);
            }
        } catch (IOException e) {
            LOG.warn("Failed to read file: " + filePath, e);
        }
        return null;
    }
}
