package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;

/**
 * Applies reverse edit operations to in-memory text.
 */
public final class UndoOperationApplier {

    private UndoOperationApplier() {
    }

    public static Result reverseEdits(String originalContent, JsonArray operations) {
        String content = originalContent != null ? originalContent : "";
        List<Failure> failures = new ArrayList<>();

        if (operations == null || operations.isEmpty()) {
            return Result.failure(content, List.of(new Failure(-1, "no_operations", "No operations to undo")));
        }

        String expectedAfterContentHash = firstExpectedAfterContentHash(operations);
        if (expectedAfterContentHash != null && !expectedAfterContentHash.equals(sha256(content))) {
            return Result.failure(content, List.of(new Failure(-1, "content_changed", "Current content no longer matches the captured LLM result")));
        }

        for (int i = operations.size() - 1; i >= 0; i--) {
            JsonObject op = operations.get(i).getAsJsonObject();
            String oldString = getString(op, "oldString", "old_string");
            String newString = getString(op, "newString", "new_string");
            boolean replaceAll = getBoolean(op, "replaceAll", "replace_all");
            Boolean safeToRollback = getOptionalBoolean(op, "safeToRollback", "safe_to_rollback");

            if (Boolean.FALSE.equals(safeToRollback)) {
                failures.add(new Failure(i, "unsafe_to_rollback", "Operation is marked unsafe to rollback"));
                continue;
            }

            if (newString.isEmpty()) {
                failures.add(new Failure(i, "empty_new_string_unsupported", "Cannot safely undo an operation with an empty newString"));
                continue;
            }

            if (replaceAll) {
                if (!content.contains(newString)) {
                    failures.add(new Failure(i, "new_string_not_found", "Could not find newString to replace"));
                    continue;
                }
                content = content.replace(newString, oldString);
                continue;
            }

            MatchResult match = findReplacementMatch(content, newString, op);
            if (!match.success()) {
                failures.add(new Failure(i, match.reason(), match.message()));
                continue;
            }
            int index = match.index();
            content = content.substring(0, index) + oldString + content.substring(index + newString.length());
        }

        if (!failures.isEmpty()) {
            return Result.failure(originalContent != null ? originalContent : "", failures);
        }
        return Result.success(content);
    }

    private static MatchResult findReplacementMatch(String content, String newString, JsonObject op) {
        Integer lineStart = getInteger(op, "lineStart", "start_line");
        Integer lineEnd = getInteger(op, "lineEnd", "end_line");
        if (lineStart != null && lineStart > 0) {
            int searchStartLine = Math.max(1, lineStart - 1);
            int searchEndLine = lineEnd != null && lineEnd >= lineStart ? lineEnd + 1 : lineStart + 1;
            int searchStart = charOffsetForLine(content, searchStartLine);
            int searchEnd = charOffsetForLine(content, searchEndLine + 1);
            List<Integer> nearbyMatches = findOccurrences(content, newString, searchStart, searchEnd);
            if (nearbyMatches.size() == 1) {
                return MatchResult.success(nearbyMatches.get(0));
            }
            if (nearbyMatches.size() > 1) {
                return MatchResult.failure("ambiguous_match", "Multiple nearby matches for newString");
            }
        }

        List<Integer> allMatches = findOccurrences(content, newString, 0, content.length());
        if (allMatches.isEmpty()) {
            return MatchResult.failure("new_string_not_found", "Could not find newString to replace");
        }
        if (allMatches.size() > 1) {
            return MatchResult.failure("ambiguous_match", "Multiple matches for newString");
        }
        return MatchResult.success(allMatches.get(0));
    }

