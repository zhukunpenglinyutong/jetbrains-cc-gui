package com.github.claudecodegui.bridge;

import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.ShellExecutor;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 环境配置器
 * 负责配置进程环境变量
 */
public class EnvironmentConfigurator {

    private static final Logger LOG = Logger.getInstance(EnvironmentConfigurator.class);
    private static final String CLAUDE_PERMISSION_ENV = "CLAUDE_PERMISSION_DIR";
    private static final String CLAUDE_SESSION_ID_ENV = "CLAUDE_SESSION_ID";

    private volatile String cachedPermissionDir = null;
    private volatile String sessionId = null;

    // Cache for Codex env_key values from config.toml
    private volatile Map<String, String> cachedCodexEnvVars = null;

    /**
     * 更新进程的环境变量，确保 PATH 包含 Node.js 所在目录
     * 支持 Windows (Path) 和 Unix (PATH) 环境变量命名
     */
    public void updateProcessEnvironment(ProcessBuilder pb, String nodeExecutable) {
        Map<String, String> env = pb.environment();

        // 使用 PlatformUtils 获取 PATH 环境变量（大小写不敏感）
        String path = PlatformUtils.isWindows() ?
            PlatformUtils.getEnvIgnoreCase("PATH") :
            env.get("PATH");

        if (path == null) {
            path = "";
        }

        StringBuilder newPath = new StringBuilder(path);
        String separator = File.pathSeparator;

        // 1. 添加 Node.js 所在目录
        if (nodeExecutable != null && !nodeExecutable.equals("node")) {
            File nodeFile = new File(nodeExecutable);
            String nodeDir = nodeFile.getParent();
            if (nodeDir != null && !pathContains(path, nodeDir)) {
                newPath.append(separator).append(nodeDir);
            }
        }

        // 2. 根据平台添加常用路径
        if (PlatformUtils.isWindows()) {
            // Windows 常用路径
            String[] windowsPaths = {
                System.getenv("ProgramFiles") + "\\nodejs",
                System.getenv("APPDATA") + "\\npm",
                System.getenv("LOCALAPPDATA") + "\\Programs\\nodejs"
            };
            for (String p : windowsPaths) {
                if (p != null && !p.contains("null") && !pathContains(path, p)) {
                    newPath.append(separator).append(p);
                }
            }
        } else {
            // macOS/Linux 常用路径
            String[] unixPaths = {
                "/usr/local/bin",
                "/opt/homebrew/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
                System.getProperty("user.home") + "/.nvm/current/bin"
            };
            for (String p : unixPaths) {
                if (!pathContains(path, p)) {
                    newPath.append(separator).append(p);
                }
            }
        }

        // 3. 设置 PATH 环境变量
        // Windows 需要同时设置 PATH 和 Path（某些程序只识别其中一个）
        String newPathStr = newPath.toString();
        if (PlatformUtils.isWindows()) {
            // 先移除可能存在的旧值，避免重复
            env.remove("PATH");
            env.remove("Path");
            env.remove("path");
            // 同时设置多种大小写形式确保兼容性
            env.put("PATH", newPathStr);
            env.put("Path", newPathStr);
        } else {
            env.put("PATH", newPathStr);
        }

        // 4. 确保 HOME 环境变量设置正确
        // SDK 需要 HOME 环境变量来找到 ~/.claude/commands/ 目录
        String home = env.get("HOME");
        if (home == null || home.isEmpty()) {
            home = System.getProperty("user.home");
            if (home != null && !home.isEmpty()) {
                env.put("HOME", home);
            }
        }

        configurePermissionEnv(env);
    }

    /**
     * 配置权限环境变量
     */
    public void configurePermissionEnv(Map<String, String> env) {
        if (env == null) {
            return;
        }
        String permissionDir = getPermissionDirectory();
        if (permissionDir != null) {
            env.putIfAbsent(CLAUDE_PERMISSION_ENV, permissionDir);
        }
        String sid = getSessionId();
        if (sid != null) {
            env.putIfAbsent(CLAUDE_SESSION_ID_ENV, sid);
        }
    }

    /**
     * Get or generate session ID for this instance.
     * @return Session ID
     */
    public String getSessionId() {
        if (this.sessionId == null) {
            synchronized (this) {
                if (this.sessionId == null) {
                    this.sessionId = java.util.UUID.randomUUID().toString();
                }
            }
        }
        return this.sessionId;
    }

