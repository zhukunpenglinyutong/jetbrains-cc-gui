package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.cli.CliStatusDetector;
import com.github.claudecodegui.cli.CliToolId;
import com.github.claudecodegui.cli.CliToolStatus;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Gemini (Antigravity CLI) plan-usage snapshot builder + resolver.
 *
 * <p>Feeds the ContextBar plan-usage indicator using the same payload shape as
 * Claude ({@code capacity_pct} + {@code windows[]}), so the shared
 * {@code PlanUsageIndicator} renders it unchanged. The billing family follows
 * the selected model slug: {@code gemini-*} maps to the "Gemini Models" quota
 * group, {@code claude-*}/{@code gpt-*} to the third-party group; unknown or
 * {@code auto} defaults to the Gemini family (the CLI's own default routing).
 *
 * <p>Quota data comes from a one-shot {@code agy -p "/usage" --output-format
 * json} probe. The command is answered structurally by the CLI itself —
 * {@code usage} stays all-zero, {@code num_turns} is 0 and no conversation is
 * left behind — so reading quota never consumes tokens or quota.
 *
 * <p>Hard gate: the structural answer only exists on CLI 1.1.11+. On older
 * CLIs the same text runs as a <b>model prompt</b> and burns tokens, so the
 * probe is never spawned below the floor — the only outcome is an
 * unavailable payload with an upgrade hint. A {@code SUCCESS} payload without
 * the {@code command} object is the documented old-CLI marker and is treated
 * the same way (after that single probe, without retrying).
 *
 * <p>The webview polls {@code get_gemini_plan_usage} every ~120s with the
 * selected model slug riding along; the cache is keyed by billing family so a
 * family switch always re-probes instead of serving the other family's numbers.
 */
public final class GeminiPlanUsageService {

    /** Minimum CLI version whose {@code /usage} command answers structurally. */
    static final String PRODUCT_FLOOR = "1.1.11";
    /**
     * Fresh-cache TTL. Set just under the webview's 120s poll cadence so that
     * back-to-back polls (multiple tool windows, manual refresh) dedupe onto a
     * single probe; a regular 120s poll always re-probes.
     */
    static final long CACHE_TTL_MS = 115_000L;
    /** Max age for serving a stale cached payload after repeated probe failures. */
    static final long STALE_MAX_MS = 30 * 60_000L;
    private static final long PROBE_TIMEOUT_SECONDS = 15L;
    private static final int MAX_OUTPUT_CHARS = 65_536;

    private static final String FAMILY_GEMINI = "gemini";
    private static final String FAMILY_THIRD_PARTY = "third-party";

    private static final Logger LOG = Logger.getInstance(GeminiPlanUsageService.class);

    /** Per-family cached snapshot: fresh for the TTL, stale-servable up to the cap. */
    private static final Map<String, FamilyCache> CACHE = new ConcurrentHashMap<>();

    /** Test-only seam replacing the real CLI spawn. */
    private static volatile AgyTransport transportOverride;

    /**
     * Test-only version-gate override. Once set, {@code null} means "not
     * installed"; production reads the version from {@link CliStatusDetector}.
     */
    private static volatile String cliVersionOverride;
    private static volatile boolean cliVersionOverrideSet;

    private GeminiPlanUsageService() {
    }

    /** Transport seam for the {@code /usage} probe — production spawns the CLI, tests substitute. */
    interface AgyTransport {
        JsonObject runUsageProbe() throws Exception;
    }

    // ===== resolver pipeline =====

    public static JsonObject resolvePlanUsagePayload(String selectedModelSlug) {
        return resolvePlanUsagePayload(selectedModelSlug, System.currentTimeMillis());
    }

    static JsonObject resolvePlanUsagePayload(String selectedModelSlug, long nowMs) {
        // Gate BEFORE anything else: on a below-floor CLI the probe itself is
        // the hazard, so not even a cached payload's refresh may spawn it.
        CliToolStatus cli = geminiCliStatus();
        if (!cliMeetsProductFloor(cliVersion(cli))) {
            return unavailable(upgradeHint(cliVersion(cli)));
        }

        String family = familyOf(selectedModelSlug);
        FamilyCache cached = CACHE.get(family);
        if (cached != null && nowMs - cached.atMs < CACHE_TTL_MS) {
            return cached.payload.deepCopy();
        }

        try {
            JsonObject raw = transport().runUsageProbe();
            JsonObject parsed = parseUsagePayload(raw, selectedModelSlug);
            if (parsed != null) {
                CACHE.put(family, new FamilyCache(nowMs, parsed));
                return parsed.deepCopy();
            }
            // The probe answered but not with usable quota data: a SUCCESS
            // without the command object is the old-CLI marker (hint, and this
            // single probe already did the damage — never retry in a loop).
            return unavailable(outcomeMessage(raw));
        } catch (Exception e) {
            LOG.warn("Gemini usage probe failed: " + e.getMessage());
            // Serve the last good payload while probes keep failing — but only
            // for a bounded window, so a long outage doesn't masquerade as live.
            if (cached != null && nowMs - cached.atMs < STALE_MAX_MS) {
                JsonObject copy = cached.payload.deepCopy();
                copy.addProperty("stale", true);
                return copy;
            }
            return unavailable("Gemini usage unavailable: " + e.getMessage());
        }
    }

    // ===== payload mapping =====

    /**
     * Map a {@code /usage} answer onto the shared capacity shape for the
     * selected model's billing family. Returns {@code null} when the payload is
     * not a valid CLI-1.1.11+ usage answer (old-CLI marker, {@code status}
     * {@code ERROR}, or no buckets for the family) — the human-readable
     * {@code response} text is never treated as data.
     */
    static JsonObject parseUsagePayload(JsonObject payload, String selectedModelSlug) {
        if (payload == null
                || !"SUCCESS".equals(asString(payload, "status"))) {
            return null;
        }
        JsonElement command = payload.get("command");
        if (command == null || !command.isJsonObject()) {
            return null;
        }
        JsonElement data = command.getAsJsonObject().get("data");
        if (data == null || !data.isJsonObject()) {
            return null;
        }
        JsonElement groups = data.getAsJsonObject().get("groups");
        if (groups == null || !groups.isJsonArray()) {
            return null;
        }
        JsonObject group = findFamilyGroup(groups.getAsJsonArray(), familyOf(selectedModelSlug));
        if (group == null) {
            return null;
        }
        JsonElement buckets = group.get("buckets");
        if (buckets == null || !buckets.isJsonArray()) {
            return null;
        }

        JsonArray windows = new JsonArray();
        JsonObject first = null;
        JsonObject binding5h = null;
        for (JsonElement el : buckets.getAsJsonArray()) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject window = toWindow(el.getAsJsonObject());
            if (window == null) {
                continue;
            }
            windows.add(window);
            if (first == null) {
                first = window;
            }
            if (binding5h == null && "5h".equals(window.get("period_type").getAsString())) {
                binding5h = window;
            }
        }
        // The 5h window binds the display when the CLI reports it; otherwise the
        // reported window stands in (weekly-only shape) — never a fabricated 5h.
        JsonObject binding = binding5h != null ? binding5h : first;
        if (binding == null) {
            return null;
        }

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("present", true);
        out.addProperty("provider", "gemini");
        out.addProperty("source", "agy-usage");
        out.addProperty("capacity_pct", binding.get("used_pct").getAsDouble());
        if (binding.has("reset_at")) {
            out.addProperty("reset_at", binding.get("reset_at").getAsString());
        }
        out.addProperty("period_type", binding.get("period_type").getAsString());
        out.add("windows", windows);
        return out;
    }

    /** One quota bucket → one shared window; missing/invalid fields skip the bucket (never fabricated). */
    private static JsonObject toWindow(JsonObject bucket) {
        String id = asString(bucket, "id");
        Double remaining = asDouble(bucket, "remaining_fraction");
        if (id == null || id.isBlank() || remaining == null || !Double.isFinite(remaining)) {
            return null;
        }
        JsonObject w = new JsonObject();
        w.addProperty("id", id);
        w.addProperty("used_pct", clampPct((1.0 - remaining) * 100.0));
        String resetTime = asString(bucket, "reset_time");
        if (resetTime != null) {
            w.addProperty("reset_at", resetTime);
        }
        String window = asString(bucket, "window");
        w.addProperty("period_type", window != null ? window : id);
        return w;
    }

    // ===== billing family (follows the selected model) =====

    /**
     * {@code gemini-*} slugs bill the Gemini family; {@code claude-*}/{@code
     * gpt-*} bill the third-party family. Unknown, {@code auto} (the default
     * selection state — the CLI routes it to a Gemini model), null or empty
     * default to the Gemini family so third-party numbers never leak in.
     */
    static String familyOf(String slug) {
        String s = slug == null ? "" : slug.trim().toLowerCase(Locale.ROOT);
        if (s.startsWith("claude-") || s.startsWith("gpt-")) {
            return FAMILY_THIRD_PARTY;
        }
        return FAMILY_GEMINI;
    }

    /**
     * Groups are matched by name (case-insensitive contains): the group whose
     * name mentions "gemini" is the Gemini family, any other group is the
     * third-party one (live names: "Gemini Models" / "Claude and GPT models").
     */
    private static JsonObject findFamilyGroup(JsonArray groups, String family) {
        for (JsonElement el : groups) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject group = el.getAsJsonObject();
            String name = asString(group, "name");
            boolean isGeminiGroup = name != null && name.toLowerCase(Locale.ROOT).contains("gemini");
            if (FAMILY_GEMINI.equals(family) == isGeminiGroup) {
                return group;
            }
        }
        return null;
    }

    // ===== version gate =====

    private static String cliVersion(CliToolStatus cli) {
        if (cliVersionOverrideSet) {
            return cliVersionOverride;
        }
        return cli != null && cli.isInstalled() ? cli.getVersion() : null;
    }

    private static boolean cliMeetsProductFloor(String version) {
        return version != null && atLeastVersion(version, PRODUCT_FLOOR);
    }

    /** Dotted-numeric comparison; any non-numeric part counts as unverifiable (gate stays closed). */
    static boolean atLeastVersion(String version, String floor) {
        String v = version.trim().toLowerCase(Locale.ROOT);
        if (v.startsWith("v")) {
            v = v.substring(1);
        }
        String[] parts = v.split("\\.");
        String[] floorParts = floor.split("\\.");
        for (int i = 0; i < Math.max(parts.length, floorParts.length); i++) {
            int p = i < parts.length ? numericPart(parts[i]) : 0;
            int f = i < floorParts.length ? numericPart(floorParts[i]) : 0;
            if (p < 0 || f < 0) {
                return false;
            }
            if (p != f) {
                return p > f;
            }
        }
        return true;
    }

    private static int numericPart(String part) {
        if (part == null || part.isEmpty()) {
            return 0;
        }
        int end = 0;
        while (end < part.length() && Character.isDigit(part.charAt(end))) {
            end++;
        }
        if (end == 0) {
            return -1;
        }
        try {
            return Integer.parseInt(part.substring(0, end));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** Upgrade hint — must name both the remedy and the required floor. */
    private static String upgradeHint(String version) {
        if (version == null) {
            return "Antigravity CLI (agy) " + PRODUCT_FLOOR
                    + "+ is required for usage data. Install the CLI or run `agy update`.";
        }
        return "Antigravity CLI " + PRODUCT_FLOOR + "+ is required for usage data (found: " + version
                + "). Run `agy update` to upgrade.";
    }

    /** Unavailable message for a probe that answered without usable quota data. */
    private static String outcomeMessage(JsonObject raw) {
        String status = raw == null ? null : asString(raw, "status");
        if ("SUCCESS".equals(status)) {
            return "Antigravity CLI " + PRODUCT_FLOOR
                    + "+ is required for usage data — the CLI answered without the usage structure. "
                    + "Run `agy update` to upgrade.";
        }
        return "Gemini usage unavailable: the CLI reported "
                + (status != null ? "status " + status : "no status") + " for /usage.";
    }

    private static JsonObject unavailable(String message) {
        JsonObject out = new JsonObject();
        out.addProperty("present", false);
        out.addProperty("unavailable", true);
        out.addProperty("provider", "gemini");
        out.addProperty("message", message);
        return out;
    }

    // ===== CLI resolution + real probe =====

    private static CliToolStatus geminiCliStatus() {
        try {
            return CliStatusDetector.detectAllStaleWhileRevalidate().get(CliToolId.GEMINI.getId());
        } catch (Exception e) {
            LOG.debug("Gemini CLI status unavailable: " + e.getMessage());
            return null;
        }
    }

    /**
     * Spawn {@code agy -p "/usage" --output-format json} and return its parsed
     * answer. The exit code is not authoritative (live behavior: 0, 1 and 2 all
     * occur for structurally valid answers), so the answer is taken from
     * stdout, not from the exit status. The CLI waits for stdin EOF on
     * non-interactive subcommands, so the child's stdin is closed right away.
     */
    static JsonObject runUsageProbeViaCli() throws Exception {
        String resolved = resolvedCliPath();
        ProcessBuilder pb = new ProcessBuilder(
                resolved, "-p", "/usage", "--output-format", "json");
        pb.redirectErrorStream(true);
        File bin = new File(resolved);
        File parent = bin.getAbsoluteFile().getParentFile();
        if (parent != null) {
            // IDE-launched processes may not carry the user's bin dirs on PATH;
            // give the child its own directory so wrapper scripts can resolve siblings.
            Map<String, String> env = pb.environment();
            String pathKey = File.pathSeparatorChar == ';' ? "Path" : "PATH";
            String existing = env.getOrDefault(pathKey, env.getOrDefault("PATH", ""));
            env.put(pathKey, parent.getAbsolutePath() + File.pathSeparator + existing);
            if (!"PATH".equals(pathKey)) {
                env.put("PATH", parent.getAbsolutePath() + File.pathSeparator + existing);
            }
        }
        Process process = pb.start();
        try {
            process.getOutputStream().close();
            // Bound the wait first so a hung child cannot block the poll thread:
            // the answer is a single small JSON line that will not fill the OS
            // pipe buffer before exit, so draining after waitFor is safe.
            if (!process.waitFor(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw new IllegalStateException("agy /usage probe timed out after "
                        + PROBE_TIMEOUT_SECONDS + "s");
            }
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null && output.length() < MAX_OUTPUT_CHARS) {
                    output.append(line).append('\n');
                }
            }
            JsonObject answer = firstJsonObject(output.toString());
            if (answer == null) {
                throw new IllegalStateException("agy /usage produced no JSON answer");
            }
            return answer;
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    /**
     * Stderr is merged into stdout, so scan for the last line that parses as a
     * JSON object rather than trusting line 1 or the exit code.
     */
    private static JsonObject firstJsonObject(String text) {
        JsonObject found = null;
        for (String line : text.split("\n")) {
            String trimmed = line.trim();
            if (!trimmed.startsWith("{")) {
                continue;
            }
            try {
                JsonElement el = JsonParser.parseString(trimmed);
                if (el.isJsonObject()) {
                    found = el.getAsJsonObject();
                }
            } catch (Exception ignored) {
                // noise line (spinner/status text) — keep scanning
            }
        }
        return found;
    }

    private static String resolvedCliPath() {
        CliToolStatus cli = geminiCliStatus();
        if (cli != null && cli.isInstalled() && cli.getPath() != null && !cli.getPath().isBlank()) {
            return cli.getPath();
        }
        return CliToolId.GEMINI.getBinaryName();
    }

    private static AgyTransport transport() {
        AgyTransport override = transportOverride;
        return override != null ? override : GeminiPlanUsageService::runUsageProbeViaCli;
    }

    // ===== test seams =====

    /** Test-only: replace the CLI probe. Pass null to restore the real one. */
    static void setAgyTransportForTests(AgyTransport transport) {
        transportOverride = transport;
    }

    /** Test-only: pin the CLI version for the gate. Null = not installed. */
    static void setCliVersionForTests(String version) {
        cliVersionOverride = version;
        cliVersionOverrideSet = true;
    }

    /** Test-only: drop all cached family payloads. */
    static void resetCacheForTests() {
        CACHE.clear();
    }

    // ===== helpers =====

    private static String asString(JsonObject o, String key) {
        if (o != null && o.has(key) && o.get(key).isJsonPrimitive() && !o.get(key).isJsonNull()) {
            return o.get(key).getAsString();
        }
        return null;
    }

    private static Double asDouble(JsonObject o, String key) {
        if (o != null && o.has(key) && o.get(key).isJsonPrimitive() && !o.get(key).isJsonNull()) {
            try {
                return o.get(key).getAsDouble();
            } catch (RuntimeException ignored) {
                return null;
            }
        }
        return null;
    }

    static double clampPct(double v) {
        if (!Double.isFinite(v)) {
            return 0;
        }
        return Math.max(0, Math.min(100, v));
    }

    private static final class FamilyCache {
        final long atMs;
        final JsonObject payload;

        FamilyCache(long atMs, JsonObject payload) {
            this.atMs = atMs;
            this.payload = payload;
        }
    }
}
