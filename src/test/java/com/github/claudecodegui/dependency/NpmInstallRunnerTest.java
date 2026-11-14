package com.github.claudecodegui.dependency;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class NpmInstallRunnerTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void streamsEveryLineAndReportsTheExitCode() throws Exception {
        List<String> lines = new CopyOnWriteArrayList<>();
        NpmInstallRunner.Outcome outcome = NpmInstallRunner.run(peer("exit", "unused"), 10_000, lines::add);
        assertFalse(outcome.timedOut());
        assertEquals(3, outcome.exitCode());
        assertEquals(List.of("added 1 package", "npm warn deprecated"), lines);
    }

    @Test public void hungInstallHitsItsDeadlineEvenWhileTheOutputPipeStaysOpen() throws Exception {
        Path pidFile = temporary.getRoot().toPath().resolve("install.pid");
        List<String> lines = new CopyOnWriteArrayList<>();
        long started = System.nanoTime();
        NpmInstallRunner.Outcome outcome = NpmInstallRunner.run(peer("hang", pidFile.toString()), 5000, lines::add);
        assertTrue(outcome.timedOut());
        assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started) < 15);
        assertEquals(List.of("fetching packages"), lines);
        long pid = Long.parseLong(Files.readString(pidFile));
        var handle = ProcessHandle.of(pid);
        if (handle.isPresent()) {
            handle.get().onExit().get(5, TimeUnit.SECONDS);
        }
        assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
    }

    @Test public void anInheritedPipeNeitherBlocksTheResultNorWritesIntoTheLogAfterwards() throws Exception {
        Path tickerPid = temporary.getRoot().toPath().resolve("ticker.pid");
        List<String> lines = new CopyOnWriteArrayList<>();
        try {
            long started = System.nanoTime();
            NpmInstallRunner.Outcome outcome = NpmInstallRunner.run(peer("orphan", tickerPid.toString()), 10_000, lines::add);
            assertFalse(outcome.timedOut());
            assertEquals(0, outcome.exitCode());
            assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started) < 8);
            int seen = lines.size();
            Thread.sleep(500);
            assertEquals("the caller owns its log once run() returned", seen, lines.size());
        } finally {
            if (Files.exists(tickerPid)) {
                ProcessHandle.of(Long.parseLong(Files.readString(tickerPid).trim())).ifPresent(ProcessHandle::destroyForcibly);
            }
        }
    }

    private ProcessBuilder peer(String mode, String file) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        Path classes = temporary.newFolder("install-peer-classes").toPath();
        String resource = InstallPeer.class.getName().replace('.', '/') + ".class";
        Path bytecode = classes.resolve(resource);
        Files.createDirectories(bytecode.getParent());
        try (var input = InstallPeer.class.getResourceAsStream("/" + resource)) {
            assertNotNull(input);
            Files.copy(input, bytecode);
        }
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classes.toString(), InstallPeer.class.getName(), mode, file);
        builder.redirectErrorStream(true);
        // The JVM announces JAVA_TOOL_OPTIONS on stderr, which would leak into the asserted log.
        builder.environment().remove("JAVA_TOOL_OPTIONS");
        return builder;
    }

    public static class InstallPeer {
        public static void main(String[] args) throws Exception {
            switch (args[0]) {
                case "hang" -> {
                    Files.writeString(Path.of(args[1]), Long.toString(ProcessHandle.current().pid()));
                    System.out.println("fetching packages");
                    System.out.flush();
                    // A stalled registry request: the process stays alive with stdout open.
                    Thread.sleep(60_000);
                }
                case "orphan" -> {
                    // npm exits but a child it started keeps the inherited stdout open.
                    String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
                    new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
                            InstallPeer.class.getName(), "ticker", args[1]).inheritIO().start();
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                    while (!Files.exists(Path.of(args[1])) && System.nanoTime() < deadline) {
                        Thread.sleep(20);
                    }
                    System.out.println("added 1 package");
                    System.out.flush();
                }
                case "ticker" -> {
                    Files.writeString(Path.of(args[1]), Long.toString(ProcessHandle.current().pid()));
                    for (int i = 0; i < 200; i++) {
                        System.out.println("tick " + i);
                        System.out.flush();
                        Thread.sleep(100);
                    }
                }
                default -> {
                    System.out.println("added 1 package");
                    System.out.flush();
                    System.err.println("npm warn deprecated");
                    System.err.flush();
                    System.exit(3);
                }
            }
        }
    }
}