    /**
     * 获取权限目录
     */
    public String getPermissionDirectory() {
        String cached = this.cachedPermissionDir;
        if (cached != null) {
            return cached;
        }

        Path dir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            LOG.error("[EnvironmentConfigurator] Failed to prepare permission dir: " + dir + " (" + e.getMessage() + ")");
        }
        cachedPermissionDir = dir.toAbsolutePath().toString();
        return cachedPermissionDir;
    }

    /**
     * 检查 PATH 中是否已包含指定路径
     * Windows 下进行大小写不敏感比较
     */
    private boolean pathContains(String pathEnv, String targetPath) {
        if (pathEnv == null || targetPath == null) {
            return false;
        }
        if (PlatformUtils.isWindows()) {
            return pathEnv.toLowerCase().contains(targetPath.toLowerCase());
        }
        return pathEnv.contains(targetPath);
    }

    /**
     * 配置临时目录环境变量
     */
    public void configureTempDir(Map<String, String> env, File tempDir) {
        if (env == null || tempDir == null) {
            return;
        }
        String tmpPath = tempDir.getAbsolutePath();
        env.put("TMPDIR", tmpPath);
        env.put("TEMP", tmpPath);
        env.put("TMP", tmpPath);
    }

    /**
     * 配置项目路径环境变量
     */
    public void configureProjectPath(Map<String, String> env, String cwd) {
        if (env == null || cwd == null || cwd.isEmpty() || "undefined".equals(cwd) || "null".equals(cwd)) {
            return;
        }
        env.put("IDEA_PROJECT_PATH", cwd);
        env.put("PROJECT_PATH", cwd);
    }

    /**
     * 配置附件相关环境变量
     */
    public void configureAttachmentEnv(Map<String, String> env, boolean hasAttachments) {
        if (env == null) {
            return;
        }
        if (hasAttachments) {
            env.put("CLAUDE_USE_STDIN", "true");
        }
    }

    /**
     * 清除缓存
     */
    public void clearCache() {
        this.cachedPermissionDir = null;
        this.cachedCodexEnvVars = null;
    }

    /**
     * Configure Codex-specific environment variables.
     * Reads ~/.codex/config.toml to find custom env_key settings and loads those
     * environment variables from the system shell environment.
     *
     * This is necessary because IDE processes often don't inherit shell environment
     * variables set in ~/.zshrc or ~/.bash_profile when launched from Dock/launcher.
     *
     * @param env ProcessBuilder environment map to update
     */
    public void configureCodexEnv(Map<String, String> env) {
        if (env == null) {
            return;
        }

        try {
            // 1. Find all env_key names from ~/.codex/config.toml
            Set<String> envKeyNames = parseCodexConfigEnvKeys();
            if (envKeyNames.isEmpty()) {
                LOG.debug("[Codex] No custom env_key found in config.toml");
                return;
            }

            LOG.info("[Codex] Found env_key names in config.toml: " + envKeyNames);

            // 2. Try to get values for each env_key from multiple sources
            for (String envKeyName : envKeyNames) {
                // Skip if already set in environment
                if (env.containsKey(envKeyName) && env.get(envKeyName) != null && !env.get(envKeyName).isEmpty()) {
                    LOG.debug("[Codex] Env var already set: " + envKeyName);
                    continue;
                }

                // Try to get value from system
                String value = resolveEnvValue(envKeyName);
                if (value != null && !value.isEmpty()) {
                    env.put(envKeyName, value);
                    LOG.info("[Codex] Set env var from shell: " + envKeyName + " (length: " + value.length() + ")");
                } else {
                    LOG.warn("[Codex] Could not resolve env var: " + envKeyName +
                            ". Please ensure it's set in your shell environment.");
                }
            }
        } catch (Exception e) {
            LOG.warn("[Codex] Error configuring Codex env: " + e.getMessage());
        }
    }

    /**
     * Parse ~/.codex/config.toml to extract all env_key values.
     *
     * @return Set of environment variable names referenced by env_key
     */
    private Set<String> parseCodexConfigEnvKeys() {
        Set<String> envKeys = new HashSet<>();
        String home = System.getProperty("user.home");
        if (home == null || home.isEmpty()) {
            return envKeys;
        }

        Path configPath = Paths.get(home, ".codex", "config.toml");
        if (!Files.exists(configPath)) {
            LOG.debug("[Codex] config.toml not found: " + configPath);
            return envKeys;
        }

        try {
            String content = Files.readString(configPath, StandardCharsets.UTF_8);

            // Pattern to match: env_key = "VALUE" or env_key = 'VALUE'
            Pattern pattern = Pattern.compile("env_key\\s*=\\s*[\"']([^\"']+)[\"']");
            Matcher matcher = pattern.matcher(content);

            while (matcher.find()) {
                String envKeyName = matcher.group(1).trim();
                if (!envKeyName.isEmpty()) {
                    envKeys.add(envKeyName);
                }
            }
        } catch (IOException e) {
            LOG.warn("[Codex] Failed to read config.toml: " + e.getMessage());
        }

        return envKeys;
    }

    /**
     * Resolve environment variable value from multiple sources.
     * Order of precedence:
     * 1. System.getenv() - already inherited env vars
     * 2. Shell environment via subprocess (macOS/Linux)
     * 3. Parse shell config files as fallback
     *
     * @param envName Environment variable name
     * @return Value or null if not found
     */
    private String resolveEnvValue(String envName) {
        // 1. Try System.getenv first (might already be inherited)
        String value = System.getenv(envName);
        if (value != null && !value.isEmpty()) {
            LOG.debug("[Codex] Env var found via System.getenv: " + envName);
            return value;
        }

        // 2. For macOS/Linux, try to get from shell environment
        if (!PlatformUtils.isWindows()) {
            value = getEnvFromShell(envName);
            if (value != null && !value.isEmpty()) {
                return value;
            }
        } else {
            // Windows: try to get from shell environment via cmd
            value = getEnvFromWindowsShell(envName);
            if (value != null && !value.isEmpty()) {
                return value;
            }
        }

        // 3. Parse shell config files as last resort
        value = parseEnvFromShellConfigs(envName);
        if (value != null && !value.isEmpty()) {
            return value;
        }

        return null;
    }

    /**
     * Validate environment variable name format.
     * Valid names start with a letter or underscore, followed by letters, digits, or underscores.
     * This prevents command injection when the name is used in shell commands.
     *
     * @param envName Environment variable name to validate
     * @return true if valid, false otherwise
     */
    private boolean isValidEnvName(String envName) {
        if (envName == null || envName.isEmpty()) {
            return false;
        }
        return envName.matches("^[a-zA-Z_][a-zA-Z0-9_]*$");
    }

    /**
     * Get environment variable by executing a login shell (macOS/Linux).
     * This captures environment variables set in .zshrc, .bash_profile, etc.
     *
     * @param envName Environment variable name
     * @return Value or null
     */
    private String getEnvFromShell(String envName) {
        // Validate env name to prevent command injection
        if (!isValidEnvName(envName)) {
            LOG.warn("[Codex] Invalid env var name, skipping: " + envName);
            return null;
        }

        // Use login + interactive shell to get full environment
        // fnm and other version managers require interactive shell to load .zshrc
        String shell = System.getenv("SHELL");
        if (shell == null || shell.isEmpty()) {
            shell = "/bin/zsh"; // Default to zsh on macOS
        }

        List<String> command = new ArrayList<>();
        command.add(shell);
        command.add("-l"); // Login shell
        command.add("-i"); // Interactive shell (needed for fnm, nvm etc.)
        command.add("-c");
        command.add("echo \"$" + envName + "\"");

        ShellExecutor.ExecutionResult result = ShellExecutor.executeAndGetLast(
                command,
                ShellExecutor.createShellOutputFilter(),
                "[Codex] getEnvFromShell(" + envName + ")",
                ShellExecutor.DEFAULT_TIMEOUT_SECONDS
        );

        if (result.isSuccess() && result.getOutput() != null) {
            LOG.debug("[Codex] Env var found via shell: " + envName);
            return result.getOutput();
        }

        return null;
    }

    /**
     * Get environment variable from Windows shell (cmd).
     *
     * @param envName Environment variable name
     * @return Value or null
     */
    private String getEnvFromWindowsShell(String envName) {
        // Validate env name to prevent command injection
        if (!isValidEnvName(envName)) {
            LOG.warn("[Codex] Invalid env var name, skipping: " + envName);
            return null;
        }

        try {
            List<String> command = new ArrayList<>();
            command.add("cmd");
            command.add("/c");
            command.add("echo %" + envName + "%");

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.redirectErrorStream(true);

            Process process = pb.start();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line = reader.readLine();
                process.waitFor();

                // Windows returns "%VARNAME%" if not set
                if (line != null && !line.trim().isEmpty() &&
                        !line.trim().equals("%" + envName + "%")) {
                    LOG.debug("[Codex] Env var found via Windows shell: " + envName);
                    return line.trim();
                }
            }
        } catch (Exception e) {
            LOG.debug("[Codex] Failed to get env from Windows shell: " + e.getMessage());
        }
        return null;
    }

    /**
     * Parse environment variable from shell config files.
     * Checks .zshrc, .bash_profile, .bashrc, .profile
     *
     * @param envName Environment variable name
     * @return Value or null
     */
    private String parseEnvFromShellConfigs(String envName) {
        String home = System.getProperty("user.home");
        if (home == null || home.isEmpty()) {
            return null;
        }

        // Shell config files to check (in order of preference)
        String[] configFiles;
        if (PlatformUtils.isWindows()) {
            // Windows doesn't use these, but check anyway
            configFiles = new String[]{};
        } else {
            configFiles = new String[]{
                    ".zshrc",
                    ".bash_profile",
                    ".bashrc",
                    ".profile",
                    ".zshenv",
                    ".zprofile"
            };
        }

        // Pattern to match: export VAR=value or VAR=value
        Pattern pattern = Pattern.compile(
                "(?:export\\s+)?" + Pattern.quote(envName) + "\\s*=\\s*[\"']?([^\"'\\n]+)[\"']?"
        );

        for (String configFile : configFiles) {
            Path configPath = Paths.get(home, configFile);
            if (!Files.exists(configPath)) {
                continue;
            }

            try {
                String content = Files.readString(configPath, StandardCharsets.UTF_8);
                Matcher matcher = pattern.matcher(content);

                if (matcher.find()) {
                    String value = matcher.group(1).trim();
                    if (!value.isEmpty()) {
                        LOG.debug("[Codex] Env var found in " + configFile + ": " + envName);
                        return value;
                    }
                }
            } catch (IOException e) {
                LOG.debug("[Codex] Failed to read " + configFile + ": " + e.getMessage());
            }
        }

        return null;
    }
}
