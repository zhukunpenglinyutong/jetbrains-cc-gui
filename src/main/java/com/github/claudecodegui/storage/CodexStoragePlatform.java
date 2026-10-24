package com.github.claudecodegui.storage;

import com.github.claudecodegui.util.PlatformUtils;
import com.sun.jna.Platform;

import java.io.IOException;
import java.nio.file.Files;
import java.util.Locale;
import java.util.Set;

/** Deletion has its own native-lock capability; advanced maintenance remains Windows-only. */
final class CodexStoragePlatform {
    private static final Set<String> LOCAL_POSIX_STORES = Set.of("apfs", "hfs", "hfs+", "hfsplus", "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "tmpfs", "overlay");

    private CodexStoragePlatform() { }

    static boolean supportsMaintenance(CodexStoragePaths paths) {
        return Platform.isWindows() && PlatformUtils.isWindows() && !paths.root().toString().startsWith("\\\\");
    }

    static boolean supportsDeletion(CodexStoragePaths paths) {
        if (supportsMaintenance(paths)) {
            return true;
        }
        if (!(Platform.isLinux() && PlatformUtils.isLinux() || Platform.isMac() && PlatformUtils.isMac())) {
            return false;
        }
        try {
            paths.revalidate();
            return isLocalPosixStore(Files.getFileStore(paths.root()).type())
                    && Files.readAttributes(paths.root(), java.nio.file.attribute.BasicFileAttributes.class).fileKey() != null;
        } catch (IOException error) {
            return false;
        }
    }

    static boolean isLocalPosixStore(String type) {
        return type != null && LOCAL_POSIX_STORES.contains(type.toLowerCase(Locale.ROOT));
    }
}
