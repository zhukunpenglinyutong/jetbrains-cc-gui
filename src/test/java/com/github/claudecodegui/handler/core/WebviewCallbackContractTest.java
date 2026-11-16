package com.github.claudecodegui.handler.core;

import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertTrue;

/**
 * Every webview function the Java side calls by name must exist in the webview.
 * JsUtils.buildJsCall guards each call with {@code typeof fn === 'function'}, so a
 * renamed or deleted handler fails silently at runtime; this test makes it fail here.
 */
public class WebviewCallbackContractTest {

    private static final Pattern JAVA_CALL = Pattern.compile(
            "(?:callJavaScript|buildJsCall)\\(\\s*\"(?:window\\.)?([A-Za-z_$][\\w$]*)\"");

    @Test
    public void everyJavaCalledWebviewFunctionIsDefinedInTheWebview() throws IOException {
        Path root = findRepoRoot();
        Map<String, TreeSet<String>> callers = collectJavaCallTargets(root.resolve("src/main/java"));
        String webview = readWebviewSources(root.resolve("webview/src"));

        // shortcut: a name mentioned anywhere in webview code counts as defined;
        // parse the window assignments instead if drift slips past this.
        Map<String, TreeSet<String>> missing = new TreeMap<>();
        callers.forEach((name, files) -> {
            if (!Pattern.compile("\\b" + Pattern.quote(name) + "\\b").matcher(webview).find()) {
                missing.put(name, files);
            }
        });

        assertTrue("Java calls webview functions that no webview code defines "
                + "(remove the call or add the handler): " + missing, missing.isEmpty());
        assertTrue("expected to find Java -> webview calls; did the call pattern change?",
                callers.size() > 50);
    }

    private static Map<String, TreeSet<String>> collectJavaCallTargets(Path javaRoot) throws IOException {
        Map<String, TreeSet<String>> callers = new TreeMap<>();
        try (Stream<Path> files = Files.walk(javaRoot)) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).collect(Collectors.toList())) {
                Matcher matcher = JAVA_CALL.matcher(Files.readString(file, StandardCharsets.UTF_8));
                while (matcher.find()) {
                    callers.computeIfAbsent(matcher.group(1), k -> new TreeSet<>()).add(file.getFileName().toString());
                }
            }
        }
        return callers;
    }

    /** Production webview code only: tests and the hand-written global.d.ts do not define handlers. */
    private static String readWebviewSources(Path webviewSrc) throws IOException {
        StringBuilder all = new StringBuilder();
        try (Stream<Path> files = Files.walk(webviewSrc)) {
            for (Path file : files.filter(WebviewCallbackContractTest::isWebviewProductionSource)
                    .collect(Collectors.toList())) {
                all.append(Files.readString(file, StandardCharsets.UTF_8)).append('\n');
            }
        }
        return all.toString();
    }

    private static boolean isWebviewProductionSource(Path file) {
        String path = file.toString().replace('\\', '/');
        String name = file.getFileName().toString();
        return (name.endsWith(".ts") || name.endsWith(".tsx"))
                && !name.endsWith(".d.ts")
                && !name.contains(".test.")
                && !path.contains("/__tests__/");
    }

    private static Path findRepoRoot() {
        Path dir = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        for (int i = 0; i < 6 && dir != null; i++) {
            if (Files.isDirectory(dir.resolve("webview/src")) && Files.isDirectory(dir.resolve("src/main/java"))) {
                return dir;
            }
            dir = dir.getParent();
        }
        throw new AssertionError("repository root with webview/src and src/main/java not found");
    }
}
