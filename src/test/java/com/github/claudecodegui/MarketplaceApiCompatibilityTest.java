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

    @Test
    public void diffReviewCodeDoesNotRunSlowVfsOperationsInsideEdtOrReadActionCallbacks() throws IOException {
        List<String> flaggedUsages;
        List<Path> sourceRoots = List.of(
            Path.of("src/main/java/com/github/claudecodegui/handler/diff"),
            Path.of("src/main/java/com/github/claudecodegui/permission"),
            Path.of("src/main/java/com/github/claudecodegui/util")
        );
        flaggedUsages = sourceRoots.stream()
            .flatMap(root -> {
                try {
                    return Files.walk(root);
                } catch (IOException e) {
                    throw new IllegalStateException("Failed to walk " + root, e);
                }
            })
                .filter(path -> path.toString().endsWith(".java"))
                .flatMap(MarketplaceApiCompatibilityTest::slowVfsOperationsInsideUiSensitiveBlocks)
                .collect(Collectors.toList());

        assertTrue("Slow VFS/file operations inside EDT/read-action callbacks remain:\n" + String.join("\n", flaggedUsages),
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
            || code.contains(".getStringValue()")
            || code.contains(".getModuleTypeName()");
    }

    private static Stream<String> slowVfsOperationsInsideUiSensitiveBlocks(Path path) {
        try {
            List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
            List<String> flagged = new java.util.ArrayList<>();
            String blockKind = null;
            int depth = 0;
            int startLine = 0;

            for (int i = 0; i < lines.size(); i++) {
                String line = lines.get(i);
                String code = line.strip();
                if (code.startsWith("*") || code.startsWith("//")) {
                    continue;
                }

                if (blockKind == null && (code.contains("invokeLater(() ->") || code.contains("runReadAction("))) {
                    blockKind = code.contains("invokeLater(() ->") ? "invokeLater" : "runReadAction";
                    depth = braceDelta(line);
                    startLine = i + 1;
                } else if (blockKind != null) {
                    depth += braceDelta(line);
                }

                if (blockKind != null && isSlowVfsOperation(code)) {
                    flagged.add(path + ":" + (i + 1) + " in " + blockKind + " block starting at line "
                        + startLine + ": " + code);
                }

                if (blockKind != null && depth <= 0 && code.contains(");")) {
                    blockKind = null;
                    depth = 0;
                    startLine = 0;
                }
            }

            return flagged.stream();
        } catch (IOException e) {
            throw new IllegalStateException("Failed to read " + path, e);
        }
    }

    private static boolean isSlowVfsOperation(String code) {
        return code.contains("refreshAndFindFileByPath(")
            || code.contains("refreshAndFindFileByIoFile(")
            || code.contains("refreshAndFindFileSync(")
            || code.contains("contentsToByteArray(");
    }

    private static int braceDelta(String line) {
        int delta = 0;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '{') {
                delta++;
            } else if (c == '}') {
                delta--;
            }
        }
        return delta;
    }
}
