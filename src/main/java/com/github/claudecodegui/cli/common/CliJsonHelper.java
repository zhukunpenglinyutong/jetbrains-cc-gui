package com.github.claudecodegui.cli.common;

import com.google.gson.JsonObject;

import java.io.File;
import java.util.List;
import java.util.Objects;
import java.util.stream.Stream;

/**
 * CLI 包共享 JSON 和通用工具方法，消除 ClaudeCliSession / CodexCliSession / CliSettings 中的重复代码。
 */
public final class CliJsonHelper {

    private CliJsonHelper() {
    }

    /**
     * Null 安全地从 JsonObject 取字符串值。值为 null、JsonNull 或空字符串时返回 null。
     */
    public static String safeString(JsonObject obj, String key) {
        if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        try {
            String value = obj.get(key).getAsString();
            if (value == null) {
                return null;
            }
            String trimmed = value.trim();
            return trimmed.isEmpty() ? null : trimmed;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Null 安全地从 JsonObject 取字符串值（不做 trim-is-empty 转换，保留原始值）。
     */
    public static String getString(JsonObject obj, String key) {
        if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        try {
            return obj.get(key).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Null 安全地从 JsonObject 取整数值。
     */
    public static int getInt(JsonObject obj, String key, int defaultValue) {
        if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return defaultValue;
        }
        try {
            return obj.get(key).getAsInt();
        } catch (Exception e) {
            return defaultValue;
        }
    }

    /**
     * 返回第一个非 null、非空白的值；全部为空则返回 null。
     */
    public static String firstNonBlank(String... values) {
        return Stream.of(values)
                .filter(Objects::nonNull)
                .filter(s -> !s.isBlank())
                .findFirst()
                .orElse(null);
    }

    /**
     * 清理临时文件列表中所有非 null 且存在的文件。
     */
    public static void cleanupTempFiles(List<File> files) {
        if (files == null) {
            return;
        }
        for (File f : files) {
            if (f != null && f.exists()) {
                try {
                    f.delete();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /**
     * 检测关键词列表中是否有任何一个被目标字符串包含（大小写不敏感）。
     */
    public static boolean containsAnyKeyword(String target, List<String> keywords) {
        if (target == null || keywords == null) {
            return false;
        }
        String lower = target.toLowerCase();
        return keywords.stream().anyMatch(lower::contains);
    }
}
