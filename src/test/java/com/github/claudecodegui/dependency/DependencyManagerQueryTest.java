package com.github.claudecodegui.dependency;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class DependencyManagerQueryTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void drainsLargeStderrWithoutMixingItIntoTheVersionJson() throws Exception {
        String output = DependencyManager.runNpmQuery(peer("output", "unused"), 10_000);
        assertEquals(java.util.List.of("0.163.0", "0.146.0"), DependencyManager.parseVersionList(output));
    }

    @Test public void stalledNpmQueryHasAnEffectiveDeadlineAndReapsItsProcess() throws Exception {
        Path pidFile = temporary.getRoot().toPath().resolve("owned-process.pid");
        long started = System.nanoTime();
        Exception error = assertThrows(java.io.IOException.class,
                () -> DependencyManager.runNpmQuery(peer("hang", pidFile.toString()), 1500));
        assertEquals("NPM_QUERY_TIMEOUT", error.getMessage());
        assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started) < 8);
        if (Files.exists(pidFile)) {
            long pid = Long.parseLong(Files.readString(pidFile));
            var handle = ProcessHandle.of(pid);
            if (handle.isPresent()) {
                handle.get().onExit().get(5, TimeUnit.SECONDS);
            }
            assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        }
    }

    @Test public void failureReportsOnlyTheNpmErrorCode() throws Exception {
        Exception error = assertThrows(java.io.IOException.class,
                () -> DependencyManager.runNpmQuery(peer("fail", "unused"), 10_000));
        assertEquals("NPM_QUERY_EXIT_1: EACCES", error.getMessage());
    }

    @Test public void cachePermissionFailureRetriesOnceWithoutChangingRegistryOrProxy() throws Exception {
        Path attempts = temporary.getRoot().toPath().resolve("attempts");
        ProcessBuilder builder = peer("cache-permission", attempts.toString());
        builder.environment().put("npm_config_registry", "https://registry.example.invalid");
        builder.environment().put("HTTPS_PROXY", "http://127.0.0.1:12345");
        String cache = temporary.getRoot().toPath().resolve("private cache").toString();
        String output = DependencyManager.runNpmQueryWithCacheFallback(builder, 10_000, cache);
        assertEquals(2, Files.readAllLines(attempts).size());
        assertEquals("--cache=" + cache, builder.command().get(builder.command().size() - 1));
        assertEquals("https://registry.example.invalid", builder.environment().get("npm_config_registry"));
        assertEquals("http://127.0.0.1:12345", builder.environment().get("HTTPS_PROXY"));
        assertEquals(java.util.List.of("0.163.0", "0.146.0"), DependencyManager.parseVersionList(output));
    }

    @Test public void networkFailuresAreNotRetriedAsCacheFailures() throws Exception {
        Path attempts = temporary.getRoot().toPath().resolve("attempts");
        IOException error = assertThrows(IOException.class, () -> DependencyManager.runNpmQueryWithCacheFallback(
                peer("network", attempts.toString()), 10_000, "unused"));
        assertEquals("NPM_QUERY_EXIT_1: ENOTFOUND", error.getMessage());
        assertEquals(1, Files.readAllLines(attempts).size());
    }

    @Test public void cacheRetryDoesNotLoopWhenThePrivateCacheAlsoFails() throws Exception {
        Path attempts = temporary.getRoot().toPath().resolve("attempts");
        IOException error = assertThrows(IOException.class, () -> DependencyManager.runNpmQueryWithCacheFallback(
                peer("denied", attempts.toString()), 10_000, "unused"));
        assertEquals("NPM_QUERY_EXIT_1: EPERM", error.getMessage());
        assertEquals(2, Files.readAllLines(attempts).size());
    }

    @Test public void latestTagDoesNotSilentlyBecomeTheHighestOrBundledVersion() throws Exception {
        var result = DependencyManager.parseVersionInfo("{\"versions\":[\"0.3.220\",\"0.3.307\",\"0.4.0-beta.1\"],\"dist-tags.latest\":\"0.3.220\"}");
        assertEquals(java.util.List.of("0.3.307", "0.3.220"), result.versions());
        assertEquals("0.3.220", result.latestVersion());
        assertNull(result.error());
        assertThrows(IOException.class, () -> DependencyManager.parseVersionInfo("{}"));
    }

    private ProcessBuilder peer(String mode, String file) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        Path classes = temporary.newFolder("query-peer-classes").toPath();
        String resource = NpmPeer.class.getName().replace('.', '/') + ".class";
        Path bytecode = classes.resolve(resource);
        Files.createDirectories(bytecode.getParent());
        try (var input = NpmPeer.class.getResourceAsStream("/" + resource)) {
            assertNotNull(input);
            Files.copy(input, bytecode);
        }
        return new ProcessBuilder(java, "-cp", classes.toString(), NpmPeer.class.getName(), mode, file);
    }

    public static class NpmPeer {
        public static void main(String[] args) throws Exception {
            if (java.util.List.of("cache-permission", "network", "denied").contains(args[0])) {
                Files.writeString(Path.of(args[1]), "attempt\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
                if (!args[0].equals("cache-permission") || args.length == 2) {
                    System.err.println("npm error code " + (args[0].equals("network") ? "ENOTFOUND" : "EPERM"));
                    System.exit(1);
                }
            }
            if ("hang".equals(args[0])) {
                Files.writeString(Path.of(args[1]), Long.toString(ProcessHandle.current().pid()));
                Thread.sleep(60_000);
            } else if ("fail".equals(args[0])) {
                System.err.println("npm error code EACCES\nUnrelated diagnostic body");
                System.exit(1);
            } else {
                System.err.print("w".repeat(128 * 1024));
                System.out.println("[\"0.146.0\",\"0.163.0\"]");
            }
        }
    }
}
