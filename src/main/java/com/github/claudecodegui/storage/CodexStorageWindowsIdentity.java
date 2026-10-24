package com.github.claudecodegui.storage;

import com.sun.jna.Memory;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.WString;
import com.sun.jna.win32.StdCallLibrary;

import java.io.IOException;
import java.nio.file.Path;

/** Reads actual volume/file IDs rather than IDE-cached BasicFileAttributes.fileKey values. */
final class CodexStorageWindowsIdentity {
    private CodexStorageWindowsIdentity() { }

    private interface WindowsFiles extends StdCallLibrary {
        WindowsFiles INSTANCE = Native.load("kernel32", WindowsFiles.class);
        Pointer CreateFileW(WString name, int access, int sharing, Pointer security, int creation, int flags, Pointer template);
        boolean GetFileInformationByHandle(Pointer handle, Pointer information);
        boolean CloseHandle(Pointer handle);
    }

    static String read(Path path) throws IOException {
        // Zero access permits metadata reads. Share all operations; SQLite and writer leases own exclusion.
        // Following the final junction also detects a retargeted canonical Codex home despite an IDE cache.
        Pointer handle = WindowsFiles.INSTANCE.CreateFileW(new WString(path.toString()), 0, 7, null, 3, 0x02000000, null);
        long value = handle == null ? 0 : Pointer.nativeValue(handle);
        if (value == 0 || value == -1L || value == 0xffffffffL) {
            throw new IOException("STORAGE_IDENTITY_UNSUPPORTED");
        }
        try (Memory information = new Memory(52)) {
            if (!WindowsFiles.INSTANCE.GetFileInformationByHandle(handle, information)) {
                throw new IOException("STORAGE_IDENTITY_UNSUPPORTED");
            }
            return Integer.toUnsignedString(information.getInt(28), 16) + ":"
                    + Integer.toUnsignedString(information.getInt(44), 16) + ":" + Integer.toUnsignedString(information.getInt(48), 16) + ":"
                    + Integer.toUnsignedString(information.getInt(8), 16) + ":" + Integer.toUnsignedString(information.getInt(4), 16);
        } finally {
            WindowsFiles.INSTANCE.CloseHandle(handle);
        }
    }
}
