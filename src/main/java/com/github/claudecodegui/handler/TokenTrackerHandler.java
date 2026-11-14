package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * TokenTracker local-server bridge for the vendored usage dashboard.
 *
 * Mirrors the semantics of desktop-cc-gui's src-tauri/src/tokentracker.rs:
 * the usage dashboard is served by a local HTTP server from the globally
 * installed `tokentracker-cli` npm package (`tokentracker serve`, bound to
 * 127.0.0.1). That server emits no CORS headers, so all dashboard traffic is
 * proxied through the IDE backend ({@link #handleProxy(String)}).
 *
 * All operations run on background threads and answer via
 * `window.onTokenTrackerResponse` using the requestId supplied by the webview.
 */
public class TokenTrackerHandler {

    private static final Logger LOG = Logger.getInstance(TokenTrackerHandler.class);
    private static final Gson GSON = new Gson();

    /** Same npm package exposes several bin aliases; probe them in order. */
    private static final String[] CLI_BIN_NAMES = {"tokentracker", "tracker", "tokentracker-cli"};
    /**
     * Pinned npm package spec for the CLI install. The version is locked to
     * guard against supply-chain attacks; bump it manually when upgrading.
     */
    private static final String TT_CLI_PACKAGE = "tokentracker-cli@1.5.4";
    private static final Pattern VERSION_PATTERN = Pattern.compile("(\\d+)\\.(\\d+)\\.(\\d+)");
    /** Installed CLIs and running servers older than the pinned version are upgraded. */
    private static final int[] TT_MIN_VERSION = parseVersion(TT_CLI_PACKAGE);
    /** Error the webview answers by reinstalling the pinned CLI and calling ensure again. */
    private static final String TT_CLI_OUTDATED_ERROR = "tokentracker_cli_outdated";
    /** Default port used by `tokentracker serve`. */
    private static final int TT_DEFAULT_PORT = 7680;
    /** Ports scanned when looking for a running server. */
    private static final int TT_STATUS_SCAN_FIRST = 7680;
    private static final int TT_STATUS_SCAN_LAST = 7684;
    /** Ports considered when starting a new server. */
    private static final int TT_ENSURE_PORT_FIRST = 7680;
    private static final int TT_ENSURE_PORT_LAST = 7690;
    /** Health/readiness endpoint used to detect a running server. */
    private static final String TT_USER_STATUS_PATH = "/functions/tokentracker-user-status";
    /** Reports `serverVersion` (1.x) next to the local auth token. */
    private static final String TT_LOCAL_AUTH_PATH = "/api/local-auth";
    /** Timeout for a single server probe. */
    private static final Duration TT_STATUS_TIMEOUT = Duration.ofSeconds(2);
    /** Timeout for a proxied dashboard request. */
    private static final Duration TT_PROXY_TIMEOUT = Duration.ofSeconds(30);
    /** Max wait for a freshly spawned server to become ready. */
    private static final Duration TT_READY_TIMEOUT = Duration.ofSeconds(30);
    /** Interval between readiness probes. */
    private static final long TT_READY_POLL_INTERVAL_MS = 400;
    /** Timeout for `--version` probes and the npm install. */
    private static final long TT_VERSION_PROBE_TIMEOUT_SEC = 10;
    private static final long TT_INSTALL_TIMEOUT_SEC = 180;

    /** Port of the server we started or last found running. */
    private static volatile int rememberedPort = 0;
    /** Set once an install ran this session, so an upgrade that did not take cannot loop. */
    private static volatile boolean installAttempted = false;

    private final HandlerContext context;

    public TokenTrackerHandler(HandlerContext context) {
        this.context = context;
    }

    // ------------------------------------------------------------------
    // Bridge entry points (registered in SettingsHandler)
    // ------------------------------------------------------------------

    /** tt_detect_cli → {installed, binPath?, version?} */
    public void handleDetectCli(String content) {
        String requestId = parseRequestId(content);
        runAsync(requestId, () -> {
            CliStatus status = detectCli();
            JsonObject data = new JsonObject();
            data.addProperty("installed", status.installed);
            if (status.binPath != null) {
                data.addProperty("binPath", status.binPath);
            }
            if (status.version != null) {
                data.addProperty("version", status.version);
            }
            return data;
        });
    }

    /** tt_install_cli → {installed: true} or error */
    public void handleInstallCli(String content) {
        String requestId = parseRequestId(content);
        runAsync(requestId, () -> {
            installAttempted = true;
            String npm = resolveNpmBin();
            List<String> command = new ArrayList<>();
            command.add(npm);
            command.add("install");
            command.add("-g");
            command.add(TT_CLI_PACKAGE);
            ProcessResult result = runProcess(command, TT_INSTALL_TIMEOUT_SEC);
            if (result.exitCode != 0) {
                throw new TokenTrackerException(
                        "tokentracker-cli install failed with exit code " + result.exitCode
                                + ": " + result.outputSnippet());
            }
            JsonObject data = new JsonObject();
            data.addProperty("installed", true);
            return data;
        });
    }

    /** tt_ensure_server → {running: true, port} or error */
    public void handleEnsureServer(String content) {
        String requestId = parseRequestId(content);
        runAsync(requestId, () -> {
            // Serialize detect+spawn so concurrent ensure calls cannot race
            // into spawning multiple server instances.
            synchronized (TokenTrackerHandler.class) {
                RunningServer running = detectRunningServer();
                if (running != null && running.current) {
                    return useServer(running.port);
                }

                CliStatus cli = detectCli();
                boolean cliCurrent = cli.installed && isAtLeastMinVersion(cli.version);
                if (!cliCurrent) {
                    if (cli.installed && !installAttempted) {
                        throw new TokenTrackerException(TT_CLI_OUTDATED_ERROR);
                    }
                    if (cli.installed) {
                        LOG.warn("[TokenTrackerHandler] tokentracker-cli " + cli.version + " at " + cli.binPath
                                + " is older than " + TT_CLI_PACKAGE + " after an install attempt; using it as is");
                    }
                    // No CLI, or the upgrade did not take: keep a running server rather than break the dashboard.
                    if (running != null) {
                        return useServer(running.port);
                    }
                    if (!cli.installed) {
                        throw new TokenTrackerException("tokentracker_cli_not_installed");
                    }
                }

                // On the old server's port, `serve` stops the outdated server itself (it cannot on
                // Windows, where the new process exits and a free port is used instead).
                if (running != null && startServer(cli.binPath, running.port, true)) {
                    return useServer(running.port);
                }

                int port = findFreePort();
                if (port < 0) {
                    throw new TokenTrackerException(
                            "No free port for tokentracker server (" + TT_ENSURE_PORT_FIRST + "-" + TT_ENSURE_PORT_LAST + ")");
                }
                if (!startServer(cli.binPath, port, cliCurrent)) {
                    throw new TokenTrackerException("tokentracker server exited before becoming ready on port " + port);
                }
                return useServer(port);
            }
        });
    }

    /** tt_proxy → raw response body text (JSON), or error containing "HTTP <status>" */
    public void handleProxy(String content) {
        String requestId = parseRequestId(content);
        JsonObject payload;
        try {
            payload = JsonParser.parseString(content).getAsJsonObject();
        } catch (Exception e) {
            respondError(requestId, "tokentracker proxy: invalid request payload");
            return;
        }
        runAsync(requestId, () -> {
            String method = payload.has("method") && !payload.get("method").isJsonNull()
                    ? payload.get("method").getAsString() : "GET";
            String path = payload.has("path") && !payload.get("path").isJsonNull()
                    ? payload.get("path").getAsString() : "";
            String body = payload.has("body") && !payload.get("body").isJsonNull()
                    ? payload.get("body").getAsString() : null;

            String pathOnly = path.split("\\?")[0];
            if (!(pathOnly.startsWith("/functions/tokentracker-") || pathOnly.equals("/api/local-auth"))) {
                throw new TokenTrackerException("tokentracker proxy path not allowed: " + path);
            }
            String upperMethod = method.trim().toUpperCase();
            if (!upperMethod.equals("GET") && !upperMethod.equals("POST")) {
                throw new TokenTrackerException("tokentracker proxy method not allowed: " + method);
            }

            int port = rememberedPort > 0 ? rememberedPort : TT_DEFAULT_PORT;
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(TT_STATUS_TIMEOUT)
                    .build();
            HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + path))
                    .timeout(TT_PROXY_TIMEOUT);
            if (payload.has("headers") && payload.get("headers").isJsonObject()) {
                for (Map.Entry<String, com.google.gson.JsonElement> entry
                        : payload.getAsJsonObject("headers").entrySet()) {
                    String name = entry.getKey();
                    if (isRestrictedHeader(name) || entry.getValue().isJsonNull()) {
                        continue;
                    }
                    try {
                        requestBuilder.header(name, entry.getValue().getAsString());
                    } catch (IllegalArgumentException ignored) {
                        // Skip headers the JDK client refuses to set.
                    }
                }
            }
            if ("POST".equals(upperMethod)) {
                requestBuilder.POST(HttpRequest.BodyPublishers.ofString(
                        body != null ? body : "", StandardCharsets.UTF_8));
            } else {
                requestBuilder.GET();
            }

            HttpResponse<String> response;
            try {
                response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            } catch (Exception e) {
                throw new TokenTrackerException("tokentracker server unreachable: " + e.getMessage());
            }
            String text = response.body() != null ? response.body() : "";
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                String snippet = text.length() > 500 ? text.substring(0, 500) : text;
                throw new TokenTrackerException(
                        "tokentracker server returned HTTP " + response.statusCode() + ": " + snippet);
            }
            // Return the raw body; the webview transport JSON.parses it.
            JsonObject data = new JsonObject();
            data.addProperty("body", text);
            return data;
        });
    }

    // ------------------------------------------------------------------
    // CLI detection / install / server lifecycle
    // ------------------------------------------------------------------

    private static final class CliStatus {
        final boolean installed;
        final String binPath;
        final String version;

        CliStatus(boolean installed, String binPath, String version) {
            this.installed = installed;
            this.binPath = binPath;
            this.version = version;
        }
    }

    private static final class RunningServer {
        final int port;
        final boolean current;

        RunningServer(int port, boolean current) {
            this.port = port;
            this.current = current;
        }
    }

    /** Parse the first x.y.z in text (e.g. "v1.5.4", "tokentracker-cli@1.5.4"); null if none. */
    static int[] parseVersion(String text) {
        if (text == null) {
            return null;
        }
        Matcher m = VERSION_PATTERN.matcher(text);
        if (!m.find()) {
            return null;
        }
        try {
            return new int[] {Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** True when version is at least the pinned version; unknown or unparseable versions are outdated. */
    static boolean isAtLeastMinVersion(String version) {
        int[] parsed = parseVersion(version);
        if (parsed == null) {
            return false;
        }
        for (int i = 0; i < 3; i++) {
            if (parsed[i] != TT_MIN_VERSION[i]) {
                return parsed[i] > TT_MIN_VERSION[i];
            }
        }
        return true;
    }

    private CliStatus detectCli() {
        for (String candidate : cliCandidates()) {
            String version = probeCliVersion(candidate);
            if (version != null) {
                return new CliStatus(true, candidate, version);
            }
        }
        return new CliStatus(false, null, null);
    }

    /** Ordered candidate absolute paths / bare names for the CLI binaries. */
    private List<String> cliCandidates() {
        Set<String> candidates = new LinkedHashSet<>();
        String[] extensions = PlatformUtils.isWindows() ? new String[]{".cmd", ".exe", ""} : new String[]{""};

        // 1. Well-known install directories (npm global bin locations).
        List<String> binDirs = new ArrayList<>();
        String home = PlatformUtils.getHomeDirectory();
        if (PlatformUtils.isWindows()) {
            String appData = System.getenv("APPDATA");
            if (appData != null && !appData.isEmpty()) {
                binDirs.add(appData + File.separator + "npm");
            }
        } else {
            binDirs.add("/usr/local/bin");
            binDirs.add("/opt/homebrew/bin");
            binDirs.add("/usr/bin");
            if (home != null) {
                binDirs.add(home + File.separator + ".npm-global" + File.separator + "bin");
                // Version-manager global bin dirs (npm -g installs land next to
                // the manager's node): hermes, volta, fnm, nvmd.
                binDirs.add(home + File.separator + ".hermes" + File.separator + "node" + File.separator + "bin");
                binDirs.add(home + File.separator + ".volta" + File.separator + "bin");
                binDirs.add(home + File.separator + ".fnm" + File.separator + "aliases"
                        + File.separator + "default" + File.separator + "bin");
                binDirs.add(home + File.separator + ".nvmd" + File.separator + "bin");
                // nvm keeps one global bin dir per installed node version.
                File nvmVersionsDir = new File(home + File.separator + ".nvm"
                        + File.separator + "versions" + File.separator + "node");
                File[] versionDirs = nvmVersionsDir.listFiles(File::isDirectory);
                if (versionDirs != null) {
                    java.util.Arrays.sort(versionDirs, (a, b) -> b.getName().compareTo(a.getName()));
                    for (File versionDir : versionDirs) {
                        binDirs.add(versionDir.getAbsolutePath() + File.separator + "bin");
                    }
                }
            }
        }
        // Node's own bin dir (npm -g installs land next to it on many setups).
        String nodeBinDir = nodeBinDir();
        if (nodeBinDir != null) {
            binDirs.add(nodeBinDir);
        }
        for (String dir : binDirs) {
            for (String name : CLI_BIN_NAMES) {
                for (String ext : extensions) {
                    File file = new File(dir, name + ext);
                    if (file.isFile() && file.canExecute()) {
                        candidates.add(file.getAbsolutePath());
                    }
                }
            }
        }
        // 2. Bare names — resolved through PATH by the OS.
        for (String name : CLI_BIN_NAMES) {
            for (String ext : extensions) {
                candidates.add(name + ext);
            }
        }
        return new ArrayList<>(candidates);
    }

    /** Run `<bin> --version`; return trimmed first line on exit 0, else null. */
    private String probeCliVersion(String bin) {
        try {
            ProcessResult result = runProcess(List.of(bin, "--version"), TT_VERSION_PROBE_TIMEOUT_SEC);
            if (result.exitCode == 0 && !result.stdout.isBlank()) {
                String firstLine = result.stdout.lines().findFirst().orElse("").trim();
                return firstLine.isEmpty() ? "unknown" : firstLine;
            }
        } catch (Exception e) {
            LOG.debug("[TokenTrackerHandler] CLI probe failed for " + bin + ": " + e.getMessage());
        }
        return null;
    }

    private String resolveNpmBin() {
        String nodePath = PropertiesComponent.getInstance().getValue(NodePathHandler.NODE_PATH_PROPERTY_KEY);
        if (nodePath != null && !nodePath.isBlank()) {
            File nodeFile = new File(nodePath.trim());
            File parent = nodeFile.getParentFile();
            if (parent != null) {
                String npmName = PlatformUtils.isWindows() ? "npm.cmd" : "npm";
                File npm = new File(parent, npmName);
                if (npm.isFile()) {
                    return npm.getAbsolutePath();
                }
            }
        }
        return PlatformUtils.isWindows() ? "npm.cmd" : "npm";
    }

    /** Bin directory of the detected/saved Node.js installation, if known. */
    private String nodeBinDir() {
        String nodePath = PropertiesComponent.getInstance().getValue(NodePathHandler.NODE_PATH_PROPERTY_KEY);
        if (nodePath == null || nodePath.isBlank()) {
            // Property not saved yet (e.g. settings opened before the main
            // webview initialized) — fall back to the shared NodeDetector cache.
            nodePath = NodeDetector.getInstance().getCachedNodePath();
        }
        if (nodePath == null || nodePath.isBlank()) {
            return null;
        }
        File parent = new File(nodePath.trim()).getParentFile();
        return parent != null ? parent.getAbsolutePath() : null;
    }

    /**
     * Prepend node-reachable directories to the child process PATH. The npm
     * bin shims (`npm`, `tokentracker`, …) start with `#!/usr/bin/env node`,
     * which fails with exit 127 when the IDE was launched with a minimal PATH
     * (e.g. from Finder/Dock). Two directories make `node` resolvable:
     * the detected Node.js bin dir, and the invoked binary's own directory
     * (npm -g shims sit next to their node).
     */
    private void prependNodeDirsToPath(ProcessBuilder pb, String commandBin) {
        Set<String> dirs = new LinkedHashSet<>();
        String nodeBinDir = nodeBinDir();
        if (nodeBinDir != null) {
            dirs.add(nodeBinDir);
        }
        if (commandBin != null) {
            File parent = new File(commandBin).getParentFile();
            if (parent != null) {
                dirs.add(parent.getAbsolutePath());
            }
        }
        if (dirs.isEmpty()) {
            return;
        }
        String pathKey = PlatformUtils.isWindows() ? "Path" : "PATH";
        String currentPath = pb.environment().getOrDefault(pathKey, "");
        pb.environment().put(pathKey, String.join(File.pathSeparator, dirs)
                + (currentPath.isEmpty() ? "" : File.pathSeparator + currentPath));
    }

    // ------------------------------------------------------------------
    // Server lifecycle
    // ------------------------------------------------------------------

    /**
     * Probe the remembered port first, then the scan range. Prefer a server at
     * the pinned version or newer; otherwise return the first outdated one.
     */
    private RunningServer detectRunningServer() {
        Set<Integer> ports = new LinkedHashSet<>();
        if (rememberedPort > 0) {
            ports.add(rememberedPort);
        }
        for (int port = TT_STATUS_SCAN_FIRST; port <= TT_STATUS_SCAN_LAST; port++) {
            ports.add(port);
        }
        RunningServer outdated = null;
        for (int port : ports) {
            if (!probeServerOnPort(port)) {
                continue;
            }
            if (isAtLeastMinVersion(probeServerVersion(port))) {
                return new RunningServer(port, true);
            }
            if (outdated == null) {
                outdated = new RunningServer(port, false);
            }
        }
        return outdated;
    }

    /** `serverVersion` from /api/local-auth; null when absent (0.87.3 omits it) or unreachable. */
    private String probeServerVersion(int port) {
        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(TT_STATUS_TIMEOUT)
                    .build();
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + TT_LOCAL_AUTH_PATH))
                    .timeout(TT_STATUS_TIMEOUT)
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() != 200) {
                return null;
            }
            JsonObject body = JsonParser.parseString(response.body()).getAsJsonObject();
            return body.has("serverVersion") && body.get("serverVersion").isJsonPrimitive()
                    ? body.get("serverVersion").getAsString() : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** A server counts as running when the user-status endpoint answers HTTP 200. */
    private boolean probeServerOnPort(int port) {
        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(TT_STATUS_TIMEOUT)
                    .build();
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create("http://127.0.0.1:" + port + TT_USER_STATUS_PATH))
                    .timeout(TT_STATUS_TIMEOUT)
                    .GET()
                    .build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return response.statusCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    private int findFreePort() {
        for (int port = TT_ENSURE_PORT_FIRST; port <= TT_ENSURE_PORT_LAST; port++) {
            try (ServerSocket socket = new ServerSocket()) {
                socket.setReuseAddress(false);
                socket.bind(new InetSocketAddress("127.0.0.1", port));
                return port;
            } catch (Exception ignored) {
                // Port occupied — try the next one.
            }
        }
        return -1;
    }

    /**
     * Spawn `tokentracker serve` detached. The process handle is dropped on
     * purpose so the server keeps running after this call (matching the
     * desktop client's behavior).
     */
    private Process spawnServer(String bin, int port) throws TokenTrackerException {
        try {
            ProcessBuilder pb = new ProcessBuilder(
                    bin, "serve", "--no-open", "--port", String.valueOf(port));
            pb.environment().put("TOKENTRACKER_NO_TELEMETRY", "1");
            // The npm bin shim uses `#!/usr/bin/env node` — make sure node is
            // reachable from the child's PATH even when the IDE's PATH is minimal.
            prependNodeDirsToPath(pb, bin);
            pb.redirectInput(ProcessBuilder.Redirect.from(new File(PlatformUtils.isWindows() ? "NUL" : "/dev/null")));
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process process = pb.start();
            LOG.info("[TokenTrackerHandler] Started tokentracker server on port " + port);
            return process;
        } catch (Exception e) {
            throw new TokenTrackerException("Failed to start tokentracker server: " + e.getMessage());
        }
    }

    /**
     * Spawn `serve` on port and wait until it answers. With requireCurrent the
     * server must also report the pinned version or newer, so an outdated server
     * still holding the port does not count. Returns false if the process exits first.
     */
    private boolean startServer(String bin, int port, boolean requireCurrent) throws TokenTrackerException {
        Process process = spawnServer(bin, port);
        long deadline = System.nanoTime() + TT_READY_TIMEOUT.toNanos();
        while (System.nanoTime() < deadline) {
            if (probeServerOnPort(port) && (!requireCurrent || isAtLeastMinVersion(probeServerVersion(port)))) {
                return true;
            }
            if (!process.isAlive()) {
                LOG.info("[TokenTrackerHandler] tokentracker server on port " + port
                        + " exited with code " + process.exitValue() + " before becoming ready");
                return false;
            }
            try {
                Thread.sleep(TT_READY_POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new TokenTrackerException("Interrupted while waiting for tokentracker server");
            }
        }
        throw new TokenTrackerException(
                "tokentracker server did not become ready on port " + port
                        + " within " + TT_READY_TIMEOUT.getSeconds() + "s"
                        + " (the port may have been taken by another process)");
    }

    // ------------------------------------------------------------------
    // Plumbing
    // ------------------------------------------------------------------

    private JsonObject useServer(int port) {
        rememberedPort = port;
        JsonObject data = new JsonObject();
        data.addProperty("running", true);
        data.addProperty("port", port);
        return data;
    }

    private boolean isRestrictedHeader(String name) {
        String lower = name.toLowerCase();
        return lower.equals("host") || lower.equals("content-length") || lower.equals("connection")
                || lower.equals("expect") || lower.equals("upgrade");
    }

    private String parseRequestId(String content) {
        try {
            JsonObject json = JsonParser.parseString(content).getAsJsonObject();
            if (json.has("requestId") && !json.get("requestId").isJsonNull()) {
                return json.get("requestId").getAsString();
            }
        } catch (Exception e) {
            LOG.warn("[TokenTrackerHandler] Failed to parse requestId: " + e.getMessage());
        }
        return "";
    }

    private interface TokenTrackerOperation {
        JsonObject run() throws TokenTrackerException;
    }

    private void runAsync(String requestId, TokenTrackerOperation operation) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject data = operation.run();
                respondOk(requestId, data);
            } catch (TokenTrackerException e) {
                LOG.warn("[TokenTrackerHandler] " + e.getMessage());
                respondError(requestId, e.getMessage());
            } catch (Exception e) {
                LOG.error("[TokenTrackerHandler] Unexpected error: " + e.getMessage(), e);
                respondError(requestId, String.valueOf(e.getMessage()));
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    private void respondOk(String requestId, JsonObject data) {
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        response.addProperty("ok", true);
        response.add("data", data);
        pushResponse(response);
    }

    private void respondError(String requestId, String message) {
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        response.addProperty("ok", false);
        response.addProperty("error", message != null ? message : "unknown error");
        pushResponse(response);
    }

    private void pushResponse(JsonObject response) {
        String json = GSON.toJson(response);
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.onTokenTrackerResponse", context.escapeJs(json)));
    }

    // ------------------------------------------------------------------
    // Process helpers
    // ------------------------------------------------------------------

    private static final class ProcessResult {
        final int exitCode;
        final String stdout;

        ProcessResult(int exitCode, String stdout) {
            this.exitCode = exitCode;
            this.stdout = stdout != null ? stdout : "";
        }

        String outputSnippet() {
            String trimmed = stdout.trim();
            return trimmed.length() > 300 ? trimmed.substring(0, 300) : trimmed;
        }
    }

    private ProcessResult runProcess(List<String> command, long timeoutSec) throws TokenTrackerException {
        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            // `--version` probes and `npm install` both execute node-based shim
            // scripts; without this they fail with exit 127 (env: node not found)
            // whenever the IDE's inherited PATH lacks node.
            prependNodeDirsToPath(pb, command.get(0));
            pb.redirectErrorStream(true);
            Process process = pb.start();
            // Read stdout on a separate thread so waitFor's timeout still applies
            // (readAllBytes blocks until the process exits and closes the stream).
            CompletableFuture<String> outputFuture = CompletableFuture.supplyAsync(() -> {
                try (InputStream in = process.getInputStream()) {
                    return new String(in.readAllBytes(), StandardCharsets.UTF_8);
                } catch (Exception e) {
                    return "";
                }
            });
            boolean finished = process.waitFor(timeoutSec, TimeUnit.SECONDS);
            if (!finished) {
                PlatformUtils.terminateProcess(process);
                throw new TokenTrackerException("Command timed out after " + timeoutSec + "s: " + command.get(0));
            }
            String output = outputFuture.get(5, TimeUnit.SECONDS);
            return new ProcessResult(process.exitValue(), output);
        } catch (TokenTrackerException e) {
            throw e;
        } catch (Exception e) {
            throw new TokenTrackerException("Failed to run " + command.get(0) + ": " + e.getMessage());
        }
    }

    private static final class TokenTrackerException extends Exception {
        TokenTrackerException(String message) {
            super(message);
        }
    }
}
