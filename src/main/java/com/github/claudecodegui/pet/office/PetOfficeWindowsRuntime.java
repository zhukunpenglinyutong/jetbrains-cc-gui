package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.UserPrincipal;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.EnumSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/** Verified Windows desktop/user namespace outside relocatable AI data. */
final class PetOfficeWindowsRuntime {
    private PetOfficeWindowsRuntime() {
    }

    static Path resolveDirectory() throws IOException, InterruptedException {
        String localData = System.getenv("LOCALAPPDATA");
        String systemRoot = System.getenv("SystemRoot");
        if (localData == null || systemRoot == null || !localData.matches("(?i)^[a-z]:[\\\\/].*")) {
            throw new IOException("OFFICE_LOCAL_RUNTIME_UNAVAILABLE");
        }
        JsonObject identity = resolveIdentity(Path.of(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
        if (identity.get("session").getAsInt() <= 0 || identity.get("driveType").getAsInt() != 3
                || !"WinSta0".equalsIgnoreCase(identity.get("station").getAsString())) {
            throw new IOException("OFFICE_DESKTOP_UNSUPPORTED");
        }
        String desktop = identity.get("desktop").getAsString();
        if (desktop.isBlank() || desktop.length() > 128) {
            throw new IOException("OFFICE_DESKTOP_UNVERIFIED");
        }
        String namespace = identity.get("sid").getAsString() + "\n" + identity.get("session").getAsInt()
                + "\n" + identity.get("station").getAsString().toLowerCase(Locale.ROOT) + "\n" + desktop.toLowerCase(Locale.ROOT);
        Path base = Path.of(localData).toAbsolutePath().normalize();
        rejectReparseParents(base);
        UserPrincipal user = base.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName(identity.get("user").getAsString());
        Path managed = secureChild(base, "CCGUI-PetOffice-Prototype", user);
        return secureChild(managed, "desktop-" + digest(namespace), user);
    }

    private static Path secureChild(Path parent, String name, UserPrincipal user) throws IOException {
        rejectReparseParents(parent);
        Path directory = parent.resolve(name);
        try {
            Files.createDirectory(directory);
            // Elevated Windows tokens may default new directories to Administrators.
            // Only a directory created by this call may have its owner adjusted.
            Files.setOwner(directory, user);
        } catch (FileAlreadyExistsException existing) {
            // Validate the existing entry without following a reparse point.
        }
        rejectReparseParents(directory);
        verifyOwner(directory, user);
        AclFileAttributeView acl = Files.getFileAttributeView(directory, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (acl == null) {
            throw new IOException("OFFICE_RUNTIME_ACL_UNAVAILABLE");
        }
        AclEntry entry = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(user)
                .setPermissions(EnumSet.allOf(AclEntryPermission.class))
                .setFlags(AclEntryFlag.DIRECTORY_INHERIT, AclEntryFlag.FILE_INHERIT).build();
        acl.setAcl(List.of(entry));
        return directory;
    }

    private static JsonObject resolveIdentity(Path powershell) throws IOException, InterruptedException {
        // Child processes inherit the IDE's window station/desktop. Never use SESSIONNAME as identity.
        String script = """
                $ErrorActionPreference = 'Stop'
                [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
                Add-Type -TypeDefinition @'
                using System;
                using System.Text;
                using System.Runtime.InteropServices;
                public static class CCGUIPetDesktop {
                    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
                    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetDriveType(string root);
                    [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
                    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
                    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
                    public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, uint length, out uint needed);
                    public static string Name(IntPtr handle) {
                        var buffer = new StringBuilder(256); uint needed;
                        if (!GetUserObjectInformation(handle, 2, buffer, 512, out needed)) throw new InvalidOperationException();
                        return buffer.ToString();
                    }
                }
                '@
                $user = [System.Security.Principal.WindowsIdentity]::GetCurrent()
                $data = [ordered]@{
                    session = (Get-Process -Id %d).SessionId
                    sid = $user.User.Value
                    user = $user.Name
                    station = [CCGUIPetDesktop]::Name([CCGUIPetDesktop]::GetProcessWindowStation())
                    desktop = [CCGUIPetDesktop]::Name([CCGUIPetDesktop]::GetThreadDesktop([CCGUIPetDesktop]::GetCurrentThreadId()))
                    driveType = [CCGUIPetDesktop]::GetDriveType([System.IO.Path]::GetPathRoot($env:LOCALAPPDATA))
                }
                $data | ConvertTo-Json -Compress
                """.formatted(ProcessHandle.current().pid());
        String encoded = Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE));
        Process process = new ProcessBuilder(powershell.toString(), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded)
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {
            if (!process.waitFor(8, TimeUnit.SECONDS)) {
                throw new IOException("OFFICE_DESKTOP_DISCOVERY_TIMEOUT");
            }
            byte[] output = process.getInputStream().readNBytes(4097);
            if (process.exitValue() != 0 || output.length > 4096) {
                throw new IOException("OFFICE_DESKTOP_DISCOVERY_FAILED");
            }
            try {
                return JsonParser.parseString(new String(output, StandardCharsets.UTF_8).strip()).getAsJsonObject();
            } catch (RuntimeException invalid) {
                throw new IOException("OFFICE_DESKTOP_UNVERIFIED");
            }
        } finally {
            process.getInputStream().close();
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private static void rejectReparseParents(Path path) throws IOException {
        for (Path current = path; current != null; current = current.getParent()) {
            BasicFileAttributes attrs = Files.readAttributes(current, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attrs.isDirectory() || attrs.isSymbolicLink() || attrs.isOther()) {
                throw new IOException("OFFICE_RUNTIME_PATH_UNSAFE");
            }
        }
    }

    private static void verifyOwner(Path path, UserPrincipal user) throws IOException {
        if (!Files.getOwner(path, LinkOption.NOFOLLOW_LINKS).equals(user)) {
            throw new IOException("OFFICE_RUNTIME_OWNER_MISMATCH");
        }
    }

    private static String digest(String namespace) throws IOException {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(namespace.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IOException("OFFICE_RUNTIME_DIGEST_UNAVAILABLE");
        }
    }
}
