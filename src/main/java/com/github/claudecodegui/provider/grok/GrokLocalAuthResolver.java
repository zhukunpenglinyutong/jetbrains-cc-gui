package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.EnvironmentUtil;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolve Grok auth from local CLI state ({@code ~/.grok}).
 *
 * <p>When plugin auth is OAuth (default) but {@code auth.json} has no token,
 * fall back to {@code config.toml} model {@code api_key}/{@code base_url} so
 * third-party gateway users match interactive {@code grok} CLI behavior.
 *
 * <p>Does <strong>not</strong> fall back to ambient {@code XAI_API_KEY} on the
 * OAuth path — that forces SuperGrok into {@code xai.api_key} → 403 no credits.
 */
public final class GrokLocalAuthResolver {

    private static final Logger LOG = Logger.getInstance(GrokLocalAuthResolver.class);

    private static final Pattern SECTION_HEADER = Pattern.compile("^\\s*\\[([^\\]]+)]\\s*$");
    private static final Pattern DEFAULT_MODEL =
            Pattern.compile("^\\s*default\\s*=\\s*[\"']([^\"']+)[\"']\\s*$");
    private static final Pattern MODEL_SECTION_QUOTED =
            Pattern.compile("^model\\.\"([^\"]+)\"$|^model\\.'([^']+)'$");
    private static final Pattern MODEL_SECTION_BARE =
            Pattern.compile("^model\\.([^.\\s]+)$");

    private GrokLocalAuthResolver() {
    }

    public static final class ResolvedAuth {
        public final String authMethod;
        public final String apiKey;
        public final String baseUrl;
        public final String reason;
        public final boolean fellBackFromOauth;

        public ResolvedAuth(
                String authMethod,
                String apiKey,
                String baseUrl,
                String reason,
                boolean fellBackFromOauth
        ) {
            this.authMethod = authMethod != null ? authMethod : "";
            this.apiKey = apiKey != null ? apiKey : "";
            this.baseUrl = baseUrl != null ? baseUrl : "";
            this.reason = reason != null ? reason : "";
            this.fellBackFromOauth = fellBackFromOauth;
        }
    }

    public static final class ConfigCredentials {
        public final String apiKey;
        public final String baseUrl;
        public final String profile;

        public ConfigCredentials(String apiKey, String baseUrl, String profile) {
            this.apiKey = apiKey != null ? apiKey : "";
            this.baseUrl = baseUrl != null ? baseUrl : "";
            this.profile = profile != null ? profile : "";
        }
    }

    /**
     * Resolve Grok CLI home directory.
     *
     * <p>Order:
     * <ol>
     *   <li>{@code System.getenv("GROK_HOME")} (process env — rare for GUI apps)</li>
     *   <li>IDE login-shell map via {@link EnvironmentUtil#getEnvironmentMap()}
     *       (picks up {@code export GROK_HOME=...} from {@code ~/.zshrc})</li>
     *   <li>{@code ~/.grok} default</li>
     * </ol>
     *
     * <p>Daemon / {@code grok agent} processes inherit shell env through
     * {@link com.github.claudecodegui.bridge.EnvironmentConfigurator}, so they
     * often write sessions under a custom {@code GROK_HOME} (e.g. {@code ~/.antig-grok}).
     * History readers must use the same resolution or tab restore finds nothing.
     */
    public static Path resolveGrokHome() {
        String env = firstNonBlank(
                System.getenv("GROK_HOME"),
                environmentMapValue("GROK_HOME")
        );
        if (env != null) {
            return Paths.get(env);
        }
        return Paths.get(PlatformUtils.getHomeDirectory(), ".grok");
    }

    /**
     * Candidate Grok homes for on-disk history lookup. Primary home first, then
     * the default {@code ~/.grok} when {@code GROK_HOME} points elsewhere so older
     * sessions remain visible after a home migration.
     */
    public static List<Path> resolveGrokHomeCandidates() {
        LinkedHashSet<Path> homes = new LinkedHashSet<>();
        homes.add(resolveGrokHome());
        Path defaultHome = Paths.get(PlatformUtils.getHomeDirectory(), ".grok");
        homes.add(defaultHome);
        return new ArrayList<>(homes);
    }

    private static String environmentMapValue(String key) {
        try {
            Map<String, String> map = EnvironmentUtil.getEnvironmentMap();
            if (map == null) {
                return null;
            }
            return map.get(key);
        } catch (Exception e) {
            LOG.debug("[Grok] EnvironmentUtil lookup failed for " + key + ": " + e.getMessage());
            return null;
        }
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return null;
    }

