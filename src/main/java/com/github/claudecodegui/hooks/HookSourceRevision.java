package com.github.claudecodegui.hooks;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** Content-sensitive revisions shared by discovery, editing and reversible toggles. */
final class HookSourceRevision {

    private HookSourceRevision() {
    }

    static String read(Path path) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                digest.update(buffer, 0, count);
            }
        }
        return Files.size(path) + ":" + Files.getLastModifiedTime(path).toMillis()
                + ":" + HexFormat.of().formatHex(digest.digest());
    }

}
