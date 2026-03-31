package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.ShellExecutor;
import com.google.gson.JsonObject;
import com.intellij.util.net.HttpConfigurable;
import com.intellij.openapi.diagnostic.Logger;

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
 * Environment configurator.
 * Responsible for configuring process environment variables.
 */
public class EnvironmentConfigurator {

    private static final Logger LOG = Logger.getInstance(EnvironmentConfigurator.class);
    private static final String CLAUDE_PERMISSION_ENV = "CLAUDE_PERMISSION_DIR";
    private static final String CLAUDE_SESSION_ID_ENV = "CLAUDE_SESSION_ID";
    private static final String CODEX_HOME_ENV = "CODEX_HOME";
    private static final String PROXY_MODE_NONE = "none";
    private static final String PROXY_MODE_IDE = "ide";
    private static final String PROXY_MODE_CUSTOM = "custom";
    private static final String[] MANAGED_PROXY_ENV_VARS = {
            "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
            "http_proxy", "https_proxy", "no_proxy", "all_proxy"
    };

    private volatile String cachedPermissionDir = null;
    private volatile String sessionId = null;

    // Cache for Codex env_key values from config.toml
    private volatile Map<String, String> cachedCodexEnvVars = null;

    /**
     * Updates the process environment variables, ensuring PATH includes the Node.js directory.
     * Supports both Windows (Path) and Unix (PATH) naming conventions.
     * The configured Node.js directory is prepended to PATH with highest priority.
     */
    public void updateProcessEnvironment(ProcessBuilder pb, String nodeExecutable) {
        Map<String, String> env = pb.environment();

        // Use PlatformUtils to get the PATH variable (case-insensitive)
        String path = PlatformUtils.isWindows() ?
                              PlatformUtils.getEnvIgnoreCase("PATH") :
                              env.get("PATH");

        if (path == null) {
            path = "";
        }

        StringBuilder newPath = new StringBuilder();
        String separator = File.pathSeparator;

        // 1. Prepend the directory containing Node.js with highest priority
        //    Remove it from existing PATH first to avoid duplicates
        if (nodeExecutable != null && !nodeExecutable.equals("node")) {
            File nodeFile = new File(nodeExecutable);
            String nodeDir = nodeFile.getParent();
            if (nodeDir != null) {
                // Remove existing nodeDir from PATH to avoid duplicates
                String cleanedPath = removePathEntry(path, nodeDir);
                // Prepend nodeDir at the beginning for highest priority
                newPath.append(nodeDir);
                if (!cleanedPath.isEmpty()) {
                    newPath.append(separator).append(cleanedPath);
                }
            } else {
                newPath.append(path);
            }
        } else {
            newPath.append(path);
        }

        // 2. Add common paths based on the platform (append to the end)
        String currentPath = newPath.toString();
        if (PlatformUtils.isWindows()) {
            // Common Windows paths
            String[] windowsPaths = {
                    System.getenv("ProgramFiles") + "\\nodejs",
                    System.getenv("APPDATA") + "\\npm",
                    System.getenv("LOCALAPPDATA") + "\\Programs\\nodejs"
            };
            for (String p : windowsPaths) {
                if (!p.contains("null") && !pathContains(currentPath, p)) {
                    newPath.append(separator).append(p);
                }
            }
        } else {
            // Common macOS/Linux paths
            String userHome = PlatformUtils.getHomeDirectory();
            String[] unixPaths = {
                    "/usr/local/bin",
                    "/opt/homebrew/bin",
                    "/usr/bin",
                    "/bin",
                    "/usr/sbin",
                    "/sbin",
                    userHome + "/.nvm/current/bin",
                    // Python / uv / pip tool installation directory (uvx, uv, etc.)
                    userHome + "/.local/bin",
                    // Rust / cargo tool installation directory
                    userHome + "/.cargo/bin",
            };
            for (String p : unixPaths) {
                if (!pathContains(currentPath, p)) {
                    newPath.append(separator).append(p);
                }
            }
        }

        // 3. Set the PATH environment variable
        // Windows requires setting both PATH and Path (some programs only recognize one)
        String newPathStr = newPath.toString();
        if (PlatformUtils.isWindows()) {
            // Remove potentially existing old values to avoid duplicates
            env.remove("PATH");
            env.remove("Path");
            env.remove("path");
            // Set multiple case variations to ensure compatibility
            env.put("PATH", newPathStr);
            env.put("Path", newPathStr);
        } else {
            env.put("PATH", newPathStr);
        }

        // 4. Ensure the HOME environment variable is set correctly
        // The SDK needs HOME to locate the ~/.claude/commands/ directory
        String home = env.get("HOME");
        if (home == null || home.isEmpty()) {
            home = PlatformUtils.getHomeDirectory();
            if (home != null && !home.isEmpty()) {
                env.put("HOME", home);
            }
        }

        // 5. Ensure CODEX_HOME is stable and non-empty (Codex uses it to locate config/sessions/skills)
        // Environment variables may be missing when launched from macOS GUI; relying on implicit defaults causes unstable feature detection (e.g. skills tool appearing intermittently)
        String codexHome = env.get(CODEX_HOME_ENV);
        if (codexHome == null || codexHome.trim().isEmpty()) {
            String userHome = PlatformUtils.getHomeDirectory();
            if (userHome != null && !userHome.isEmpty()) {
                env.put(CODEX_HOME_ENV, Paths.get(userHome, ".codex").toString());
            }
        }

        configureProxyEnv(env);
        configurePermissionEnv(env);
    }

