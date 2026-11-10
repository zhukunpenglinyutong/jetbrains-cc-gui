package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.ProviderManager;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SessionSupplierOperationsTest {
    @Test
    public void selectionIsFencedSanitizedAndDoesNotRedirectTheActiveTurn() {
        Fixture fixture = new Fixture();
        fixture.session.getState().beginTurn();
        JsonObject request = fixture.request("b");
        fixture.operations.handle(request.toString(), true);
        JsonObject reply = fixture.reply.get();
        assertEquals("b", reply.get("supplierId").getAsString());
        assertEquals("a", reply.get("activeSupplierId").getAsString());
        assertTrue(reply.get("busy").getAsBoolean());
        assertFalse(reply.toString().contains("secret-fixture"));
        assertEquals("a", fixture.settings.getActiveClaudeProvider().get("id").getAsString());

        fixture.session.getState().setRestoredSessionId("different-history");
        fixture.operations.handle(request.toString(), true);
        assertTrue(fixture.reply.get().has("error"));
        assertEquals("b", fixture.session.getState().getSupplierId("claude"));
    }

    @Test
    public void thinkingUpdatesOnlyTheBoundSupplierAndKeepsItsCredentials() {
        Fixture fixture = new Fixture();
        JsonObject request = fixture.request("b");
        request.addProperty("thinkingEnabled", false);
        fixture.operations.handle(request.toString(), true);
        assertFalse(fixture.reply.get().has("error"));
        assertFalse(fixture.reply.get().get("thinkingEnabled").getAsBoolean());
        assertTrue(fixture.settings.a.getAsJsonObject("settingsConfig").get("alwaysThinkingEnabled").getAsBoolean());
        assertEquals("secret-fixture-b", fixture.settings.b.getAsJsonObject("settingsConfig").getAsJsonObject("env")
                .get("ANTHROPIC_AUTH_TOKEN").getAsString());
    }

    @Test
    public void providerReadFailuresDoNotExposeConfigurationDiagnostics() {
        Fixture fixture = new Fixture();
        fixture.settings.failReads = true;
        fixture.operations.handle(fixture.request("b").toString(), false);
        assertTrue(fixture.reply.get().has("error"));
        assertFalse(fixture.reply.get().toString().contains("secret-fixture"));
    }

    @Test
    public void pricingAndCapacityUseTheRuntimeSupplierMappingsWithoutGlobalFallback() throws Exception {
        FakeSettings settings = new FakeSettings();
        JsonObject selected = com.github.claudecodegui.settings.SessionSupplierCatalog.claudeSettings(settings, "b");
        assertEquals("b-model", ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-5", selected.getAsJsonObject("env")));
        assertEquals(0, com.github.claudecodegui.settings.SessionSupplierCatalog.claudeSettings(settings, "deleted").size());
    }

    @Test
    public void pickerModelsAndCapabilitiesFollowTheSelectedSupplierWithoutExposingOtherFields() {
        Fixture fixture = new Fixture();
        JsonObject settings = fixture.settings.b.getAsJsonObject("settingsConfig");
        settings.add("modelPicker", JsonParser.parseString("{\"replaceBuiltInOptions\":true,\"options\":["
                + "{\"model\":\"b-route[1m]\",\"label\":\"B Route\",\"description\":\"Fixture\",\"apiKey\":\"secret-fixture\"},"
                + "{\"model\":\"b-route\"},{\"model\":42},{\"model\":\"\"}]}"));
        settings.addProperty("model", "b-route[1M]");
        fixture.operations.handle(fixture.request("b").toString(), true);
        JsonObject catalog = fixture.reply.get().getAsJsonObject("modelCatalog");
        assertEquals(1, catalog.getAsJsonArray("models").size());
        assertEquals("b-route", catalog.get("defaultModel").getAsString());
        assertTrue(catalog.get("replaceBuiltInOptions").getAsBoolean());
        JsonObject model = catalog.getAsJsonArray("models").get(0).getAsJsonObject();
        assertEquals("B Route", model.get("label").getAsString());
        assertTrue(model.get("supports1MContext").getAsBoolean());
        assertFalse(fixture.reply.get().toString().contains("secret-fixture"));
    }

    @Test
    public void duplicatePickerOptionsMergeContextCapabilitiesInEitherOrder() {
        for (boolean extendedFirst : List.of(false, true)) {
            Fixture fixture = new Fixture();
            String first = extendedFirst ? "b-route[1M]" : "b-route";
            String second = extendedFirst ? "b-route" : "b-route[1m]";
            fixture.settings.b.getAsJsonObject("settingsConfig").add("modelPicker", JsonParser.parseString("{\"options\":["
                    + "{\"model\":\"" + first + "\",\"label\":\"First label\"},{\"model\":\"" + second + "\"}]}"));
            fixture.operations.handle(fixture.request("b").toString(), true);
            var models = fixture.reply.get().getAsJsonObject("modelCatalog").getAsJsonArray("models");
            assertEquals(1, models.size());
            assertEquals("First label", models.get(0).getAsJsonObject().get("label").getAsString());
            assertTrue(models.get(0).getAsJsonObject().get("supports1MContext").getAsBoolean());
        }
    }

    @Test
    public void unsupportedCodexFragmentsAreUnavailableBeforeSelectionWithoutExposingTheirContents() {
        for (String fragment : List.of("mcp_servers = {}\n", "skills = {}\n", "[mcp_servers.fixture]\ncommand = \"fixture\"\n",
                "skills.config = []\n", "secret-fixture = [")) {
            Fixture fixture = new Fixture();
            fixture.session.getState().setProvider("codex");
            fixture.session.getState().setSupplierId("codex", "a");
            fixture.settings.a.addProperty("configToml", "model = \"skills and mcp_servers are text\" # mcp_servers\n");
            fixture.settings.b.addProperty("configToml", fragment);
            JsonObject request = fixture.request("b");
            request.addProperty("provider", "codex");
            fixture.operations.handle(request.toString(), false);
            var suppliers = fixture.reply.get().getAsJsonArray("suppliers");
            assertTrue(suppliers.get(0).getAsJsonObject().get("available").getAsBoolean());
            assertFalse(suppliers.get(1).getAsJsonObject().get("available").getAsBoolean());
            assertFalse(fixture.reply.get().toString().contains("secret-fixture"));
            assertFalse(com.github.claudecodegui.settings.SessionSupplierCatalog.available(fixture.settings, "codex", "b"));
            fixture.operations.handle(request.toString(), true);
            assertTrue(fixture.reply.get().has("error"));
            assertEquals("a", fixture.session.getState().getSupplierId("codex"));
        }
    }

    @Test
    public void nativeLoginUsesAuthorizedNativeMappingsAndPickerInsteadOfAnEmptyVirtualEntry() {
        Fixture fixture = new Fixture();
        JsonObject login = new JsonObject();
        login.addProperty("id", ProviderManager.CLI_LOGIN_PROVIDER_ID);
        fixture.settings.providers.add(login);
        fixture.settings.active = login;
        fixture.settings.nativeSettings = JsonParser.parseString("{\"env\":{\"ANTHROPIC_MODEL\":\"native-route\","
                + "\"ANTHROPIC_AUTH_TOKEN\":\"secret-fixture\"},\"modelPicker\":{\"options\":[{\"model\":\"native-route\"}]},"
                + "\"alwaysThinkingEnabled\":false}").getAsJsonObject();
        fixture.session.getState().setSupplierId("claude", ProviderManager.CLI_LOGIN_PROVIDER_ID);
        fixture.operations.handle(fixture.request(ProviderManager.CLI_LOGIN_PROVIDER_ID).toString(), false);
        JsonObject reply = fixture.reply.get();
        assertEquals("native-route", reply.getAsJsonObject("modelMappingEnv").get("ANTHROPIC_MODEL").getAsString());
        assertEquals("native-route", reply.getAsJsonObject("modelCatalog").get("defaultModel").getAsString());
        assertFalse(reply.get("thinkingEnabled").getAsBoolean());
        assertFalse(reply.toString().contains("secret-fixture"));
        assertEquals(1, fixture.settings.nativeReads);

        fixture.settings.active = fixture.settings.a;
        fixture.operations.handle(fixture.request(ProviderManager.CLI_LOGIN_PROVIDER_ID).toString(), false);
        assertEquals(1, fixture.settings.nativeReads);
        assertEquals(0, fixture.reply.get().getAsJsonObject("modelMappingEnv").size());
    }

    private static final class Fixture {
        private final FakeSettings settings = new FakeSettings();
        private final ClaudeSession session = new ClaudeSession(null, null, null, Map.of());
        private final AtomicReference<JsonObject> reply = new AtomicReference<>();
        private final SessionSupplierOperations operations;

        private Fixture() {
            HandlerContext context = new HandlerContext(null, null, null, settings, new HandlerContext.JsCallback() {
                @Override
                public void callJavaScript(String functionName, String... args) {
                    assertEquals("window.onSessionSuppliers", functionName);
                    reply.set(JsonParser.parseString(args[0]).getAsJsonObject());
                }

                @Override
                public String escapeJs(String value) {
                    return value;
                }
            });
            context.setSession(session);
            session.getState().setSupplierId("claude", "a");
            operations = new SessionSupplierOperations(context);
        }

        private JsonObject request(String supplier) {
            JsonObject request = new JsonObject();
            request.addProperty("provider", "claude");
            request.addProperty("requestId", "fixture-request");
            request.addProperty("supplierId", supplier);
            request.addProperty("sessionId", session.getSessionId());
            request.addProperty("bindingToken", session.getState().getRuntimeSessionEpoch());
            return request;
        }
    }

    private static final class FakeSettings extends CodemossSettingsService {
        private final JsonObject a = provider("a");
        private final JsonObject b = provider("b");
        private final List<JsonObject> providers = new ArrayList<>(List.of(a, b));
        private JsonObject active = a;
        private JsonObject nativeSettings = new JsonObject();
        private int nativeReads;
        private boolean failReads;

        @Override
        public List<JsonObject> getClaudeProviders() {
            if (failReads) {
                throw new IllegalArgumentException("secret-fixture-diagnostic");
            }
            return providers;
        }

        @Override
        public List<JsonObject> getCodexProviders() {
            return getClaudeProviders();
        }

        @Override
        public JsonObject getActiveCodexProvider() {
            return active;
        }

        @Override
        public JsonObject getActiveClaudeProvider() {
            return active;
        }

        @Override
        public JsonObject readClaudeSettings() {
            nativeReads++;
            return nativeSettings;
        }

        @Override
        public boolean setAlwaysThinkingEnabledInProvider(String id, boolean enabled) {
            ("a".equals(id) ? a : b).getAsJsonObject("settingsConfig").addProperty("alwaysThinkingEnabled", enabled);
            return true;
        }

        private static JsonObject provider(String id) {
            JsonObject provider = new JsonObject();
            provider.addProperty("id", id);
            provider.addProperty("name", "Supplier " + id);
            JsonObject settings = new JsonObject();
            settings.addProperty("alwaysThinkingEnabled", true);
            JsonObject env = new JsonObject();
            env.addProperty("ANTHROPIC_AUTH_TOKEN", "secret-fixture-" + id);
            env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", id + "-model");
            settings.add("env", env);
            provider.add("settingsConfig", settings);
            return provider;
        }
    }
}
