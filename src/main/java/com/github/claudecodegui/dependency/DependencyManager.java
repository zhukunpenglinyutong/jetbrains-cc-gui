package com.github.claudecodegui.dependency;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SDK dependency manager.
 * Manages SDK installations under the ~/.codemoss/dependencies/ directory.
 */
public class DependencyManager {

    private static final Logger LOG = Logger.getInstance(DependencyManager.class);
    private static final String DEPS_DIR_NAME = "dependencies";
    private static final String MANIFEST_FILE = "manifest.json";
    private static final String INSTALLED_MARKER = ".installed";

    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final EnvironmentConfigurator envConfigurator;

    public DependencyManager() {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        this.nodeDetector = new NodeDetector();
        this.envConfigurator = new EnvironmentConfigurator();
    }

    public DependencyManager(NodeDetector nodeDetector) {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        this.nodeDetector = nodeDetector;
        this.envConfigurator = new EnvironmentConfigurator();
    }

    /**
     * Returns the root dependencies directory path (~/.codemoss/dependencies/).
     */
    public Path getDependenciesDir() {
        String home = System.getProperty("user.home");
        return Paths.get(home, ".codemoss", DEPS_DIR_NAME);
    }

    /**
     * Returns the installation directory for a given SDK.
     */
    public Path getSdkDir(String sdkId) {
        return getDependenciesDir().resolve(sdkId);
    }

    /**
     * Returns the node_modules directory for a given SDK.
     */
    public Path getSdkNodeModulesDir(String sdkId) {
        return getSdkDir(sdkId).resolve("node_modules");
    }

    /**
     * Checks whether an SDK is installed.
     */
    public boolean isInstalled(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return false;
        }

        // Check if the main package exists in node_modules
        Path packageDir = getPackageDir(sdkId, sdk.getNpmPackage());
        if (!Files.exists(packageDir)) {
            return false;
        }

        // If the package exists but the .installed marker file is missing, create it automatically.
        // This handles the case where the user ran npm install manually.
        Path sdkDir = getSdkDir(sdkId);
        Path markerFile = sdkDir.resolve(INSTALLED_MARKER);
        if (!Files.exists(markerFile)) {
            try {
                String version = getInstalledVersionFromPackage(sdkId, sdk.getNpmPackage());
                Files.writeString(markerFile, version != null ? version : "unknown");
                LOG.info("[DependencyManager] Created missing marker file for manually installed SDK: " + sdkId);
            } catch (Exception e) {
                LOG.warn("[DependencyManager] Failed to create marker file: " + e.getMessage());
            }
        }

