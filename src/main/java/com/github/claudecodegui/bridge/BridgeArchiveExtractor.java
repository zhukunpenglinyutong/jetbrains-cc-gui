package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.util.io.FileUtil;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Handles ai-bridge archive extraction (system unzip with Java fallback) and
 * directory deletion. ZipSlip defenses are preserved verbatim from the original
 * implementation.
 *
 * <p>Package-private helper extracted from {@link BridgeDirectoryResolver}.
 */
final class BridgeArchiveExtractor {

    private static final Logger LOG = Logger.getInstance(BridgeArchiveExtractor.class);

    private BridgeArchiveExtractor() {
    }

    static void deleteDirectory(File dir) {
        if (dir == null || !dir.exists()) {
            return;
        }
        // Use retry mechanism for directory deletion to handle Windows file locking issues
        if (!PlatformUtils.deleteDirectoryWithRetry(dir, 3)) {
            // If retry fails, fall back to IntelliJ's FileUtil
            if (!FileUtil.delete(dir)) {
                LOG.warn("[BridgeResolver] Cannot delete directory: " + dir.getAbsolutePath());
            }
        }
    }

    static void unzipArchive(File archiveFile, File targetDir) throws IOException {
        Files.createDirectories(targetDir.toPath());

        // Try to use system unzip command to preserve permissions
        if (trySystemUnzip(archiveFile, targetDir)) {
            LOG.info("[BridgeResolver] Successfully extracted using system unzip command");
            return;
        }

        // Fallback to Java ZipInputStream
        LOG.warn("[BridgeResolver] System unzip not available, using Java ZipInputStream (permissions may be lost)");
        unzipWithJava(archiveFile, targetDir);
    }

    /**
     * Unzip archive with progress indicator support.
     * This method counts total entries first, then updates progress during extraction.
     */
    static void unzipArchiveWithProgress(File archiveFile, File targetDir, ProgressIndicator indicator) throws IOException {
        Files.createDirectories(targetDir.toPath());

        // Try to use system unzip command first
        if (trySystemUnzipWithProgress(archiveFile, targetDir, indicator)) {
            LOG.info("[BridgeResolver] Successfully extracted using system unzip command");
            return;
        }

        // Fallback to Java ZipInputStream
        LOG.warn("[BridgeResolver] System unzip not available, using Java ZipInputStream (permissions may be lost)");
        unzipWithJavaAndProgress(archiveFile, targetDir, indicator);
    }

    /**
     * Try to extract using system unzip command to preserve file permissions.
     * Returns true if successful, false if unzip command is not available.
     */
    private static boolean trySystemUnzip(File archiveFile, File targetDir) {
        return executeSystemUnzip(archiveFile, targetDir, null);
    }

    /**
     * Try to extract using system unzip command with progress updates.
     */
    private static boolean trySystemUnzipWithProgress(File archiveFile, File targetDir, ProgressIndicator indicator) {
        if (indicator != null) {
            indicator.setText("Extracting with system unzip...");
            indicator.setFraction(0.5);
        }
        boolean result = executeSystemUnzip(archiveFile, targetDir, indicator);
        if (result && indicator != null) {
            indicator.setFraction(0.9);
        }
        return result;
    }

    /**
     * Core implementation for system unzip extraction.
     * @param archiveFile The archive to extract
     * @param targetDir The target directory
     * @param indicator Optional progress indicator (can be null)
     * @return true if extraction succeeded, false otherwise
     */
    private static boolean executeSystemUnzip(File archiveFile, File targetDir, ProgressIndicator indicator) {
        Process process = null;
        try {
            ProcessBuilder pb;
            if (System.getProperty("os.name").toLowerCase().contains("windows")) {
                // Windows: try to use tar command (available in Windows 10+)
                pb = new ProcessBuilder("tar", "-xf", archiveFile.getAbsolutePath(), "-C", targetDir.getAbsolutePath());
            } else {
                // Unix/Linux/macOS: use unzip command
                pb = new ProcessBuilder("unzip", "-o", "-q", archiveFile.getAbsolutePath(), "-d", targetDir.getAbsolutePath());
            }

            pb.redirectErrorStream(true);
            process = pb.start();

            // Read output to prevent blocking
            try (java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    LOG.debug("[BridgeResolver] unzip: " + line);
                }
            }

            // Add timeout (5 minutes) to prevent hanging
            if (!process.waitFor(5, java.util.concurrent.TimeUnit.MINUTES)) {
                LOG.warn("[BridgeResolver] Unzip process timeout, killing...");
                process.destroyForcibly();
                return false;
            }

            return process.exitValue() == 0;
        } catch (Exception e) {
            LOG.debug("[BridgeResolver] System unzip failed: " + e.getMessage());
            return false;
        } finally {
            // Ensure process is destroyed if still alive
            if (process != null && process.isAlive()) {
                LOG.warn("[BridgeResolver] Forcibly destroying unzip process");
                process.destroyForcibly();
            }
        }
    }

    /**
     * Fallback extraction using Java ZipInputStream.
     * Note: This method does not preserve Unix file permissions.
     */
    private static void unzipWithJava(File archiveFile, File targetDir) throws IOException {
        Path targetPath = targetDir.toPath();
        byte[] buffer = new byte[8192];

        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path resolvedPath = targetPath.resolve(entry.getName()).normalize();
                if (!resolvedPath.startsWith(targetPath)) {
                    throw new IOException("Unsafe zip entry detected: " + entry.getName());
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(resolvedPath);
                } else {
                    Files.createDirectories(resolvedPath.getParent());
                    try (FileOutputStream fos = new FileOutputStream(resolvedPath.toFile())) {
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                }

                zis.closeEntry();
            }
        }
    }

    /**
     * Fallback extraction with progress using Java ZipInputStream.
     */
    private static void unzipWithJavaAndProgress(File archiveFile, File targetDir, ProgressIndicator indicator) throws IOException {
        Path targetPath = targetDir.toPath();
        byte[] buffer = new byte[8192];

        // First pass: count total entries
        int totalEntries = 0;
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            while (zis.getNextEntry() != null) {
                totalEntries++;
                zis.closeEntry();
            }
        }

        LOG.info("[BridgeResolver] Total entries to extract: " + totalEntries);

        // Second pass: extract with progress
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(archiveFile)))) {
            ZipEntry entry;
            int processedEntries = 0;

            while ((entry = zis.getNextEntry()) != null) {
                Path resolvedPath = targetPath.resolve(entry.getName()).normalize();
                if (!resolvedPath.startsWith(targetPath)) {
                    throw new IOException("Unsafe zip entry detected: " + entry.getName());
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(resolvedPath);
                } else {
                    Files.createDirectories(resolvedPath.getParent());
                    try (FileOutputStream fos = new FileOutputStream(resolvedPath.toFile())) {
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                }

                zis.closeEntry();
                processedEntries++;

                // Update progress (0.2 to 0.9 range allocated for extraction)
                double progress = 0.2 + (0.7 * processedEntries / totalEntries);
                indicator.setFraction(progress);
                indicator.setText("Extracting: " + entry.getName() + " (" + processedEntries + "/" + totalEntries + ")");
            }
        }
    }
}