    public void configureProxyEnv(Map<String, String> env) {
        if (env == null) {
            return;
        }

        try {
            JsonObject proxyConfig = loadProxyConfig();
            if (proxyConfig == null) {
                return;
            }
            configureProxyEnv(env, proxyConfig);
        } catch (Exception e) {
            LOG.warn("[EnvironmentConfigurator] Failed to load proxy config: " + e.getMessage());
        }
    }

    JsonObject loadProxyConfig() throws java.io.IOException {
        JsonObject config = new CodemossSettingsService().readConfig();
        if (!config.has("proxy") || !config.get("proxy").isJsonObject()) {
            return null;
        }
        return config.getAsJsonObject("proxy").deepCopy();
    }

    public void configureProxyEnv(Map<String, String> env, JsonObject proxyConfig) {
        if (env == null) {
            return;
        }

        String mode = readProxyString(proxyConfig, "mode");
        if (mode.isEmpty()) {
            mode = PROXY_MODE_NONE;
        }

        switch (mode) {
            case PROXY_MODE_IDE:
                configureIdeProxyEnv(env, HttpConfigurable.getInstance());
                return;
            case PROXY_MODE_CUSTOM:
                configureCustomProxyEnv(env, proxyConfig);
                return;
            case PROXY_MODE_NONE:
            default:
                clearManagedProxyEnv(env);
        }
    }

    void configureIdeProxyEnv(Map<String, String> env, HttpConfigurable httpConfigurable) {
        clearManagedProxyEnv(env);
        if (env == null || httpConfigurable == null) {
            return;
        }

        if (!httpConfigurable.USE_HTTP_PROXY
                || httpConfigurable.PROXY_HOST == null || httpConfigurable.PROXY_HOST.isBlank()
                || httpConfigurable.PROXY_PORT <= 0
                || isIdeSocksProxy(httpConfigurable)) {
            return;
        }

        String proxyUrl = buildProxyUrl("http", httpConfigurable.PROXY_HOST, httpConfigurable.PROXY_PORT);
        setManagedProxyEnv(env, proxyUrl, readIdeNoProxy(httpConfigurable));
    }

    private void configureCustomProxyEnv(Map<String, String> env, JsonObject proxyConfig) {
        clearManagedProxyEnv(env);
        String proxyUrl = readProxyString(proxyConfig, "customProxyUrl");
        if (!isSupportedProxyUrl(proxyUrl)) {
            LOG.warn("[EnvironmentConfigurator] Invalid custom proxy URL in config, skipping proxy injection");
            return;
        }
        setManagedProxyEnv(env, proxyUrl, readProxyString(proxyConfig, "noProxy"));
    }

    private void setManagedProxyEnv(Map<String, String> env, String proxyUrl, String noProxy) {
        env.put("HTTP_PROXY", proxyUrl);
        env.put("HTTPS_PROXY", proxyUrl);
        env.put("http_proxy", proxyUrl);
        env.put("https_proxy", proxyUrl);

        if (noProxy == null || noProxy.isBlank()) {
            env.remove("NO_PROXY");
            env.remove("no_proxy");
        } else {
            env.put("NO_PROXY", noProxy);
            env.put("no_proxy", noProxy);
        }
    }

    private void clearManagedProxyEnv(Map<String, String> env) {
        for (String envVar : MANAGED_PROXY_ENV_VARS) {
            env.remove(envVar);
        }
    }

    private String readProxyString(JsonObject proxyConfig, String key) {
        if (proxyConfig == null || !proxyConfig.has(key) || proxyConfig.get(key).isJsonNull()) {
            return "";
        }
        return proxyConfig.get(key).getAsString().trim();
    }

    private boolean isSupportedProxyUrl(String proxyUrl) {
        if (proxyUrl == null || proxyUrl.isBlank()) {
            return false;
        }
        try {
            java.net.URI uri = java.net.URI.create(proxyUrl.trim());
            String scheme = uri.getScheme();
            return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    && uri.getHost() != null && !uri.getHost().isBlank()
                    && uri.getPort() > 0;
        } catch (Exception e) {
            return false;
        }
    }

    private String buildProxyUrl(String scheme, String host, int port) {
        return scheme + "://" + host + ":" + port;
    }

    private String readIdeNoProxy(HttpConfigurable httpConfigurable) {
        Object value = readReflectiveMember(httpConfigurable, "PROXY_EXCEPTIONS");
        if (value instanceof String) {
            return ((String) value).trim();
        }
        value = readReflectiveMember(httpConfigurable, "getProxyExceptions");
        if (value instanceof String) {
            return ((String) value).trim();
        }
        return "";
    }

