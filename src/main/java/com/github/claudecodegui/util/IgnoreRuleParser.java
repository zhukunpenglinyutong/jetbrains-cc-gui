package com.github.claudecodegui.util;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Parser for .gitignore-format ignore rule files.
 * Supports standard .gitignore syntax:
 * - # comment lines
 * - ! negation rules
 * - * and ** wildcards
 * - trailing / means directory only
 * - leading / means anchored to root
 */
public class IgnoreRuleParser {

    /**
     * A parsed ignore rule.
     */
    public static class IgnoreRule {
        private final String pattern;
        private final boolean negated;      // Whether this is a negation rule (starts with !)
        private final boolean directoryOnly; // Whether this rule only matches directories (ends with /)
        private final boolean anchored;      // Whether this rule is anchored to root (starts with / or contains /)
        private final String regexPattern;   // The converted regex pattern

        public IgnoreRule(String rawPattern) {
            String pattern = rawPattern.trim();

            // Check if this is a negation rule
            this.negated = pattern.startsWith("!");
            if (this.negated) {
                pattern = pattern.substring(1);
            }

            // Check if it only matches directories
            this.directoryOnly = pattern.endsWith("/");
            if (this.directoryOnly) {
                pattern = pattern.substring(0, pattern.length() - 1);
            }

            // Check if it is anchored to the root
            boolean startsWithSlash = pattern.startsWith("/");
            if (startsWithSlash) {
                pattern = pattern.substring(1);
            }

            // Anchored to root if it contains / or starts with /
            this.anchored = startsWithSlash || pattern.contains("/");

            this.pattern = pattern;
            this.regexPattern = convertToRegex(pattern);
        }

        /**
         * Convert a gitignore pattern to a regular expression.
         */
        private String convertToRegex(String pattern) {
            StringBuilder regex = new StringBuilder();

            for (int i = 0; i < pattern.length(); i++) {
                char c = pattern.charAt(i);
                switch (c) {
                    case '*':
                        // ** matches any path (including /)
                        if (i + 1 < pattern.length() && pattern.charAt(i + 1) == '*') {
                            i++; // skip the second *

                            // **/ semantics: matches any depth of directories (including zero levels), must end at a / boundary
                            if (i + 1 < pattern.length() && pattern.charAt(i + 1) == '/') {
                                regex.append("(?:.*/)?");
                                i++; // skip the /
                            } else {
                                // ** semantics: matches any character (including /)
                                regex.append(".*");
                            }
                        } else {
                            // Single * matches any character except /
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
     * Parse a .gitignore file.
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

                // Skip empty lines and comments
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }

                rules.add(new IgnoreRule(line));
            }
        }

        return rules;
    }

    /**
     * Parse a .gitignore file.
     */
    public static List<IgnoreRule> parse(Path gitignorePath) throws IOException {
        return parse(gitignorePath.toFile());
    }

    /**
     * Parse rules from string content.
     */
    public static List<IgnoreRule> parseContent(String content) {
        List<IgnoreRule> rules = new ArrayList<>();

        if (content == null || content.isEmpty()) {
            return rules;
        }

        for (String line : content.split("\n")) {
            line = line.trim();

            // Skip empty lines and comments
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }

            rules.add(new IgnoreRule(line));
        }

        return rules;
    }
}