        return true;
    }

    /**
     * Reads the version from package.json (internal use, does not depend on isInstalled).
     */
    private String getInstalledVersionFromPackage(String sdkId, String npmPackage) {
        Path packageJson = getPackageDir(sdkId, npmPackage).resolve("package.json");
        if (!Files.exists(packageJson)) {
            return null;
        }

        try (Reader reader = Files.newBufferedReader(packageJson, StandardCharsets.UTF_8)) {
            JsonObject json = JsonParser.parseReader(reader).getAsJsonObject();
            if (json.has("version")) {
                return json.get("version").getAsString();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to read version from package.json: " + e.getMessage());
        }

        return null;
    }

    /**
     * Returns the path of a package within node_modules.
     */
    private Path getPackageDir(String sdkId, String npmPackage) {
        // @scope/package -> node_modules/@scope/package
        String[] parts = npmPackage.split("/");
        Path nodeModules = getSdkNodeModulesDir(sdkId);
        Path packagePath = nodeModules;
        for (String part : parts) {
            packagePath = packagePath.resolve(part);
        }
        return packagePath;
    }

    /**
     * Returns the installed version.
     */
    public String getInstalledVersion(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null || !isInstalled(sdkId)) {
            return null;
        }

        return getInstalledVersionFromPackage(sdkId, sdk.getNpmPackage());
    }

    /**
     * Fetches the latest version from the NPM Registry.
     */
    public String getLatestVersion(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return null;
        }

        try {
            String nodePath = nodeDetector.findNodeExecutable();
            String npmPath = getNpmPath(nodePath);

            ProcessBuilder pb = new ProcessBuilder(
                npmPath, "view", sdk.getNpmPackage(), "version"
            );
            configureProcessEnvironment(pb);

            Process process = pb.start();
            StringBuilder output = new StringBuilder();

            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line.trim());
                }
            }

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return null;
            }

            if (process.exitValue() == 0) {
                return output.toString().trim();
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to get latest version: " + e.getMessage());
        }

        return null;
    }

    /**
     * Checks whether an update is available.
     */
    public UpdateInfo checkForUpdates(String sdkId) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return UpdateInfo.error(sdkId, "Unknown SDK", "Unknown SDK: " + sdkId);
        }

        if (!isInstalled(sdkId)) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "SDK not installed");
        }

        String currentVersion = getInstalledVersion(sdkId);
        if (currentVersion == null) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "Cannot read installed version");
        }

        String latestVersion = getLatestVersion(sdkId);
        if (latestVersion == null) {
            return UpdateInfo.error(sdkId, sdk.getDisplayName(), "Cannot fetch latest version");
        }

        if (compareVersions(currentVersion, latestVersion) < 0) {
            return UpdateInfo.updateAvailable(sdkId, sdk.getDisplayName(), currentVersion, latestVersion);
        }

        return UpdateInfo.noUpdate(sdkId, sdk.getDisplayName(), currentVersion);
    }

    /**
     * Installs an SDK (asynchronous).
     */
    public CompletableFuture<InstallResult> installSdk(String sdkId, Consumer<String> logCallback) {
        return CompletableFuture.supplyAsync(() -> installSdkSync(sdkId, logCallback));
    }

    /**
     * Installs an SDK (synchronous).
     */
    public InstallResult installSdkSync(String sdkId, Consumer<String> logCallback) {
        SdkDefinition sdk = SdkDefinition.fromId(sdkId);
        if (sdk == null) {
            return InstallResult.failure(sdkId, "Unknown SDK: " + sdkId, "");
        }

        StringBuilder logs = new StringBuilder();
        Consumer<String> log = (msg) -> {
            logs.append(msg).append("\n");
            if (logCallback != null) {
                logCallback.accept(msg);
            }
        };

        try {
            log.accept("Starting installation of " + sdk.getDisplayName() + "...");

            // 1. Check the Node.js environment
            String nodePath = nodeDetector.findNodeExecutable();
            if (nodePath == null || "node".equals(nodePath)) {
                String version = nodeDetector.verifyNodePath("node");
                if (version == null) {
                    return InstallResult.failure(sdkId,
                        "Node.js not found. Please configure Node.js path in Settings > Basic.",
                        logs.toString());
                }
            }
            log.accept("Using Node.js: " + nodePath);

            String npmPath = getNpmPath(nodePath);
            log.accept("Using npm: " + npmPath);

            // 2. Create the SDK directory
            Path sdkDir = getSdkDir(sdkId);

            // Path safety check: ensure sdkDir is within the expected dependencies directory to prevent path traversal attacks
            Path normalizedSdkDir = sdkDir.normalize().toAbsolutePath();
            Path normalizedDepsDir = getDependenciesDir().normalize().toAbsolutePath();
            if (!normalizedSdkDir.startsWith(normalizedDepsDir)) {
                return InstallResult.failure(sdkId,
                    "Security error: SDK directory path is outside dependencies directory",
                    logs.toString());
            }

            Files.createDirectories(sdkDir);
            log.accept("Created directory: " + sdkDir);

            // 3. Create package.json
            createPackageJson(sdkDir, sdk);
            log.accept("Created package.json");

            // 4. Pre-check npm cache permissions
            log.accept("Checking npm cache permissions...");
            if (!NpmPermissionHelper.checkCachePermission()) {
                log.accept("⚠️ Warning: npm cache may have permission issues, attempting to fix...");

                // Try to clean the cache
                if (NpmPermissionHelper.cleanNpmCache(npmPath)) {
                    log.accept("✓ npm cache cleaned successfully");
                } else if (NpmPermissionHelper.forceDeleteCache()) {
                    log.accept("✓ npm cache directory deleted successfully");
                } else {
                    log.accept("⚠️ Warning: Could not clean cache automatically, will try installation anyway");
                }
            }

            // 5. Run npm install (with retry mechanism)
            List<String> packages = sdk.getAllPackages();
            int maxRetries = 2;
            InstallResult lastResult = null;

            for (int attempt = 0; attempt <= maxRetries; attempt++) {
                if (attempt > 0) {
                    log.accept("\n🔄 Retry attempt " + attempt + "/" + maxRetries + "...");
                }

                log.accept("Running npm install...");
                List<String> command = NpmPermissionHelper.buildInstallCommandWithFallback(
                    npmPath, normalizedSdkDir, packages, attempt
                );
                log.accept("Command: " + String.join(" ", command));

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(sdkDir.toFile());
                pb.redirectErrorStream(true);
                configureProcessEnvironment(pb);

                Process process = pb.start();

                // Read output in real time and collect logs
                StringBuilder installLogs = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        log.accept(line);
                        installLogs.append(line).append("\n");
                    }
                }

                boolean finished = process.waitFor(3, TimeUnit.MINUTES);
                if (!finished) {
                    process.destroyForcibly();
                    lastResult = InstallResult.failure(sdkId,
                        "Installation timed out (3 minutes)", logs.toString());
                    continue; // Retry
                }

                int exitCode = process.exitValue();
                if (exitCode == 0) {
                    // Installation succeeded, proceed to next steps
                    break;
                }

                // Installation failed, record the result
                String logsStr = logs.toString();
                lastResult = InstallResult.failure(sdkId,
                    "npm install failed with exit code: " + exitCode, logsStr);

                // If this is the last attempt, do not retry
                if (attempt == maxRetries) {
                    // Append troubleshooting suggestions
                    String solution = NpmPermissionHelper.generateErrorSolution(logsStr);
                    return InstallResult.failure(sdkId,
                        lastResult.getErrorMessage() + solution,
                        lastResult.getLogs());
                }

                // Detect error type and attempt to fix
                boolean fixed = false;
                if (NpmPermissionHelper.hasPermissionError(logsStr) ||
                    NpmPermissionHelper.hasCacheError(logsStr)) {

                    log.accept("⚠️ Detected npm cache/permission error, attempting to fix...");

                    // Strategy 1: Clean the cache
                    if (NpmPermissionHelper.cleanNpmCache(npmPath)) {
                        log.accept("✓ Cache cleaned, will retry");
                        fixed = true;
                    } else if (NpmPermissionHelper.forceDeleteCache()) {
                        log.accept("✓ Cache deleted, will retry");
                        fixed = true;
                    }

                    // Strategy 2: Fix permissions (Unix only)
                    if (!fixed && !PlatformUtils.isWindows()) {
                        log.accept("Attempting to fix cache ownership (may require password)...");
                        if (NpmPermissionHelper.fixCacheOwnership()) {
                            log.accept("✓ Ownership fixed, will retry");
                            fixed = true;
                        }
                    }
                }

                if (!fixed) {
                    log.accept("⚠️ Could not auto-fix the issue, will retry with --force flag");
                }

                // Brief delay before retrying
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return InstallResult.failure(sdkId, "Installation interrupted", logs.toString());
                }
            }

            // 6. Create the installation marker file
            String installedVersion = getInstalledVersion(sdkId);
            Path markerFile = sdkDir.resolve(INSTALLED_MARKER);
            Files.writeString(markerFile, installedVersion != null ? installedVersion : "unknown");

            // 7. Update the manifest
            updateManifest(sdkId, installedVersion);

            log.accept("Installation completed successfully!");
            log.accept("Installed version: " + installedVersion);

            return InstallResult.success(sdkId, installedVersion, logs.toString());

        } catch (Exception e) {
            LOG.error("[DependencyManager] Installation failed: " + e.getMessage(), e);
            log.accept("ERROR: " + e.getMessage());
            return InstallResult.failure(sdkId, e.getMessage(), logs.toString());
        }
    }

    /**
     * Uninstalls an SDK.
     * @return true if the uninstallation completed fully, false if some files failed to delete
     */
    public boolean uninstallSdk(String sdkId) {
        try {
            Path sdkDir = getSdkDir(sdkId);
            if (!Files.exists(sdkDir)) {
                return true;
            }

            // Recursively delete the directory and collect paths that failed to delete
            List<Path> failedPaths = deleteDirectory(sdkDir);

            // Update the manifest
            removeFromManifest(sdkId);

            if (failedPaths.isEmpty()) {
                LOG.info("[DependencyManager] Uninstalled SDK completely: " + sdkId);
                return true;
            } else {
                // Some files failed to delete; log a warning but still return success (manifest is already updated)
                LOG.warn("[DependencyManager] Uninstalled SDK with " + failedPaths.size() +
                    " files failed to delete: " + sdkId);
                return true; // Still return true because the SDK is functionally uninstalled
            }
        } catch (Exception e) {
            LOG.error("[DependencyManager] Failed to uninstall SDK: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Returns the status of all SDKs.
     */
    public JsonObject getAllSdkStatus() {
        JsonObject result = new JsonObject();

        for (SdkDefinition sdk : SdkDefinition.values()) {
            JsonObject status = new JsonObject();
            boolean installed = isInstalled(sdk.getId());

            status.addProperty("id", sdk.getId());
            status.addProperty("name", sdk.getDisplayName());
            status.addProperty("description", sdk.getDescription());
            status.addProperty("npmPackage", sdk.getNpmPackage());
            status.addProperty("installed", installed);
            // Add the status field for frontend consumption
            status.addProperty("status", installed ? "installed" : "not_installed");

            if (installed) {
                String version = getInstalledVersion(sdk.getId());
                status.addProperty("installedVersion", version);
                status.addProperty("version", version); // Also add the version field
            }

            result.add(sdk.getId(), status);
        }

        return result;
    }

    /**
     * Checks whether the Node.js environment is available.
     */
    public boolean checkNodeEnvironment() {
        try {
            String nodePath = nodeDetector.findNodeExecutable();
            if (nodePath == null) {
                return false;
            }

            String version = nodeDetector.verifyNodePath(nodePath);
            return version != null;
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Node.js environment check failed: " + e.getMessage());
            return false;
        }
    }

    // ==================== Private methods ====================

    /**
     * Resolves the npm path based on the node path.
     */
    private String getNpmPath(String nodePath) {
        String npmName = PlatformUtils.isWindows() ? "npm.cmd" : "npm";

        // 1. Try to find npm in the same directory as Node.js
        if (nodePath != null && !"node".equals(nodePath)) {
            File nodeFile = new File(nodePath);
            String dir = nodeFile.getParent();
            if (dir != null) {
                File npmFile = new File(dir, npmName);
                if (npmFile.exists()) {
                    return npmFile.getAbsolutePath();
                }
            }
        }

        // 2. Windows: try to find the full path to npm.cmd from the PATH environment variable
        if (PlatformUtils.isWindows()) {
            String pathEnv = System.getenv("PATH");
            if (pathEnv != null) {
                for (String pathDir : pathEnv.split(File.pathSeparator)) {
                    File npmFile = new File(pathDir, npmName);
                    if (npmFile.exists()) {
                        LOG.info("[DependencyManager] Found npm in PATH: " + npmFile.getAbsolutePath());
                        return npmFile.getAbsolutePath();
                    }
                }
            }
        }

        // 3. Fall back to the bare command name (usually works on Unix)
        return PlatformUtils.isWindows() ? npmName : "npm";
    }

    /**
     * Configures the process environment variables.
     */
    private void configureProcessEnvironment(ProcessBuilder pb) {
        String nodePath = nodeDetector.findNodeExecutable();
        envConfigurator.updateProcessEnvironment(pb, nodePath);
    }

    /**
     * Creates the package.json file.
     */
    private void createPackageJson(Path sdkDir, SdkDefinition sdk) throws IOException {
        JsonObject packageJson = new JsonObject();
        packageJson.addProperty("name", sdk.getId() + "-container");
        packageJson.addProperty("version", "1.0.0");
        packageJson.addProperty("private", true);

        Path packageJsonPath = sdkDir.resolve("package.json");
        try (Writer writer = Files.newBufferedWriter(packageJsonPath, StandardCharsets.UTF_8)) {
            gson.toJson(packageJson, writer);
        }
    }

    /**
     * Updates the manifest.json file.
     */
    private void updateManifest(String sdkId, String version) {
        try {
            Path manifestPath = getDependenciesDir().resolve(MANIFEST_FILE);
            JsonObject manifest;

            if (Files.exists(manifestPath)) {
                try (Reader reader = Files.newBufferedReader(manifestPath, StandardCharsets.UTF_8)) {
                    manifest = JsonParser.parseReader(reader).getAsJsonObject();
                }
            } else {
                manifest = new JsonObject();
            }

            JsonObject sdkInfo = new JsonObject();
            sdkInfo.addProperty("version", version);
            sdkInfo.addProperty("installedAt", System.currentTimeMillis());
            manifest.add(sdkId, sdkInfo);

            try (Writer writer = Files.newBufferedWriter(manifestPath, StandardCharsets.UTF_8)) {
                gson.toJson(manifest, writer);
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to update manifest: " + e.getMessage());
        }
    }

    /**
     * Removes an SDK from manifest.json.
     */
    private void removeFromManifest(String sdkId) {
        try {
            Path manifestPath = getDependenciesDir().resolve(MANIFEST_FILE);
            if (!Files.exists(manifestPath)) {
                return;
            }

            JsonObject manifest;
            try (Reader reader = Files.newBufferedReader(manifestPath, StandardCharsets.UTF_8)) {
                manifest = JsonParser.parseReader(reader).getAsJsonObject();
            }

            manifest.remove(sdkId);

            try (Writer writer = Files.newBufferedWriter(manifestPath, StandardCharsets.UTF_8)) {
                gson.toJson(manifest, writer);
            }
        } catch (Exception e) {
            LOG.warn("[DependencyManager] Failed to remove from manifest: " + e.getMessage());
        }
    }

    /**
     * Recursively deletes a directory.
     * @return a list of paths that failed to delete (empty list means complete success)
     */
    private List<Path> deleteDirectory(Path dir) throws IOException {
        List<Path> failedPaths = new ArrayList<>();

        if (!Files.exists(dir)) {
            return failedPaths;
        }

        // Collect all paths that failed to delete instead of silently ignoring them
        Files.walk(dir)
            .sorted((a, b) -> b.compareTo(a)) // Reverse sort to delete children first
            .forEach(path -> {
                try {
                    Files.delete(path);
                } catch (IOException e) {
                    LOG.warn("[DependencyManager] Failed to delete: " + path + " - " + e.getMessage());
                    failedPaths.add(path);
                }
            });

        if (!failedPaths.isEmpty()) {
            LOG.warn("[DependencyManager] " + failedPaths.size() + " files/directories failed to delete");
        }

        return failedPaths;
    }

    /**
     * Compares two version strings.
     * @return negative if v1 < v2, 0 if equal, positive if v1 > v2
     */
    private int compareVersions(String v1, String v2) {
        if (v1 == null || v2 == null) {
            return 0;
        }

        // Strip the leading 'v' prefix
        v1 = v1.startsWith("v") ? v1.substring(1) : v1;
        v2 = v2.startsWith("v") ? v2.substring(1) : v2;

        String[] parts1 = v1.split("\\.");
        String[] parts2 = v2.split("\\.");

        int maxLen = Math.max(parts1.length, parts2.length);
        for (int i = 0; i < maxLen; i++) {
            int num1 = i < parts1.length ? parseVersionPart(parts1[i]) : 0;
            int num2 = i < parts2.length ? parseVersionPart(parts2[i]) : 0;

            if (num1 != num2) {
                return num1 - num2;
            }
        }

        return 0;
    }

    /**
     * Parses a single segment of a version string.
     */
    private int parseVersionPart(String part) {
        // Strip non-numeric suffixes (e.g. -beta, -alpha)
        Pattern pattern = Pattern.compile("^(\\d+)");
        Matcher matcher = pattern.matcher(part);
        if (matcher.find()) {
            return Integer.parseInt(matcher.group(1));
        }
        return 0;
    }
}