    private static List<Integer> findOccurrences(String content, String needle, int startInclusive, int endExclusive) {
        List<Integer> indexes = new ArrayList<>();
        if (needle.isEmpty()) {
            return indexes;
        }
        int fromIndex = Math.max(0, startInclusive);
        int limit = Math.min(content.length(), Math.max(startInclusive, endExclusive));
        while (fromIndex <= limit) {
            int index = content.indexOf(needle, fromIndex);
            if (index < 0 || index + needle.length() > limit) {
                break;
            }
            indexes.add(index);
            fromIndex = index + Math.max(1, needle.length());
        }
        return indexes;
    }

    private static int charOffsetForLine(String content, int oneBasedLine) {
        if (oneBasedLine <= 1) {
            return 0;
        }
        int currentLine = 1;
        for (int i = 0; i < content.length(); i++) {
            if (content.charAt(i) == '\n') {
                currentLine++;
                if (currentLine == oneBasedLine) {
                    return i + 1;
                }
            }
        }
        return content.length();
    }

    private static String getString(JsonObject op, String camelName, String snakeName) {
        if (op.has(camelName) && !op.get(camelName).isJsonNull()) {
            return op.get(camelName).getAsString();
        }
        if (op.has(snakeName) && !op.get(snakeName).isJsonNull()) {
            return op.get(snakeName).getAsString();
        }
        return "";
    }

    private static boolean getBoolean(JsonObject op, String camelName, String snakeName) {
        if (op.has(camelName) && !op.get(camelName).isJsonNull()) {
            return op.get(camelName).getAsBoolean();
        }
        return op.has(snakeName) && !op.get(snakeName).isJsonNull() && op.get(snakeName).getAsBoolean();
    }

    private static Boolean getOptionalBoolean(JsonObject op, String camelName, String snakeName) {
        if (op.has(camelName) && !op.get(camelName).isJsonNull()) {
            return op.get(camelName).getAsBoolean();
        }
        if (op.has(snakeName) && !op.get(snakeName).isJsonNull()) {
            return op.get(snakeName).getAsBoolean();
        }
        return null;
    }

    private static Integer getInteger(JsonObject op, String camelName, String snakeName) {
        if (op.has(camelName) && !op.get(camelName).isJsonNull()) {
            return op.get(camelName).getAsInt();
        }
        if (op.has(snakeName) && !op.get(snakeName).isJsonNull()) {
            return op.get(snakeName).getAsInt();
        }
        return null;
    }

    private static String firstExpectedAfterContentHash(JsonArray operations) {
        for (int i = 0; i < operations.size(); i++) {
            if (!operations.get(i).isJsonObject()) {
                continue;
            }
            JsonObject op = operations.get(i).getAsJsonObject();
            String hash = getString(op, "expectedAfterContentHash", "expected_after_content_hash");
            if (!hash.isBlank()) {
                return hash;
            }
        }
        return null;
    }

    private static String sha256(String content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest((content != null ? content : "").getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            return Integer.toHexString((content != null ? content : "").hashCode());
        }
    }

    private record MatchResult(boolean success, int index, String reason, String message) {
        static MatchResult success(int index) {
            return new MatchResult(true, index, null, null);
        }

        static MatchResult failure(String reason, String message) {
            return new MatchResult(false, -1, reason, message);
        }
    }

    public static final class Result {
        private final boolean success;
        private final String content;
        private final List<Failure> failures;

        private Result(boolean success, String content, List<Failure> failures) {
            this.success = success;
            this.content = content;
            this.failures = Collections.unmodifiableList(new ArrayList<>(failures));
        }

        public static Result success(String content) {
            return new Result(true, content, List.of());
        }

        public static Result failure(String content, List<Failure> failures) {
            return new Result(false, content, failures);
        }

        public boolean isSuccess() {
            return success;
        }

        public String getContent() {
            return content;
        }

        public List<Failure> getFailures() {
            return failures;
        }

        public String toErrorMessage() {
            if (failures.isEmpty()) {
                return "Undo failed";
            }
            Failure first = failures.get(0);
            return first.reason() + ": " + first.message();
        }
    }

    public record Failure(int operationIndex, String reason, String message) {
    }
}
