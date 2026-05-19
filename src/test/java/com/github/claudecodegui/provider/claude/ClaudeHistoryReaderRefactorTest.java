package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.claude.ClaudeHistoryReader.ProjectStatistics;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public class ClaudeHistoryReaderRefactorTest {

    @Test
    public void usageAggregatorBuildsStatisticsWithCacheAwareDailyUsage() throws IOException {
        Path projectsDir = Files.createTempDirectory("claude-history-usage");
        try {
            Path projectDir = Files.createDirectories(projectsDir.resolve("demo-project"));
            writeSessionFile(
                    projectDir,
                    "session-1",
                    line("2026-03-10T10:00:00Z", "summary", "\"summary\":\"Summarize test results\""),
                    line(
                            "2026-03-10T10:01:00Z",
                            "assistant",
                            "\"message\":{\"role\":\"assistant\",\"model\":\"claude-sonnet-4-6\","
                                    + "\"usage\":{\"input_tokens\":1000,\"output_tokens\":250,"
                                    + "\"cache_creation_input_tokens\":400,\"cache_read_input_tokens\":50}}"
                    )
            );

            ClaudeUsageAggregator aggregator = new ClaudeUsageAggregator(projectsDir, new ClaudeHistoryParser());
            ProjectStatistics stats = aggregator.getProjectStatistics("all", 0);

            assertEquals(1, stats.totalSessions);
            assertEquals(1000, stats.totalUsage.inputTokens);
            assertEquals(250, stats.totalUsage.outputTokens);
            assertEquals(400, stats.totalUsage.cacheWriteTokens);
            assertEquals(50, stats.totalUsage.cacheReadTokens);
            assertEquals(1700, stats.totalUsage.totalTokens);
            assertEquals(1, stats.dailyUsage.size());
            assertEquals(400, stats.dailyUsage.get(0).usage.cacheWriteTokens);
            assertEquals(50, stats.dailyUsage.get(0).usage.cacheReadTokens);
            assertEquals(0.007265, stats.estimatedCost, 0.0000001);
            assertFalse(stats.byModel.isEmpty());
        } finally {
            deleteDirectory(projectsDir);
        }
    }

    @Test
    public void usageAggregatorUsesTieredPricingForLegacySonnet4() throws IOException {
        Path projectsDir = Files.createTempDirectory("claude-history-pricing");
        try {
            Path projectDir = Files.createDirectories(projectsDir.resolve("demo-project"));
            writeSessionFile(
                    projectDir,
                    "session-2",
                    line(
                            "2026-03-10T10:01:00Z",
                            "assistant",
                            "\"message\":{\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\","
                                    + "\"usage\":{\"input_tokens\":250000,\"output_tokens\":1000,"
                                    + "\"cache_creation_input_tokens\":10000,\"cache_read_input_tokens\":5000}}"
                    )
            );

            ClaudeUsageAggregator aggregator = new ClaudeUsageAggregator(projectsDir, new ClaudeHistoryParser());
            ProjectStatistics stats = aggregator.getProjectStatistics("all", 0);

            assertEquals(1, stats.totalSessions);
            assertEquals(266000, stats.totalUsage.totalTokens);
            assertEquals(1.6005, stats.estimatedCost, 0.0000001);
        } finally {
            deleteDirectory(projectsDir);
        }
    }

    private Path writeSessionFile(Path projectDir, String sessionId, String... lines) throws IOException {
        Files.createDirectories(projectDir);
        Path file = projectDir.resolve(sessionId + ".jsonl");
        Files.write(file, String.join("\n", lines).concat("\n").getBytes());
        return file;
    }

    private String line(String timestamp, String type, String extraFields) {
        return "{\"timestamp\":\"" + timestamp + "\",\"type\":\"" + type + "\"," + extraFields + "}";
    }

    private void deleteDirectory(Path root) throws IOException {
        if (!Files.exists(root)) {
            return;
        }

        Files.walk(root)
                .sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException ignored) {
                    }
                });
    }
}