    public static boolean hasOAuthToken() {
        return hasOAuthToken(resolveGrokHome());
    }

    public static boolean hasOAuthToken(Path grokHome) {
        try {
            Path authPath = grokHome.resolve("auth.json");
            if (!Files.isRegularFile(authPath)) {
                return false;
            }
            String raw = Files.readString(authPath, StandardCharsets.UTF_8);
            JsonElement el = JsonParser.parseString(raw);
            if (el == null || !el.isJsonObject()) {
                return false;
            }
            return credentialObjectHasToken(el.getAsJsonObject());
        } catch (Exception e) {
            LOG.debug("[Grok] Failed to read auth.json: " + e.getMessage());
            return false;
        }
    }

    static boolean credentialObjectHasToken(JsonObject data) {
        if (data == null) {
            return false;
        }
        if (nonEmpty(data, "access_token") || nonEmpty(data, "token") || nonEmpty(data, "refresh_token")) {
            return true;
        }
        for (Map.Entry<String, JsonElement> e : data.entrySet()) {
            JsonElement v = e.getValue();
            if (v != null && v.isJsonObject()) {
                JsonObject nested = v.getAsJsonObject();
                if (nonEmpty(nested, "access_token")
                        || nonEmpty(nested, "token")
                        || nonEmpty(nested, "refresh_token")) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean nonEmpty(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return false;
        }
        try {
            String s = obj.get(key).getAsString();
            return s != null && !s.trim().isEmpty();
        } catch (Exception ignored) {
            return false;
        }
    }

    public static ConfigCredentials readConfigTomlCredentials() {
        return readConfigTomlCredentials(resolveGrokHome());
    }

    public static ConfigCredentials readConfigTomlCredentials(Path grokHome) {
        Path configPath = grokHome.resolve("config.toml");
        if (!Files.isRegularFile(configPath)) {
            return new ConfigCredentials("", "", "");
        }
        try {
            String text = Files.readString(configPath, StandardCharsets.UTF_8);
            return parseConfigTomlCredentials(text);
        } catch (IOException e) {
            LOG.debug("[Grok] Failed to read config.toml: " + e.getMessage());
            return new ConfigCredentials("", "", "");
        }
    }

    /**
     * Package-visible for unit tests.
     */
    static ConfigCredentials parseConfigTomlCredentials(String text) {
        if (text == null || text.trim().isEmpty()) {
            return new ConfigCredentials("", "", "");
        }
        String[] lines = text.split("\\R", -1);
        String defaultProfile = "";
        String currentSection = "";
        Map<String, String[]> profiles = new LinkedHashMap<>();

        for (String line : lines) {
            Matcher sec = SECTION_HEADER.matcher(line);
            if (sec.matches()) {
                currentSection = sec.group(1).trim();
                continue;
            }
            if (currentSection.equals("models") || currentSection.isEmpty()) {
                Matcher def = DEFAULT_MODEL.matcher(line);
                if (def.matches() && currentSection.equals("models")) {
                    defaultProfile = def.group(1).trim();
                }
            }
            String profileName = modelSectionName(currentSection);
            if (profileName == null) {
                continue;
            }
            String[] fields = profiles.computeIfAbsent(profileName, k -> new String[]{"", ""});
            String apiKey = extractTomlString(line, "api_key");
            if (apiKey == null) {
                apiKey = extractTomlString(line, "apiKey");
            }
            if (apiKey != null) {
                fields[0] = apiKey;
            }
            String baseUrl = extractTomlString(line, "base_url");
            if (baseUrl == null) {
                baseUrl = extractTomlString(line, "baseUrl");
            }
            if (baseUrl != null) {
                fields[1] = baseUrl;
            }
        }

        if (!defaultProfile.isEmpty() && profiles.containsKey(defaultProfile)) {
            String[] f = profiles.get(defaultProfile);
            return new ConfigCredentials(f[0], f[1], defaultProfile);
        }
        for (Map.Entry<String, String[]> e : profiles.entrySet()) {
            if (e.getValue()[0] != null && !e.getValue()[0].isEmpty()) {
                return new ConfigCredentials(e.getValue()[0], e.getValue()[1], e.getKey());
            }
        }
        if (!defaultProfile.isEmpty() && profiles.containsKey(defaultProfile)) {
            String[] f = profiles.get(defaultProfile);
            return new ConfigCredentials("", f[1], defaultProfile);
        }
        return new ConfigCredentials("", "", "");
    }

    private static String modelSectionName(String section) {
        if (section == null || section.isEmpty()) {
            return null;
        }
        Matcher q = MODEL_SECTION_QUOTED.matcher(section);
        if (q.matches()) {
            String a = q.group(1);
            String b = q.group(2);
            return a != null ? a : b;
        }
        Matcher bare = MODEL_SECTION_BARE.matcher(section);
        if (bare.matches()) {
            return bare.group(1);
        }
        return null;
    }

    private static String extractTomlString(String line, String key) {
        Pattern p = Pattern.compile("^\\s*" + Pattern.quote(key) + "\\s*=\\s*[\"']([^\"']*)[\"']\\s*$");
        Matcher m = p.matcher(line);
        if (m.matches()) {
            return m.group(1).trim();
        }
        return null;
    }

    /**
     * Resolve effective auth for the plugin → Node bridge.
     *
     * @param preferredAuth plugin setting (oauth / api_key / auto)
     * @param explicitApiKey bridge or settings key (never ambient env on oauth fallback)
     * @param explicitBaseUrl bridge or settings base URL
     */
    public static ResolvedAuth resolve(
            String preferredAuth,
            String explicitApiKey,
            String explicitBaseUrl
    ) {
        return resolve(
                preferredAuth,
                explicitApiKey,
                explicitBaseUrl,
                hasOAuthToken(),
                readConfigTomlCredentials()
        );
    }

    /**
     * Injectable variant for tests.
     */
    public static ResolvedAuth resolve(
            String preferredAuth,
            String explicitApiKey,
            String explicitBaseUrl,
            boolean hasOAuthToken,
            ConfigCredentials configCredentials
    ) {
        String preferred = CodemossSettingsService.normalizeGrokAuthMethod(preferredAuth);
        String explicitKey = explicitApiKey != null ? explicitApiKey.trim() : "";
        String explicitBase = explicitBaseUrl != null ? explicitBaseUrl.trim() : "";
        ConfigCredentials cfg = configCredentials != null
                ? configCredentials
                : new ConfigCredentials("", "", "");

        if (CodemossSettingsService.GROK_AUTH_METHOD_API_KEY.equals(preferred)) {
            String key = !explicitKey.isEmpty() ? explicitKey : cfg.apiKey;
            String base = !explicitBase.isEmpty() ? explicitBase : cfg.baseUrl;
            String reason = !explicitKey.isEmpty()
                    ? "api_key-explicit"
                    : (!cfg.apiKey.isEmpty() ? "api_key-from-config" : "api_key-empty");
            return new ResolvedAuth(
                    CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                    key,
                    base,
                    reason,
                    false
            );
        }

        if (CodemossSettingsService.GROK_AUTH_METHOD_AUTO.equals(preferred)) {
            if (hasOAuthToken) {
                return new ResolvedAuth(
                        CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                        "",
                        explicitBase,
                        "auto-oauth-token",
                        false
                );
            }
            String key = !explicitKey.isEmpty() ? explicitKey : cfg.apiKey;
            if (!key.isEmpty()) {
                String base = !explicitBase.isEmpty() ? explicitBase : cfg.baseUrl;
                return new ResolvedAuth(
                        CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                        key,
                        base,
                        "auto-api-key",
                        false
                );
            }
            return new ResolvedAuth(
                    CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                    "",
                    explicitBase,
                    "auto-oauth-login",
                    false
            );
        }

        // oauth (default)
        if (hasOAuthToken) {
            return new ResolvedAuth(
                    CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                    "",
                    explicitBase,
                    "oauth-token",
                    false
            );
        }
        String key = !explicitKey.isEmpty() ? explicitKey : cfg.apiKey;
        if (!key.isEmpty()) {
            String base = !explicitBase.isEmpty() ? explicitBase : cfg.baseUrl;
            String reason = !explicitKey.isEmpty()
                    ? "oauth-empty-fallback-plugin-api-key"
                    : "oauth-empty-fallback-config-api-key";
            return new ResolvedAuth(
                    CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                    key,
                    base,
                    reason,
                    true
            );
        }
        return new ResolvedAuth(
                CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                "",
                explicitBase,
                "oauth-login-required",
                false
        );
    }
}
