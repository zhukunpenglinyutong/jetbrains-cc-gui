package com.github.claudecodegui.service;

final class CommitMessageCleaner {
    private static final String START = "<commit>";
    private static final String END = "</commit>";
    private static final String[] CONVENTIONAL_TYPES = {
            "feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci", "style", "build", "revert"
    };
    private static final String[] ANALYSIS_MARKERS = {
            "分析说明", "变更特征", "分析：", "说明：", "解释：", "备注：",
            "Analysis:", "Explanation:", "Note:", "---", "===",
            "1. 类型", "2. Scope", "3. 描述", "4. Body",
            "• ", "- 无需", "- 不涉及"
    };
    private static final String[] UI_THINKING_MARKERS = {
            "思考 ▸", "思考▸", "思考 ►", "思考►", "Thinking ▸", "Thinking▸"
    };

    String clean(String raw) {
        if (raw == null) {
            return "";
        }
        String value = removeThinkingMarkers(raw.trim());
        int start = value.indexOf(START);
        int end = value.indexOf(END);
        if (start >= 0 && end > start) {
            value = value.substring(start + START.length(), end).trim();
            return normalize(value);
        }
        if (value.startsWith("```")) {
            int firstNewline = value.indexOf('\n');
            int lastFence = value.lastIndexOf("```");
            if (firstNewline >= 0 && lastFence > firstNewline) {
                value = value.substring(firstNewline + 1, lastFence).trim();
                return normalize(value);
            }
        }
        String conventional = extractConventionalCommit(value);
        if (!conventional.isEmpty()) {
            return normalize(conventional);
        }
        return normalize(firstNonAnalysisLines(value));
    }

    String cleanPartial(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw;
        int start = value.indexOf(START);
        if (start < 0) {
            return "";
        }
        int contentStart = start + START.length();
        int end = value.indexOf(END, contentStart);
        value = end > contentStart ? value.substring(contentStart, end) : value.substring(contentStart);
        value = stripTrailingPrefix(value, END);
        if (value.startsWith("```")) {
            int firstNewline = value.indexOf('\n');
            if (firstNewline >= 0) {
                value = value.substring(firstNewline + 1);
            }
        }
        value = value.replace("\\n", "\n");
        return value.replaceAll("\\n{3,}", "\n\n").trim();
    }

    private String normalize(String value) {
        String result = value == null ? "" : value.replace("\\n", "\n");
        result = result.replaceAll("(?i)generated with .*", "");
        result = result.replaceFirst("^\\n+", "");
        return result.replaceAll("\\n{3,}", "\n\n").trim();
    }

    private String extractConventionalCommit(String value) {
        String[] lines = value.split("\n");
        for (int i = 0; i < lines.length; i++) {
            String trimmedLine = lines[i].trim();
            if (!isConventionalCommitLine(trimmedLine)) {
                continue;
            }
            StringBuilder result = new StringBuilder(trimmedLine);
            boolean inBody = false;
            for (int j = i + 1; j < lines.length; j++) {
                String nextLine = lines[j].trim();
                if (isAnalysisSection(nextLine)) {
                    break;
                }
                if (nextLine.isEmpty()) {
                    inBody = true;
                    result.append("\n");
                    continue;
                }
                if (inBody && !nextLine.startsWith("#") && !nextLine.startsWith("*")) {
                    result.append("\n").append(nextLine);
                } else if (!inBody) {
                    break;
                }
            }
            return result.toString();
        }
        return "";
    }

    private String firstNonAnalysisLines(String value) {
        StringBuilder fallback = new StringBuilder();
        String[] lines = value.split("\n");
        for (String line : lines) {
            String trimmedLine = line.trim();
            if (isAnalysisSection(trimmedLine)) {
                break;
            }
            if (!trimmedLine.isEmpty()) {
                fallback.append(trimmedLine).append("\n");
            }
            if (fallback.toString().split("\n").length >= 5) {
                break;
            }
        }
        return fallback.toString();
    }

    private boolean isConventionalCommitLine(String line) {
        if (line == null || line.isEmpty()) {
            return false;
        }
        for (String type : CONVENTIONAL_TYPES) {
            if (line.startsWith(type + ":") || line.startsWith(type + "(")) {
                return true;
            }
        }
        return false;
    }

    private boolean isAnalysisSection(String line) {
        if (line == null) {
            return false;
        }
        for (String marker : ANALYSIS_MARKERS) {
            if (line.contains(marker)) {
                return true;
            }
        }
        return line.matches("^\\d+\\.\\s+.*");
    }

    private String removeThinkingMarkers(String content) {
        if (content == null || content.isEmpty()) {
            return content;
        }
        String result = content;
        while (result.contains("<thinking>") && result.contains("</thinking>")) {
            int start = result.indexOf("<thinking>");
            int end = result.indexOf("</thinking>") + "</thinking>".length();
            if (start < end) {
                result = result.substring(0, start) + result.substring(end);
            } else {
                break;
            }
        }
        for (String marker : UI_THINKING_MARKERS) {
            result = result.replace(marker, "");
        }
        return result.replaceFirst("^\\s*\\n+", "").trim();
    }

    private String stripTrailingPrefix(String value, String token) {
        int max = Math.min(value.length(), token.length() - 1);
        for (int len = max; len > 0; len--) {
            if (token.startsWith(value.substring(value.length() - len))) {
                return value.substring(0, value.length() - len);
            }
        }
        return value;
    }
}