    private boolean isIdeSocksProxy(HttpConfigurable httpConfigurable) {
        Object value = readReflectiveMember(httpConfigurable, "PROXY_TYPE_IS_SOCKS");
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        value = readReflectiveMember(httpConfigurable, "PROXY_TYPE");
        if (value instanceof Number) {
            return ((Number) value).intValue() != 0;
        }
        return false;
    }

    private Object readReflectiveMember(HttpConfigurable httpConfigurable, String name) {
        try {
            try {
                java.lang.reflect.Field field = httpConfigurable.getClass().getField(name);
                return field.get(httpConfigurable);
            } catch (NoSuchFieldException ignored) {
                java.lang.reflect.Method method = httpConfigurable.getClass().getMethod(name);
                return method.invoke(httpConfigurable);
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    JsonObject loadProxyConfigSafely() {
        try {
            return loadProxyConfig();
        } catch (Exception e) {
            LOG.debug("[EnvironmentConfigurator] Failed to load proxy config for Codex env sync: " + e.getMessage());
            return null;
        }
    }

    boolean shouldSkipCodexEnvKey(String envKeyName, JsonObject proxyConfig) {
        return proxyConfig != null && isManagedProxyEnvVar(envKeyName);
    }

    private boolean isManagedProxyEnvVar(String envKeyName) {
        for (String envVar : MANAGED_PROXY_ENV_VARS) {
            if (envVar.equals(envKeyName)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Configures permission-related environment variables.
     */
    public void configurePermissionEnv(Map<String, String> env) {
        if (env == null) {
            return;
        }
        String permissionDir = getPermissionDirectory();
        if (permissionDir != null) {
            env.put(CLAUDE_PERMISSION_ENV, permissionDir);
        }
        String sid = getSessionId();
        if (sid != null) {
            env.put(CLAUDE_SESSION_ID_ENV, sid);
        }
    }

    /**
     * Get or generate session ID for this instance.
     *
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
     * Explicitly sets the session ID to align permission request routing
     * across multiple bridge instances.
     */
    public void setSessionId(String sessionId) {
        if (sessionId == null) {
            return;
        }
        String normalized = sessionId.trim();
        if (normalized.isEmpty()) {
            return;
        }
        this.sessionId = normalized;
    }

    /**
     * Gets the permission directory path.
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
     * Checks whether the PATH already contains the specified path.
     * Performs case-insensitive comparison on Windows.
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
     * Removes a specific path entry from the PATH environment variable.
     * Performs case-insensitive comparison on Windows.
     *
     * @param pathEnv    The PATH environment variable value
     * @param targetPath The path entry to remove
     * @return PATH with the target entry removed
     */
    private String removePathEntry(String pathEnv, String targetPath) {
        if (pathEnv == null || pathEnv.isEmpty() || targetPath == null || targetPath.isEmpty()) {
            return pathEnv != null ? pathEnv : "";
        }

        String separator = File.pathSeparator;
        String[] entries = pathEnv.split(Pattern.quote(separator));
        StringBuilder result = new StringBuilder();

        for (String entry : entries) {
            String trimmedEntry = entry.trim();
            if (trimmedEntry.isEmpty()) {
                continue;
            }
            // Case-insensitive comparison on Windows, case-sensitive on Unix
            boolean shouldSkip;
            if (PlatformUtils.isWindows()) {
                shouldSkip = trimmedEntry.equalsIgnoreCase(targetPath);
            } else {
                shouldSkip = trimmedEntry.equals(targetPath);
            }

            if (!shouldSkip) {
                if (result.length() > 0) {
                    result.append(separator);
                }
                result.append(trimmedEntry);
            }
        }

        return result.toString();
    }

    /**
     * Configures temporary directory environment variables.
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
     * Configures project path environment variables.
     */
    public void configureProjectPath(Map<String, String> env, String cwd) {
        if (env == null || cwd == null || cwd.isEmpty() || "undefined".equals(cwd) || "null".equals(cwd)) {
            return;
        }
        env.put("IDEA_PROJECT_PATH", cwd);
        env.put("PROJECT_PATH", cwd);
    }

    /**
     * Configures attachment-related environment variables.
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
     * Clears all cached values.
     */
    public void clearCache() {
        this.cachedPermissionDir = null;
        this.cachedCodexEnvVars = null;
    }

    /**
     * Configure Codex-specific environment variables.
     * Reads ~/.codex/config.toml to find custom env_key settings and loads those
     * environment variables from the system shell environment.
     * <p>
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
            JsonObject proxyConfig = loadProxyConfigSafely();

            // 2. Try to get values for each env_key from multiple sources
            for (String envKeyName : envKeyNames) {
                if (shouldSkipCodexEnvKey(envKeyName, proxyConfig)) {
                    LOG.debug("[Codex] Skip proxy env_key managed by plugin settings: " + envKeyName);
                    continue;
                }
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
        String home = PlatformUtils.getHomeDirectory();
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
        String home = PlatformUtils.getHomeDirectory();
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
