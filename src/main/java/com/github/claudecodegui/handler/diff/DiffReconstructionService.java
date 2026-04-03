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

    /**
     * Reconstruct full-file before/after content for a single edit (show_diff / show_edit_full_diff).
     *
     * @param filePath   path to the file on disk
     * @param oldString  the old content fragment (before edit)
     * @param newString  the new content fragment (after edit)
     * @param replaceAll whether this is a replace-all operation
     * @return reconstruction result (full-file or fragment fallback)
     */
    @NotNull
    public static DiffReconstructionResult reconstruct(
            @NotNull String filePath,
            @NotNull String oldString,
            @NotNull String newString,
            boolean replaceAll
    ) {
        return reconstruct(filePath, oldString, newString, replaceAll, null);
    }

    /**
     * Reconstruct full-file before/after content for a single edit.
     * If originalContent is provided (cached full file), use it directly.
     *
     * @param filePath        path to the file on disk
     * @param oldString       the old content fragment (before edit)
     * @param newString       the new content fragment (after edit)
     * @param replaceAll      whether this is a replace-all operation
     * @param originalContent cached original file content (may be null)
     * @return reconstruction result (full-file or fragment fallback)
     */
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

        // Read full file from disk
        String fileContent = readFileContent(filePath);
        if (fileContent == null) {
            LOG.info("File not found on disk, falling back to fragment diff: " + filePath);
            return DiffReconstructionResult.fragment(oldString, newString);
        }

        // Normalize all to LF
        String normalizedFile = LineSeparatorUtil.normalizeToLF(fileContent);
        String normalizedOld = LineSeparatorUtil.normalizeToLF(oldString);
        String normalizedNew = LineSeparatorUtil.normalizeToLF(newString);

        return reconstructFromFile(normalizedFile, normalizedOld, normalizedNew, replaceAll, filePath);
    }

    /**
     * Reconstruct using cached original content (before modifications).
     * originalContent is the full file before any edits were applied.
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

        // Both empty — no actual edit
        if (normalizedOld.isEmpty() && normalizedNew.isEmpty()) {
            return DiffReconstructionResult.fullFile(normalizedOriginal, normalizedOriginal);
        }

        if (replaceAll) {
            if (normalizedOld.isEmpty()) {
                // replaceAll with empty oldString is catastrophic — fallback
                LOG.warn("replaceAll with empty oldString, falling back to fragment: " + filePath);
                return DiffReconstructionResult.fragment(oldString, newString);
            }
            String afterContent = normalizedOriginal.replace(normalizedOld, normalizedNew);
            return DiffReconstructionResult.fullFile(normalizedOriginal, afterContent);
        }

        // Single replacement
        if (!normalizedOld.isEmpty()) {
            int index = normalizedOriginal.indexOf(normalizedOld);
            if (index >= 0) {
                // Uniqueness check: multiple occurrences → ambiguous
                if (normalizedOriginal.indexOf(normalizedOld, index + 1) >= 0) {
                    LOG.info("oldString appears multiple times in cached original, falling back to fragment: " + filePath);
                    return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
                }
                String afterContent = normalizedOriginal.substring(0, index)
                        + normalizedNew
                        + normalizedOriginal.substring(index + normalizedOld.length());
                return DiffReconstructionResult.fullFile(normalizedOriginal, afterContent);
            }
        } else {
            // Pure insertion (oldString empty, newString non-empty)
            // Cannot determine insertion position from cached original — use file on disk
            String fileContent = readFileContent(filePath);
            if (fileContent != null) {
                String normalizedFile = LineSeparatorUtil.normalizeToLF(fileContent);
                return handleInsertion(normalizedFile, normalizedNew, filePath);
            }
        }

        // oldString not found in cached original — try reading current file from disk
        String fileContent = readFileContent(filePath);
        if (fileContent != null) {
            String normalizedFile = LineSeparatorUtil.normalizeToLF(fileContent);
            return reconstructFromFile(normalizedFile, normalizedOld, normalizedNew, false, filePath);
        }

        LOG.warn("oldString not found in cached original, falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(oldString, newString);
    }

    /**
     * Core reconstruction logic from the current file on disk.
     * Deterministic exact-match only.
     */
    @NotNull
    private static DiffReconstructionResult reconstructFromFile(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String normalizedNew,
            boolean replaceAll,
            @NotNull String filePath
    ) {
        // Both empty — nothing to diff
        if (normalizedOld.isEmpty() && normalizedNew.isEmpty()) {
            return DiffReconstructionResult.fullFile(normalizedFile, normalizedFile);
        }

        // replaceAll branch
        if (replaceAll) {
            return handleReplaceAll(normalizedFile, normalizedOld, normalizedNew, filePath);
        }

        // Both non-empty: normal replacement
        if (!normalizedOld.isEmpty() && !normalizedNew.isEmpty()) {
            return handleReplacement(normalizedFile, normalizedOld, normalizedNew, filePath);
        }

        // Pure insertion: oldString empty, newString non-empty
        if (normalizedOld.isEmpty()) {
            return handleInsertion(normalizedFile, normalizedNew, filePath);
        }

        // Pure deletion: oldString non-empty, newString empty
        return handleDeletion(normalizedFile, normalizedOld, filePath);
    }

    /**
     * Handle replaceAll operation.
     * Only the forward direction (oldString → newString) is safe.
     * Reverse direction (newString → oldString) is NOT safe because we cannot
     * distinguish pre-existing newString instances from edit-created ones.
     */
    @NotNull
    private static DiffReconstructionResult handleReplaceAll(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String normalizedNew,
            @NotNull String filePath
    ) {
        if (normalizedOld.isEmpty()) {
            // replaceAll with empty oldString is catastrophic
            LOG.warn("replaceAll with empty oldString, falling back to fragment: " + filePath);
            return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
        }

        // Only forward direction: oldString still in file (not yet applied)
        if (normalizedFile.contains(normalizedOld)) {
            String afterContent = normalizedFile.replace(normalizedOld, normalizedNew);
            LOG.info("replaceAll: oldString found in file (not yet applied): " + filePath);
            return DiffReconstructionResult.fullFile(normalizedFile, afterContent);
        }

        // Reverse direction is unsafe — cannot distinguish original vs edit-created newString.
        // Fall back to fragment.
        LOG.info("replaceAll: oldString not found in file, falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
    }

    /**
     * Handle normal single replacement (both old and new non-empty).
     * Uses count-based state detection instead of priority-based matching:
     * <ul>
     *   <li>oldCount==1, newCount==0 → edit not yet applied, safe to reconstruct</li>
     *   <li>oldCount==0, newCount==1 → edit already applied, safe to reconstruct</li>
     *   <li>Any other combination → ambiguous, fall back to fragment</li>
     * </ul>
     */
    @NotNull
    private static DiffReconstructionResult handleReplacement(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String normalizedNew,
            @NotNull String filePath
    ) {
        int oldCount = countOccurrences(normalizedFile, normalizedOld);
        int newCount = countOccurrences(normalizedFile, normalizedNew);

        if (oldCount == 1 && newCount == 0) {
            // Edit not yet applied: oldString uniquely present, newString absent
            int oldIdx = normalizedFile.indexOf(normalizedOld);
            String afterContent = normalizedFile.substring(0, oldIdx)
                    + normalizedNew
                    + normalizedFile.substring(oldIdx + normalizedOld.length());
            LOG.info("Reconstructed full diff (old=1 new=0, edit not yet applied): " + filePath);
            return DiffReconstructionResult.fullFile(normalizedFile, afterContent);
        }

        if (oldCount == 0 && newCount == 1) {
            // Edit already applied: newString uniquely present, oldString absent
            int newIdx = normalizedFile.indexOf(normalizedNew);
            String beforeContent = normalizedFile.substring(0, newIdx)
                    + normalizedOld
                    + normalizedFile.substring(newIdx + normalizedNew.length());
            LOG.info("Reconstructed full diff (old=0 new=1, edit already applied): " + filePath);
            return DiffReconstructionResult.fullFile(beforeContent, normalizedFile);
        }

        // Any other combination is ambiguous
        LOG.info("Ambiguous state (old=" + oldCount + " new=" + newCount
                + "), falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(normalizedOld, normalizedNew);
    }

    /**
     * Count non-overlapping occurrences of target in text.
     */
    private static int countOccurrences(@NotNull String text, @NotNull String target) {
        if (target.isEmpty()) return 0;
        int count = 0;
        int idx = 0;
        while ((idx = text.indexOf(target, idx)) >= 0) {
            count++;
            idx += target.length();
        }
        return count;
    }

    /**
     * Handle pure insertion (oldString empty, newString non-empty).
     * Requires uniqueness: if newString appears more than once, ambiguous.
     */
    @NotNull
    private static DiffReconstructionResult handleInsertion(
            @NotNull String normalizedFile,
            @NotNull String normalizedNew,
            @NotNull String filePath
    ) {
        // newString found in file — insertion already applied, reconstruct before by removing it
        int newIdx = normalizedFile.indexOf(normalizedNew);
        if (newIdx >= 0) {
            // Uniqueness check
            if (normalizedFile.indexOf(normalizedNew, newIdx + 1) >= 0) {
                LOG.info("Insertion newString appears multiple times, falling back to fragment: " + filePath);
                return DiffReconstructionResult.fragment("", normalizedNew);
            }
            String beforeContent = normalizedFile.substring(0, newIdx)
                    + normalizedFile.substring(newIdx + normalizedNew.length());
            LOG.info("Insertion already applied, reconstructed before (unique match): " + filePath);
            return DiffReconstructionResult.fullFile(beforeContent, normalizedFile);
        }

        // newString not found — cannot determine where insertion goes, fallback to fragment
        LOG.info("Insertion newString not found in file, falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment("", normalizedNew);
    }

    /**
     * Handle pure deletion (oldString non-empty, newString empty).
     * Requires uniqueness: if oldString appears more than once, ambiguous.
     */
    @NotNull
    private static DiffReconstructionResult handleDeletion(
            @NotNull String normalizedFile,
            @NotNull String normalizedOld,
            @NotNull String filePath
    ) {
        // oldString found in file — deletion not yet applied
        int oldIdx = normalizedFile.indexOf(normalizedOld);
        if (oldIdx >= 0) {
            // Uniqueness check
            if (normalizedFile.indexOf(normalizedOld, oldIdx + 1) >= 0) {
                LOG.info("Deletion oldString appears multiple times, falling back to fragment: " + filePath);
                return DiffReconstructionResult.fragment(normalizedOld, "");
            }
            String afterContent = normalizedFile.substring(0, oldIdx)
                    + normalizedFile.substring(oldIdx + normalizedOld.length());
            LOG.info("Deletion not yet applied, reconstructed after (unique match): " + filePath);
            return DiffReconstructionResult.fullFile(normalizedFile, afterContent);
        }

        // oldString not in file — already deleted, fallback to fragment
        LOG.info("Deletion oldString not found in file (already deleted), falling back to fragment: " + filePath);
        return DiffReconstructionResult.fragment(normalizedOld, "");
    }

    /**
     * Read file content from disk via VirtualFile.
     *
     * @return file content as string, or null if file doesn't exist or can't be read
     */
    @Nullable
    private static String readFileContent(@NotNull String filePath) {
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
