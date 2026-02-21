package com.github.claudecodegui.util;

import com.github.claudecodegui.util.IgnoreRuleParser.IgnoreRule;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.SystemInfo;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Matches file paths against ignore rules.
 * Supports hierarchical rules from multiple .gitignore files.
 */
public class IgnoreRuleMatcher {

    private static final Logger LOG = Logger.getInstance(IgnoreRuleMatcher.class);

    private final List<CompiledRule> compiledRules = new ArrayList<>();
    private final String basePath;

    // Cache compiled regex patterns to avoid recompilation
    private static final ConcurrentHashMap<String, Pattern> PATTERN_CACHE = new ConcurrentHashMap<>();
    private static final int MAX_CACHE_SIZE = 1000;

    // Cache matcher instances per project to avoid re-reading .gitignore on every editor event
    private static final ConcurrentHashMap<String, CachedMatcher> MATCHER_CACHE = new ConcurrentHashMap<>();
    private static final int MAX_MATCHER_CACHE_SIZE = 50;
    private static final long CACHE_TTL_MS = 30_000; // 30 seconds

    private static class CachedMatcher {
        final IgnoreRuleMatcher matcher;
        final long createdAt;

        CachedMatcher(IgnoreRuleMatcher matcher) {
            this.matcher = matcher;
            this.createdAt = System.currentTimeMillis();
        }

        boolean isExpired() {
            return System.currentTimeMillis() - createdAt > CACHE_TTL_MS;
        }
    }

    /**
     * A compiled rule containing pre-compiled regex patterns.
     */
    private static class CompiledRule {
        final IgnoreRule rule;
        final Pattern pattern;
        final Pattern anchoredPattern;

        CompiledRule(IgnoreRule rule) {
            this.rule = rule;
            String regex = rule.getRegexPattern();

            // Non-anchored pattern: can match a file/directory name at any position in the path
            // e.g., "ZKP.md" should match "ZKP.md", "foo/ZKP.md", "foo/bar/ZKP.md"
            // Must ensure matching respects path segment boundaries to avoid "build" matching "build2"
            this.pattern = getOrCompilePattern("(^|.*/)" + regex + "(?:/.*)?$");

            // Anchored pattern: must match from the root
            // Also requires segment boundaries to avoid "foo/bar" matching "foo/bar2"
            this.anchoredPattern = getOrCompilePattern("^" + regex + "(?:/.*)?$");
        }

        private Pattern getOrCompilePattern(String regex) {
            // Evict oldest entries when cache exceeds max size to avoid unbounded growth.
            // Using individual removal instead of clear() to prevent concurrent access issues.
            if (PATTERN_CACHE.size() > MAX_CACHE_SIZE) {
                int toRemove = PATTERN_CACHE.size() - MAX_CACHE_SIZE + MAX_CACHE_SIZE / 4;
                var iterator = PATTERN_CACHE.keySet().iterator();
                while (iterator.hasNext() && toRemove > 0) {
                    iterator.next();
                    iterator.remove();
                    toRemove--;
                }
            }
            // Use case-insensitive matching on Windows/macOS; Linux is typically case-sensitive
            boolean caseInsensitive = SystemInfo.isWindows || SystemInfo.isMac;
            int flags = caseInsensitive ? Pattern.CASE_INSENSITIVE : 0;
            String cacheKey = (caseInsensitive ? "(?i)" : "(?c)") + regex;
            return PATTERN_CACHE.computeIfAbsent(cacheKey, k -> Pattern.compile(regex, flags));
        }
    }

    /**
     * Create a rule matcher.
     */
    public IgnoreRuleMatcher(String basePath) {
        this.basePath = normalizePath(basePath);
    }

    /**
     * Load rules from a .gitignore file.
     */
    public void loadRules(File gitignoreFile) {
        try {
            List<IgnoreRule> rules = IgnoreRuleParser.parse(gitignoreFile);
            for (IgnoreRule rule : rules) {
                compiledRules.add(new CompiledRule(rule));
            }
            LOG.debug("[IgnoreRuleMatcher] Loaded " + rules.size() + " rules from " + gitignoreFile.getPath());
        } catch (IOException e) {
            LOG.warn("[IgnoreRuleMatcher] Failed to load rules from " + gitignoreFile.getPath() + ": " + e.getMessage());
        }
    }

    /**
     * Load rules from string content.
     */
    public void loadRulesFromContent(String content) {
        List<IgnoreRule> rules = IgnoreRuleParser.parseContent(content);
        for (IgnoreRule rule : rules) {
            compiledRules.add(new CompiledRule(rule));
        }
    }

