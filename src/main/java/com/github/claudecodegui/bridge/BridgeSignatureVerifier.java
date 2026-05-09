package com.github.claudecodegui.bridge;

import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;

/**
 * Computes and verifies the ai-bridge archive signature so the resolver can
 * decide whether the cached extraction matches the bundled archive.
 *
 * <p>Package-private helper extracted from {@link BridgeDirectoryResolver}.
 */
final class BridgeSignatureVerifier {

    private static final Logger LOG = Logger.getInstance(BridgeSignatureVerifier.class);

    static final String SDK_HASH_FILE_NAME = "ai-bridge.hash";

    private BridgeSignatureVerifier() {
    }

    static boolean bridgeSignatureMatches(File versionFile, String expectedSignature) {
        if (versionFile == null || !versionFile.exists()) {
            return false;
        }
        try {
            String content = Files.readString(versionFile.toPath(), StandardCharsets.UTF_8).trim();
            return expectedSignature.equals(content);
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Read precomputed hash from ai-bridge.hash file (generated at build time).
     * This avoids expensive runtime hash calculation.
     *
     * @param pluginDir The plugin directory containing ai-bridge.hash
     * @return The hash string, or null if file doesn't exist or read fails
     */
    static String readPrecomputedHash(File pluginDir) {
        File hashFile = new File(pluginDir, SDK_HASH_FILE_NAME);
        if (!hashFile.exists()) {
            LOG.debug("[BridgeResolver] Precomputed hash file not found: " + hashFile.getAbsolutePath());
            return null;
        }

        try {
            String hash = Files.readString(hashFile.toPath(), StandardCharsets.UTF_8).trim();
            if (hash.isEmpty()) {
                LOG.warn("[BridgeResolver] Precomputed hash file is empty");
                return null;
            }
            LOG.debug("[BridgeResolver] Using precomputed hash: " + hash);
            return hash;
        } catch (IOException e) {
            LOG.warn("[BridgeResolver] Failed to read precomputed hash: " + e.getMessage());
            return null;
        }
    }

    /**
     * Calculate SHA-256 hash of a file.
     * NOTE: This is a fallback method only used when precomputed hash file is missing.
     * Prefer using readPrecomputedHash() when available.
     *
     * @param file The file to hash
     * @return Hex string of the hash, or null if calculation fails
     */
    static String calculateFileHash(File file) {
        if (file == null || !file.exists()) {
            return null;
        }

        LOG.info("[BridgeResolver] Calculating archive hash at runtime (fallback mode)");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];

            try (FileInputStream fis = new FileInputStream(file);
                 BufferedInputStream bis = new BufferedInputStream(fis)) {
                int bytesRead;
                while ((bytesRead = bis.read(buffer)) != -1) {
                    digest.update(buffer, 0, bytesRead);
                }
            }

            byte[] hashBytes = digest.digest();
            StringBuilder hexString = new StringBuilder();
            for (byte b : hashBytes) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) {
                    hexString.append('0');
                }
                hexString.append(hex);
            }

            return hexString.toString();
        } catch (Exception e) {
            LOG.warn("[BridgeResolver] Failed to calculate file hash: " + e.getMessage());
            return null;
        }
    }
}
