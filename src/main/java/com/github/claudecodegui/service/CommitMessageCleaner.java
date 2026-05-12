package com.github.claudecodegui.service;

final class CommitMessageCleaner {
    private static final String START = "<commit>";
    private static final String END = "</commit>";

    String clean(String raw) {
        if (raw == null) {
            return "";
        }
        String value = raw.trim();
        int start = value.indexOf(START);
        int end = value.indexOf(END);
        if (start >= 0 && end > start) {
            value = value.substring(start + START.length(), end).trim();
        }
        if (value.startsWith("```")) {
            int firstNewline = value.indexOf('\n');
            int lastFence = value.lastIndexOf("```");
            if (firstNewline >= 0 && lastFence > firstNewline) {
                value = value.substring(firstNewline + 1, lastFence).trim();
            }
        }
        value = value.replace("\\n", "\n");
        value = value.replaceAll("(?i)generated with .*", "").trim();
        return value.replaceAll("\\n{3,}", "\n\n").trim();
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