    /**
     * Determine whether a path should be ignored.
     */
    public boolean isIgnored(String path, boolean isDirectory) {
        if (compiledRules.isEmpty()) {
            return false;
        }

        String normalizedPath = normalizePath(path);

        // If the path starts with basePath, convert to a relative path
        if (normalizedPath.startsWith(basePath)) {
            normalizedPath = normalizedPath.substring(basePath.length());
            if (normalizedPath.startsWith("/")) {
                normalizedPath = normalizedPath.substring(1);
            }
        }

        boolean ignored = false;

        // Apply rules in order; later rules can override earlier ones
        for (CompiledRule compiled : compiledRules) {
            IgnoreRule rule = compiled.rule;

            // If the rule only matches directories but the current path is not a directory, skip
            if (rule.isDirectoryOnly() && !isDirectory) {
                continue;
            }

            boolean matches;
            if (rule.isAnchored()) {
                matches = compiled.anchoredPattern.matcher(ensureSegmentBoundary(normalizedPath)).matches();
            } else {
                matches = compiled.pattern.matcher(ensureSegmentBoundary(normalizedPath)).matches();
            }

            if (matches) {
                ignored = !rule.isNegated();
            }
        }

        return ignored;
    }

    /**
     * Get the number of currently loaded rules.
     */
    public int getRuleCount() {
        return compiledRules.size();
    }

    /**
     * Clear all rules.
     */
    public void clear() {
        compiledRules.clear();
    }

    /**
     * Normalize a path.
     */
    private String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        return path.replace('\\', '/');
    }

    /**
     * Append a segment boundary to the path so rules can match directory/file names without false positives.
     * For example, the regex for rule "build" should not match "build2"; appending "/" enables boundary checking.
     */
    private String ensureSegmentBoundary(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        return path.endsWith("/") ? path : path + "/";
    }

    /**
     * Check if an absolute file path is ignored.
     * Uses the instance's basePath for relative path resolution.
     * Only checks file rules; directory-only rules (patterns ending with /) are not matched.
     *
     * @param absoluteFilePath the absolute path of the file to check
     * @return true if the file should be ignored
     */
    public boolean isFileIgnored(String absoluteFilePath) {
        if (absoluteFilePath == null) {
            return false;
        }
        return isIgnored(absoluteFilePath, false);
    }

    /**
     * Static factory method: create a matcher and load the project root .gitignore.
     */
    public static IgnoreRuleMatcher forProject(String projectBasePath) {
        IgnoreRuleMatcher matcher = new IgnoreRuleMatcher(projectBasePath);

        // Load the root .gitignore
        File rootGitignore = new File(projectBasePath, ".gitignore");
        if (rootGitignore.exists()) {
            matcher.loadRules(rootGitignore);
        }

        return matcher;
    }

    /**
     * Cached, null-safe factory method.
     * Returns a cached matcher instance for the given project path (30s TTL),
     * or null if creation fails.
     *
     * @param projectBasePath the project root path
     * @return matcher instance, or null on failure
     */
    public static IgnoreRuleMatcher forProjectSafe(String projectBasePath) {
        if (projectBasePath == null) {
            return null;
        }
        String key = projectBasePath.replace('\\', '/');
        CachedMatcher cached = MATCHER_CACHE.get(key);
        if (cached != null && !cached.isExpired()) {
            return cached.matcher;
        }
        try {
            IgnoreRuleMatcher matcher = forProject(projectBasePath);
            // Evict expired entries and enforce size limit
            if (MATCHER_CACHE.size() >= MAX_MATCHER_CACHE_SIZE) {
                MATCHER_CACHE.entrySet().removeIf(e -> e.getValue().isExpired());
                // If still over limit after purging expired, remove oldest entries
                if (MATCHER_CACHE.size() >= MAX_MATCHER_CACHE_SIZE) {
                    var iterator = MATCHER_CACHE.keySet().iterator();
                    int toRemove = MATCHER_CACHE.size() - MAX_MATCHER_CACHE_SIZE + 1;
                    while (iterator.hasNext() && toRemove > 0) {
                        iterator.next();
                        iterator.remove();
                        toRemove--;
                    }
                }
            }
            MATCHER_CACHE.put(key, new CachedMatcher(matcher));
            return matcher;
        } catch (Exception e) {
            LOG.warn("Failed to create .gitignore matcher: " + e.getMessage());
            return null;
        }
    }
}
