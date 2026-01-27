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
 * 匹配文件路径与 ignore 规则
 * 支持多个 .gitignore 文件的层级规则
 */
public class IgnoreRuleMatcher {

    private static final Logger LOG = Logger.getInstance(IgnoreRuleMatcher.class);

    private final List<CompiledRule> compiledRules = new ArrayList<>();
    private final String basePath;

    // 缓存已编译的正则表达式，避免重复编译
    private static final ConcurrentHashMap<String, Pattern> PATTERN_CACHE = new ConcurrentHashMap<>();
    private static final int MAX_CACHE_SIZE = 1000;

    /**
     * 编译后的规则，包含预编译的正则表达式
     */
    private static class CompiledRule {
        final IgnoreRule rule;
        final Pattern pattern;
        final Pattern anchoredPattern;

        CompiledRule(IgnoreRule rule) {
            this.rule = rule;
            String regex = rule.getRegexPattern();

            // 非锚定模式：可以匹配路径中任意位置的文件/目录名
            // 例如 "ZKP.md" 应该匹配 "ZKP.md"、"foo/ZKP.md"、"foo/bar/ZKP.md"
            // 需要确保匹配到路径分段边界，避免 "build" 误匹配 "build2"
            this.pattern = getOrCompilePattern("(^|.*/)" + regex + "(?:/.*)?$");

            // 锚定模式：必须从根开始匹配
            // 同样需要分段边界，避免 "foo/bar" 误匹配 "foo/bar2"
            this.anchoredPattern = getOrCompilePattern("^" + regex + "(?:/.*)?$");
        }

        private Pattern getOrCompilePattern(String regex) {
            // 简单的缓存大小控制
            if (PATTERN_CACHE.size() > MAX_CACHE_SIZE) {
                PATTERN_CACHE.clear();
            }
            // 仅在 Windows/macOS 使用不区分大小写；Linux 通常区分大小写
            boolean caseInsensitive = SystemInfo.isWindows || SystemInfo.isMac;
            int flags = caseInsensitive ? Pattern.CASE_INSENSITIVE : 0;
            String cacheKey = (caseInsensitive ? "(?i)" : "(?c)") + regex;
            return PATTERN_CACHE.computeIfAbsent(cacheKey, k -> Pattern.compile(regex, flags));
        }
    }

    /**
     * 创建规则匹配器
     */
    public IgnoreRuleMatcher(String basePath) {
        this.basePath = normalizePath(basePath);
    }

    /**
     * 从 .gitignore 文件加载规则
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
     * 从字符串内容加载规则
     */
    public void loadRulesFromContent(String content) {
        List<IgnoreRule> rules = IgnoreRuleParser.parseContent(content);
        for (IgnoreRule rule : rules) {
            compiledRules.add(new CompiledRule(rule));
        }
    }

    /**
     * 判断路径是否应该被忽略
     */
    public boolean isIgnored(String path, boolean isDirectory) {
        if (compiledRules.isEmpty()) {
            return false;
        }

        String normalizedPath = normalizePath(path);

        // 如果路径以 basePath 开头，转换为相对路径
        if (normalizedPath.startsWith(basePath)) {
            normalizedPath = normalizedPath.substring(basePath.length());
            if (normalizedPath.startsWith("/")) {
                normalizedPath = normalizedPath.substring(1);
            }
        }

        boolean ignored = false;

        // 按顺序应用规则，后面的规则可以覆盖前面的
        for (CompiledRule compiled : compiledRules) {
            IgnoreRule rule = compiled.rule;

            // 如果规则仅匹配目录，但当前不是目录，跳过
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
     * 获取当前加载的规则数量
     */
    public int getRuleCount() {
        return compiledRules.size();
    }

    /**
     * 清除所有规则
     */
    public void clear() {
        compiledRules.clear();
    }

    /**
     * 归一化路径
     */
    private String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        return path.replace('\\', '/');
    }

    /**
     * 将路径追加一个分段边界，便于规则在不引入误匹配的情况下匹配目录/文件名。
     * 例如 rule "build" 的正则 "build" 不应匹配 "build2"；追加 "/" 后可利用边界判断。
     */
    private String ensureSegmentBoundary(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        return path.endsWith("/") ? path : path + "/";
    }

    /**
     * 静态工厂方法：创建并加载项目根目录的 .gitignore
     */
    public static IgnoreRuleMatcher forProject(String projectBasePath) {
        IgnoreRuleMatcher matcher = new IgnoreRuleMatcher(projectBasePath);

        // 加载根目录的 .gitignore
        File rootGitignore = new File(projectBasePath, ".gitignore");
        if (rootGitignore.exists()) {
            matcher.loadRules(rootGitignore);
        }

        return matcher;
    }
}
