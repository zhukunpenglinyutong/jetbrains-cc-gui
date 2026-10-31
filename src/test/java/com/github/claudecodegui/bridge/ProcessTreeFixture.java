package com.github.claudecodegui.bridge;

import java.nio.file.Files;
import java.nio.file.Path;

/** Standalone child process: no IDE platform, user configuration or network access. */
public final class ProcessTreeFixture {
    public static void main(String[] args) throws Exception {
        if ("child".equals(args[0])) {
            Thread.sleep(120_000L);
            return;
        }
        String executable = Path.of(System.getProperty("java.home"), "bin",
                System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        Process child = new ProcessBuilder(executable, "-cp", args[2], ProcessTreeFixture.class.getName(), "child").start();
        Files.writeString(Path.of(args[1]), Long.toString(child.pid()));
        Thread.sleep(120_000L);
    }
}
