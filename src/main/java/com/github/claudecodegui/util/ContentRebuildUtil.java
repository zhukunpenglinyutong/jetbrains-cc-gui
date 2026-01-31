package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * 内容重建工具类
 * 通过反向应用编辑操作，从编辑后内容推导出编辑前内容
 */
public final class ContentRebuildUtil {

    private static final Logger LOG = Logger.getInstance(ContentRebuildUtil.class);

    private ContentRebuildUtil() {
    }

    /**
     * 反向重建编辑前内容
     *
     * 注意：如果文件被 linter/formatter 修改过，newString 可能无法精确匹配。
     * 此时会尝试标准化空白后再匹配，如果仍失败则跳过该操作继续处理。
     */
    public static String rebuildBeforeContent(String afterContent, JsonArray edits) {
        String content = afterContent;

        // 反向遍历编辑操作
        for (int i = edits.size() - 1; i >= 0; i--) {
            JsonObject edit = edits.get(i).getAsJsonObject();
            String oldString = edit.has("oldString") ? edit.get("oldString").getAsString() : "";
            String newString = edit.has("newString") ? edit.get("newString").getAsString() : "";
            boolean replaceAll = edit.has("replaceAll") && edit.get("replaceAll").getAsBoolean();

            if (replaceAll) {
                content = reverseReplaceAll(content, oldString, newString);
            } else {
                content = reverseReplaceSingle(content, oldString, newString);
            }
        }

        LOG.info("Successfully rebuilt before content (" + edits.size() + " operations)");
        return content;
    }

    private static String reverseReplaceAll(String content, String oldString, String newString) {
        if (content.contains(newString)) {
            return content.replace(newString, oldString);
        }
        // 尝试标准化空白后匹配
        String normalizedNew = normalizeWhitespace(newString);
        String normalizedContent = normalizeWhitespace(content);
        if (normalizedContent.contains(normalizedNew)) {
            return replaceNormalized(content, newString, oldString);
        }
        LOG.warn("rebuildBeforeContent: newString not found (replace_all), skipping operation");
        return content;
    }

    private static String reverseReplaceSingle(String content, String oldString, String newString) {
        int index = content.indexOf(newString);
        if (index >= 0) {
            return content.substring(0, index) + oldString + content.substring(index + newString.length());
        }
        // 尝试标准化空白后匹配
        int fuzzyIndex = findNormalizedIndex(content, newString);
        if (fuzzyIndex >= 0) {
            int actualEnd = findActualEndIndex(content, fuzzyIndex, newString);
            return content.substring(0, fuzzyIndex) + oldString + content.substring(actualEnd);
        }
        LOG.warn("rebuildBeforeContent: newString not found, skipping operation");
        return content;
    }

    /**
     * 标准化空白字符（用于模糊匹配）
     */
    static String normalizeWhitespace(String s) {
        if (s == null) return "";
        return s.replaceAll("\\s+", " ").trim();
    }

    /**
     * 在标准化空白后查找子串位置
     */
    static int findNormalizedIndex(String content, String target) {
        String normalizedTarget = normalizeWhitespace(target);
        String[] lines = content.split("\n", -1);
        int charIndex = 0;

        for (int lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            StringBuilder remainingBuilder = new StringBuilder();
            for (int j = lineIdx; j < lines.length; j++) {
                if (j > lineIdx) remainingBuilder.append("\n");
                remainingBuilder.append(lines[j]);
            }
            String normalizedRemaining = normalizeWhitespace(remainingBuilder.toString());

            if (normalizedRemaining.startsWith(normalizedTarget) ||
                normalizedRemaining.contains(normalizedTarget)) {
                return charIndex;
            }
            charIndex += lines[lineIdx].length() + 1;
        }
        return -1;
    }

    /**
     * 找到实际的结束索引（考虑空白差异）
     */
    static int findActualEndIndex(String content, int startIndex, String target) {
        String normalizedTarget = normalizeWhitespace(target);
        int targetNormalizedLen = normalizedTarget.length();

        int normalizedCount = 0;
        int actualIndex = startIndex;

        while (actualIndex < content.length() && normalizedCount < targetNormalizedLen) {
            char c = content.charAt(actualIndex);
            if (!Character.isWhitespace(c) ||
                (normalizedCount > 0 && normalizedCount < normalizedTarget.length() &&
                 normalizedTarget.charAt(normalizedCount) == ' ')) {
                normalizedCount++;
            }
            actualIndex++;
        }

        // 跳过尾部空白（但不跳过换行符）
        while (actualIndex < content.length() &&
               Character.isWhitespace(content.charAt(actualIndex)) &&
               content.charAt(actualIndex) != '\n') {
            actualIndex++;
        }

        return actualIndex;
    }

    /**
     * 使用标准化匹配进行替换
     */
    static String replaceNormalized(String content, String target, String replacement) {
        int index = findNormalizedIndex(content, target);
        if (index < 0) return content;

        int endIndex = findActualEndIndex(content, index, target);
        return content.substring(0, index) + replacement + content.substring(endIndex);
    }
}
