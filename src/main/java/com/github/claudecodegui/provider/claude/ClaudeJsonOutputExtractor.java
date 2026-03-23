package com.github.claudecodegui.provider.claude;

/**
 * Shared helpers for parsing mixed stdout output from Node.js bridge commands.
 */
class ClaudeJsonOutputExtractor {

    String extractBetween(String text, String start, String end) {
        int startIdx = text.indexOf(start);
        if (startIdx == -1) {
            return null;
        }
        startIdx += start.length();

        int endIdx = text.indexOf(end, startIdx);
        if (endIdx == -1) {
            return null;
        }

        return text.substring(startIdx, endIdx);
    }

    String extractLastJsonLine(String outputStr) {
        if (outputStr == null || outputStr.isEmpty()) {
            return null;
        }

        String[] lines = outputStr.split("\\r?\\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.startsWith("{") && line.endsWith("}")) {
                return line;
            }
        }

        if (outputStr.startsWith("{") && outputStr.endsWith("}")) {
            return outputStr;
        }

        int jsonStart = outputStr.indexOf("{");
        if (jsonStart != -1) {
            return outputStr.substring(jsonStart);
        }

        return null;
    }

    String extractErrorMessage(Throwable throwable) {
        if (throwable == null) {
            return "Unknown error";
        }

        Throwable current = throwable;
        while (current != null) {
            String msg = current.getMessage();
            if (msg != null && !msg.trim().isEmpty()) {
                return msg;
            }
            current = current.getCause();
        }
        return throwable.getClass().getSimpleName();
    }
}
