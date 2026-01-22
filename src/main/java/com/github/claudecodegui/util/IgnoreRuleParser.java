package com.github.claudecodegui.util;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 解析 .gitignore 格式的 ignore 规则文件
 * 支持标准 .gitignore 语法：
 * - # 注释行
 * - ! 取反规则
 * - * 和 ** 通配符
 * - / 结尾表示目录
 * - / 开头表示相对于根目录
 */
public class IgnoreRuleParser {

    /**
     * 解析后的 ignore 规则
     */
    public static class IgnoreRule {
        private final String pattern;
        private final boolean negated;      // 是否为取反规则（以 ! 开头）
        private final boolean directoryOnly; // 是否仅匹配目录（以 / 结尾）
        private final boolean anchored;      // 是否锚定到根目录（以 / 开头或包含 /）
        private final String regexPattern;   // 转换后的正则表达式

        public IgnoreRule(String rawPattern) {
            String pattern = rawPattern.trim();

            // 检查是否为取反规则
            this.negated = pattern.startsWith("!");
            if (this.negated) {
                pattern = pattern.substring(1);
            }

            // 检查是否仅匹配目录
            this.directoryOnly = pattern.endsWith("/");
            if (this.directoryOnly) {
                pattern = pattern.substring(0, pattern.length() - 1);
            }

            // 检查是否锚定到根目录
            boolean startsWithSlash = pattern.startsWith("/");
            if (startsWithSlash) {
                pattern = pattern.substring(1);
            }

            // 如果包含 / 或以 / 开头，则锚定到根目录
            this.anchored = startsWithSlash || pattern.contains("/");

            this.pattern = pattern;
            this.regexPattern = convertToRegex(pattern);
        }

        /**
         * 将 gitignore 模式转换为正则表达式
         */
        private String convertToRegex(String pattern) {
            StringBuilder regex = new StringBuilder();

            for (int i = 0; i < pattern.length(); i++) {
                char c = pattern.charAt(i);
                switch (c) {
                    case '*':
                        // ** 匹配任意路径（包括 /）
                        if (i + 1 < pattern.length() && pattern.charAt(i + 1) == '*') {
                            regex.append(".*");
                            i++; // 跳过第二个 *
                            // 如果后面紧跟 /，也跳过
                            if (i + 1 < pattern.length() && pattern.charAt(i + 1) == '/') {
                                i++;
                            }
                        } else {
                            // 单个 * 匹配除 / 外的任意字符
                            regex.append("[^/]*");
                        }
                        break;
                    case '?':
                        regex.append("[^/]");
                        break;
                    case '.':
                    case '(':
                    case ')':
                    case '+':
                    case '|':
                    case '^':
                    case '$':
                    case '@':
                    case '%':
                    case '{':
                    case '}':
                    case '[':
                    case ']':
                    case '\\':
                        regex.append("\\").append(c);
                        break;
                    default:
                        regex.append(c);
                }
            }

            return regex.toString();
        }

        public String getPattern() {
            return pattern;
        }

        public boolean isNegated() {
            return negated;
        }

        public boolean isDirectoryOnly() {
            return directoryOnly;
        }

        public boolean isAnchored() {
            return anchored;
        }

        public String getRegexPattern() {
            return regexPattern;
        }
    }

    /**
     * 解析 .gitignore 文件
     */
    public static List<IgnoreRule> parse(File gitignoreFile) throws IOException {
        List<IgnoreRule> rules = new ArrayList<>();

        if (!gitignoreFile.exists() || !gitignoreFile.isFile()) {
            return rules;
        }

        try (BufferedReader reader = new BufferedReader(new FileReader(gitignoreFile))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();

                // 跳过空行和注释
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }

                rules.add(new IgnoreRule(line));
            }
        }

        return rules;
    }

    /**
     * 解析 .gitignore 文件
     */
    public static List<IgnoreRule> parse(Path gitignorePath) throws IOException {
        return parse(gitignorePath.toFile());
    }

    /**
     * 从字符串内容解析规则
     */
    public static List<IgnoreRule> parseContent(String content) {
        List<IgnoreRule> rules = new ArrayList<>();

        if (content == null || content.isEmpty()) {
            return rules;
        }

        for (String line : content.split("\n")) {
            line = line.trim();

            // 跳过空行和注释
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }

            rules.add(new IgnoreRule(line));
        }

        return rules;
    }
}
