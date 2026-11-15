package com.github.claudecodegui.provider.common;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

public final class GitHistoryTestRepositories {
    private GitHistoryTestRepositories() { }

    public static Path create(Path root, String remote) throws Exception {
        Files.createDirectories(root);
        git(root, "init", "--quiet");
        if (remote != null) {
            git(root, "remote", "add", "origin", remote);
        }
        return root;
    }

    public static void git(Path root, String... args) throws Exception {
        List<String> command = new ArrayList<>(List.of("git", "-c", "core.hooksPath=" + root.resolve("no-hooks"), "-C", root.toString()));
        command.addAll(Arrays.asList(args));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        try {
            if (!process.waitFor(10, TimeUnit.SECONDS) || process.exitValue() != 0) {
                throw new AssertionError("Temporary repository setup failed: " + new String(process.getInputStream().readAllBytes()));
            }
        } finally {
            process.destroyForcibly();
        }
    }
}
