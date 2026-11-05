package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import com.github.claudecodegui.settings.AiDataDirectoryManager.AiDataDirectoryException;

/** Creates, verifies and removes directory links without traversing their targets. */
final class AiDataDirectoryLinks {

    private AiDataDirectoryLinks() { }

    private static final int LINK_COMMAND_TIMEOUT_SECONDS = 30;

    static void createPlatformLink(Path canonical, Path target, PlatformUtils.PlatformType platform) throws IOException {
        if (platform == PlatformUtils.PlatformType.WINDOWS) {
            createWindowsJunction(canonical, target);
        } else {
            Files.createSymbolicLink(canonical, target);
        }
    }

    private static void createWindowsJunction(Path canonical, Path target) throws IOException {
        Path script = Files.createTempFile("cc-gui-junction-", ".ps1");
        try {
            Files.writeString(script, "param([string]$LinkPath, [string]$TargetPath)\n"
                    + "$ErrorActionPreference = 'Stop'\n"
                    + "New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null\n",
                    StandardCharsets.UTF_8);
            Process process;
            try {
                process = new ProcessBuilder("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                        "-ExecutionPolicy", "Bypass", "-File", script.toString(),
                        "-LinkPath", canonical.toString(), "-TargetPath", target.toString())
                        .redirectErrorStream(true)
                        .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                        .start();
            } catch (IOException error) {
                createWindowsJunctionWithMklink(canonical, target);
                return;
            }
            try {
                if (!process.waitFor(LINK_COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    terminateProcess(process);
                    throw new AiDataDirectoryException("LINK_CREATION_TIMEOUT");
                }
            } catch (InterruptedException error) {
                terminateProcess(process);
                Thread.currentThread().interrupt();
                throw new AiDataDirectoryException("LINK_CREATION_INTERRUPTED", error);
            }
            if (process.exitValue() != 0) {
                createWindowsJunctionWithMklink(canonical, target);
            }
        } finally {
            Files.deleteIfExists(script);
        }
    }

    private static void createWindowsJunctionWithMklink(Path canonical, Path target) throws IOException {
        Process process;
        try {
            ProcessBuilder builder = new ProcessBuilder("cmd.exe", "/d", "/v:off", "/c",
                    "mklink /J \"%CC_GUI_JUNCTION_LINK%\" \"%CC_GUI_JUNCTION_TARGET%\"")
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD);
            builder.environment().put("CC_GUI_JUNCTION_LINK", canonical.toString());
            builder.environment().put("CC_GUI_JUNCTION_TARGET", target.toString());
            process = builder.start();
        } catch (IOException error) {
            throw new AiDataDirectoryException("LINK_CREATION_FAILED", error);
        }
        try {
            if (!process.waitFor(LINK_COMMAND_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                terminateProcess(process);
                throw new AiDataDirectoryException("LINK_CREATION_TIMEOUT");
            }
        } catch (InterruptedException error) {
            terminateProcess(process);
            Thread.currentThread().interrupt();
            throw new AiDataDirectoryException("LINK_CREATION_INTERRUPTED", error);
        }
        if (process.exitValue() != 0) {
            throw new AiDataDirectoryException("LINK_CREATION_FAILED");
        }
    }

    private static void terminateProcess(Process process) {
        process.destroyForcibly();
        try {
            process.waitFor(5, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    static boolean isDirectDirectoryLink(Path path) throws IOException {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return false;
        }
        if (Files.isSymbolicLink(path)) {
            return true;
        }
        Path parent = path.getParent();
        if (parent == null || !Files.isDirectory(parent)) {
            return false;
        }
        Path expected = parent.toRealPath().resolve(path.getFileName()).normalize();
        return !expected.equals(path.toRealPath());
    }

    static void validateLink(Path canonical, Path target) throws IOException {
        if (!isDirectDirectoryLink(canonical) || !Files.isSameFile(canonical, target)) {
            throw new AiDataDirectoryException("LINK_VALIDATION_FAILED");
        }
    }

    static boolean isLinkTo(Path link, Path target) {
        try {
            return isDirectDirectoryLink(link) && Files.isSameFile(link, target);
        } catch (IOException error) {
            return false;
        }
    }

    static void deleteDirectoryLink(Path path) throws IOException {
        if (!isDirectDirectoryLink(path)) {
            throw new AiDataDirectoryException("PATH_IS_NOT_LINK");
        }
        Files.deleteIfExists(path);
    }

}
