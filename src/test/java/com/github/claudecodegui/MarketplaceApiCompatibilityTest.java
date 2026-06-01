package com.github.claudecodegui;

import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertTrue;

public class MarketplaceApiCompatibilityTest {

    @Test
    public void sourceDoesNotUseMarketplaceFlaggedApis() throws IOException {
        List<String> flaggedUsages;
        Path sourceRoot = Path.of("src/main/java");
        try (Stream<Path> paths = Files.walk(sourceRoot)) {
            flaggedUsages = paths
                .filter(path -> path.toString().endsWith(".java"))
                .flatMap(MarketplaceApiCompatibilityTest::flaggedLines)
                .collect(Collectors.toList());
        }

        assertTrue("Marketplace-flagged API usages remain:\n" + String.join("\n", flaggedUsages),
            flaggedUsages.isEmpty());
    }

    private static Stream<String> flaggedLines(Path path) {
        try {
            List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
            return Stream.iterate(0, i -> i + 1)
                .limit(lines.size())
                .filter(i -> isFlagged(lines.get(i)))
                .map(i -> path + ":" + (i + 1) + ": " + lines.get(i).trim());
        } catch (IOException e) {
            throw new IllegalStateException("Failed to read " + path, e);
        }
    }

    private static boolean isFlagged(String line) {
        String code = line.strip();
        if (code.startsWith("*") || code.startsWith("//")) {
            return false;
        }
        return code.contains("PluginManager.getInstance().findEnabledPlugin(")
            || code.contains("PluginManager.getPlugins(")
            || code.contains("PluginManager.getPluginByClass(")
            || code.contains("ReadAction.compute(")
            || code.contains(".getOptionValue(\"moduleType\")")
            || code.contains(".getStringValue()");
    }
}
