package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SessionSendServiceTest {

    @Test
    public void normalizeRequestedPermissionModeRejectsBlankAndUnknownValues() {
        assertNull(SessionSendService.normalizeRequestedPermissionMode(null));
        assertNull(SessionSendService.normalizeRequestedPermissionMode(" "));
        assertNull(SessionSendService.normalizeRequestedPermissionMode("dangerouslyAllowEverything"));
        assertEquals("acceptEdits", SessionSendService.normalizeRequestedPermissionMode("autoEdit"));
    }

    @Test
    public void resolveEffectivePermissionModePrefersRequestedModeWhenValid() {
        assertEquals(
                "acceptEdits",
                SessionSendService.resolveEffectivePermissionMode("claude", "acceptEdits", "default")
        );
    }

    @Test
    public void resolveEffectivePermissionModeFallsBackToSessionModeAndDowngradesCodexPlan() {
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("codex", null, "plan")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("claude", null, null)
        );
    }

    @Test
    public void resolveEffectivePermissionModeDowngradesPlanForCliProviders() {
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("grok", "plan", "acceptEdits")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("kimi", "plan", null)
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("opencode", null, "plan")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("pi", "plan", null)
        );
    }

    @Test
    public void resolveEffectivePermissionModeDowngradesNativeAutoForCliProvidersWithoutNativeReviewer() {
        // Grok's ACP bridge already uses "auto" as its internal always-approve alias.
        assertEquals(
                "auto",
                SessionSendService.resolveEffectivePermissionMode("grok", "auto", "acceptEdits")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("kimi", null, "auto")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("omp", "auto", "slow")
        );
        assertEquals(
                "default",
                SessionSendService.resolveEffectivePermissionMode("dsh", "auto", "acceptEdits")
        );
        assertEquals(
                "auto",
                SessionSendService.resolveEffectivePermissionMode("codex", "auto", "default")
        );
        assertEquals(
                "auto",
                SessionSendService.resolveEffectivePermissionMode("claude", null, "auto")
        );
    }

    @Test
    public void resolveEffectivePermissionModeKeepsPlanForOmpModelRole() {
        // omp's "plan" is a model role (`omp --model plan`), NOT Claude plan mode,
        // so it must survive resolution while other CLI providers are coerced.
        assertEquals(
                "plan",
                SessionSendService.resolveEffectivePermissionMode("omp", "plan", "default")
        );
        assertEquals(
                "plan",
                SessionSendService.resolveEffectivePermissionMode("omp", null, "plan")
        );
        // smol/slow roles pass through untouched as well.
        assertEquals(
                "smol",
                SessionSendService.resolveEffectivePermissionMode("omp", "smol", "default")
        );
        assertEquals(
                "slow",
                SessionSendService.resolveEffectivePermissionMode("omp", null, "slow")
        );
    }

    @Test
    public void resolveEffectivePermissionModeKeepsPlanForGeminiNativePlanMode() {
        // The gemini CLI natively supports plan/read-only (`agy --mode plan`),
        // so unlike kimi/opencode/pi/dsh its plan must survive resolution.
        assertEquals(
                "plan",
                SessionSendService.resolveEffectivePermissionMode("gemini", "plan", "default")
        );
        assertEquals(
                "plan",
                SessionSendService.resolveEffectivePermissionMode("gemini", null, "plan")
        );
    }

    @Test
    public void resolveEffectivePermissionModeNeverCoercesSandboxForAnyProvider() {
        // The sandbox posture has no legacy downgrade path anywhere.
        for (String provider : new String[] {"gemini", "kimi", "opencode", "pi", "dsh", "omp", "codex", "grok", "claude"}) {
            assertEquals(
                    "sandbox for " + provider,
                    "sandbox",
                    SessionSendService.resolveEffectivePermissionMode(provider, "sandbox", "default")
            );
        }
    }

    @Test
    public void permissionModeWhitelistAcceptsOmpModelRoles() {
        assertTrue(SessionState.isValidPermissionMode("smol"));
        assertTrue(SessionState.isValidPermissionMode("slow"));
        assertTrue(SessionState.isValidPermissionMode("plan"));
        assertEquals("smol", SessionSendService.normalizeRequestedPermissionMode("smol"));
        assertEquals("slow", SessionSendService.normalizeRequestedPermissionMode(" slow "));
    }

    @Test
    public void resolveEffectivePermissionModePreservesBypassForGrokFullAuto() {
        // Regression: UI "全自动" (bypassPermissions) must survive resolution so
        // MarkerCliBridge can pass it into Grok ACP auto-approve — otherwise every
        // edit/tool still pops the permission dialog under default mode.
        assertEquals(
                "bypassPermissions",
                SessionSendService.resolveEffectivePermissionMode("grok", "bypassPermissions", "default")
        );
        assertEquals(
                "bypassPermissions",
                SessionSendService.resolveEffectivePermissionMode("grok", null, "bypassPermissions")
        );
        assertEquals(
                "acceptEdits",
                SessionSendService.resolveEffectivePermissionMode("grok", "acceptEdits", null)
        );
    }

    @Test
    public void normalizeCliModelForProviderMapsSentinelsAndGrokLegacyIds() {
        assertNull(SessionSendService.normalizeCliModelForProvider("kimi", "auto"));
        assertNull(SessionSendService.normalizeCliModelForProvider("opencode", "opencode-default"));
        assertEquals("kimi-k2.5", SessionSendService.normalizeCliModelForProvider("kimi", "kimi-k2.5"));
        assertEquals("grok-4.6", SessionSendService.normalizeCliModelForProvider("grok", "grok-4.6"));
        assertEquals("grok-4.6", SessionSendService.normalizeCliModelForProvider("grok", "grok-4.5"));
        assertEquals("grok-4.6", SessionSendService.normalizeCliModelForProvider("grok", "grok"));
        assertNull(SessionSendService.normalizeCliModelForProvider("grok", "claude-sonnet-5"));
    }

    @Test
    public void normalizeCliModelForProviderKeepsAgyCrossVendorCatalogSlugs() {
        // The live agy catalog sells cross-vendor models — they are real picks,
        // not leftovers, and must reach the CLI verbatim.
        assertEquals("claude-sonnet-4-6",
                SessionSendService.normalizeCliModelForProvider("gemini", "claude-sonnet-4-6"));
        assertEquals("claude-opus-4-6-thinking",
                SessionSendService.normalizeCliModelForProvider("gemini", "claude-opus-4-6-thinking"));
        assertEquals("gpt-oss-120b-medium",
                SessionSendService.normalizeCliModelForProvider("gemini", "gpt-oss-120b-medium"));
        // Gemini-family slugs keep flowing, sentinel still collapses to default.
        assertEquals("gemini-3.7-flash-high",
                SessionSendService.normalizeCliModelForProvider("gemini", "gemini-3.7-flash-high"));
        assertNull(SessionSendService.normalizeCliModelForProvider("gemini", "auto"));
        // Other CLI providers keep dropping cross-vendor leftovers.
        assertNull(SessionSendService.normalizeCliModelForProvider("kimi", "claude-sonnet-4-6"));
        assertNull(SessionSendService.normalizeCliModelForProvider("kimi", "gpt-oss-120b-medium"));
        assertNull(SessionSendService.normalizeCliModelForProvider("opencode", "claude-sonnet-4-6"));
    }

    @Test
    public void normalizeRequestedReasoningEffortRejectsBlankAndUnknownValues() {
        assertNull(SessionSendService.normalizeRequestedReasoningEffort(null));
        assertNull(SessionSendService.normalizeRequestedReasoningEffort(" "));
        assertNull(SessionSendService.normalizeRequestedReasoningEffort("extreme"));
        assertEquals("low", SessionSendService.normalizeRequestedReasoningEffort(" low "));
        assertEquals("xhigh", SessionSendService.normalizeRequestedReasoningEffort("xhigh"));
        assertEquals("max", SessionSendService.normalizeRequestedReasoningEffort("max"));
    }

    @Test
    public void getCodexRuntimeAccessErrorRequiresAuthorizationOrManagedProvider() {
        assertEquals(
                "Codex local configuration access is not authorized. Please authorize local ~/.codex access or enable a managed Codex provider first.",
                SessionSendService.getCodexRuntimeAccessError("inactive")
        );
        assertNull(SessionSendService.getCodexRuntimeAccessError("managed"));
        assertNull(SessionSendService.getCodexRuntimeAccessError("cli_login"));
    }

    @Test
    public void newSessionStateDoesNotInjectDefaultClaudeReasoningEffort() {
        SessionState state = new SessionState();

        assertNull(state.getReasoningEffort());
    }

    @Test
    public void normalizeRequestedCodexServiceTierMapsFastAliasesOnly() {
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.normalizeRequestedCodexServiceTier("fast")
        );
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.normalizeRequestedCodexServiceTier("priority")
        );
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier("normal"));
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier("standard"));
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier(""));
        assertNull(SessionSendService.normalizeRequestedCodexServiceTier("experimental-tier"));
    }

    @Test
    public void resolveEffectiveCodexServiceTierDoesNotSendTierForNormalMode() {
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier("normal", null));
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier("standard", "fast"));
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier("default", "priority"));
    }

    @Test
    public void resolveEffectiveCodexServiceTierFallsBackToSessionTierWhenNoRequestedMode() {
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.resolveEffectiveCodexServiceTier(null, "fast")
        );
        assertEquals(
                SessionSendService.CODEX_FAST_SERVICE_TIER,
                SessionSendService.resolveEffectiveCodexServiceTier(null, "priority")
        );
        assertNull(SessionSendService.resolveEffectiveCodexServiceTier(null, "normal"));
    }

    @Test
    public void resolveCliSendCwdClampsOutsideCwdToProjectBase() {
        String project = Paths.get(tmpdir(), "proj").toString();
        String outside = Paths.get(tmpdir(), "elsewhere").toString();
        assertEquals(project, SessionSendService.resolveCliSendCwd(outside, project));
    }

    @Test
    public void resolveCliSendCwdKeepsCwdInsideProjectVerbatim() {
        String project = Paths.get(tmpdir(), "proj").toString();
        String nested = Paths.get(project, "src", "deep").toString();
        assertEquals(nested, SessionSendService.resolveCliSendCwd(nested, project));
        assertEquals(project, SessionSendService.resolveCliSendCwd(project, project));
    }

    @Test
    public void resolveCliSendCwdClampsSentinelCwdToProjectBase() {
        String project = Paths.get(tmpdir(), "proj").toString();
        // The webview sends these sentinels when no cwd was chosen.
        assertEquals(project, SessionSendService.resolveCliSendCwd(null, project));
        assertEquals(project, SessionSendService.resolveCliSendCwd("", project));
        assertEquals(project, SessionSendService.resolveCliSendCwd("undefined", project));
        assertEquals(project, SessionSendService.resolveCliSendCwd("null", project));
    }

    @Test
    public void resolveCliSendCwdPassesThroughWhenNoProjectBase() {
        // No project base: nothing to clamp to — the raw cwd is kept (the caller
        // logs the degraded guard instead of failing the send).
        String anywhere = Paths.get(tmpdir(), "anywhere").toString();
        assertEquals(anywhere, SessionSendService.resolveCliSendCwd(anywhere, null));
        assertEquals(anywhere, SessionSendService.resolveCliSendCwd(anywhere, ""));
        assertNull(SessionSendService.resolveCliSendCwd(null, null));
    }

    private String tmpdir() {
        return Paths.get(System.getProperty("java.io.tmpdir")).toAbsolutePath().toString();
    }

    // ------------------------------------------------------------------
    // R-15: the actual (guarded cwd, pre-clamp requestedCwd) tuple forwarded
    // to the bridge must survive the send path intact.
    // ------------------------------------------------------------------

    /** Records the full sendMessage argument tuple instead of spawning. */
    private static final class CapturingBridge extends MarkerCliBridge {
        String channelId;
        String message;
        String sessionId;
        String cwd;
        String model;
        String reasoningEffort;
        String permissionMode;
        String dshPreset;
        String requestedCwd;
        int calls;

        CapturingBridge() {
            super(MarkerCliBridge.class);
        }

        @Override
        protected String getProviderName() {
            return "capturing";
        }

        @Override
        protected String getStdinEnvKey() {
            return "CAPTURING_USE_STDIN";
        }

        @Override
        public CompletableFuture<SDKResult> sendMessage(
                String channelId,
                String message,
                String sessionId,
                String cwd,
                String model,
                String reasoningEffort,
                List<ClaudeSession.Attachment> attachments,
                String permissionMode,
                String dshPreset,
                String requestedCwd,
                MessageCallback callback
        ) {
            this.calls++;
            this.channelId = channelId;
            this.message = message;
            this.sessionId = sessionId;
            this.cwd = cwd;
            this.model = model;
            this.reasoningEffort = reasoningEffort;
            this.permissionMode = permissionMode;
            this.dshPreset = dshPreset;
            this.requestedCwd = requestedCwd;
            return CompletableFuture.completedFuture(new SDKResult());
        }
    }

    /** Headless Project stand-in: only getBasePath() is meaningful here. */
    private static Project projectWithBase(String basePath) {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> {
                    if ("getBasePath".equals(method.getName()) && method.getParameterCount() == 0) {
                        return basePath;
                    }
                    Class<?> rt = method.getReturnType();
                    if (rt == boolean.class) return false;
                    if (rt == int.class) return 0;
                    if (rt == long.class) return 0L;
                    if (rt == float.class) return 0f;
                    if (rt == double.class) return 0d;
                    return null;
                }
        );
    }

    @Test
    public void sendToCliProviderForwardsGuardedCwdAndPreClampRequestedCwd() throws Exception {
        Path projectDir = Files.createTempDirectory("gemini-send-proj-");
        projectDir.toFile().deleteOnExit();
        String requested = Paths.get(tmpdir(), "outside-project-" + System.nanoTime()).toString();
        SessionState state = new SessionState();
        state.setCwd(requested);
        // A fresh SessionState defaults its model to a claude slug; the gemini
        // flow always carries an explicit model from the webview, so seed the
        // sentinel the way a real gemini turn does.
        state.setModel("auto");
        CapturingBridge bridge = new CapturingBridge();
        Project project = projectWithBase(projectDir.toString());
        SessionSendService service = new SessionSendService(
                project,
                state,
                new SessionCallbackFacade(project),
                null,
                null,
                null,
                null,
                null,
                Map.of("gemini", bridge),
                new SessionContextService(project)
        );

        service.sendToCliProvider("gemini", "channel-1", "hello", null, null, null, null, null, null)
                .get(5, java.util.concurrent.TimeUnit.SECONDS);

        assertEquals(1, bridge.calls);
        // cwd is the CLAMPED workspace, requestedCwd is what the user asked
        // for — both reach the bridge, in the right slots.
        assertEquals(projectDir.toString(), bridge.cwd);
        assertEquals(requested, bridge.requestedCwd);
        assertNotEquals(bridge.cwd, bridge.requestedCwd);
        // Current (review-deferred) behaviour: the clamp is persisted into the
        // session state, so a repeat turn has requested == guarded and stays
        // silent. Pin it so a product-level change (re-notice per turn) is
        // conscious, not accidental.
        assertEquals(projectDir.toString(), state.getCwd());
        // The remaining tuple is pinned too so nearby refactors cannot drift.
        assertEquals("channel-1", bridge.channelId);
        assertEquals("hello", bridge.message);
        assertEquals("default", bridge.permissionMode);
        assertEquals("medium", bridge.reasoningEffort);
        // The 'auto' sentinel collapses to the empty string — omitting --model
        // lets the CLI pick its own default. Cross-vendor slugs
        // (claude-sonnet-4-6, gpt-oss-120b-medium) pass through untouched:
        // the agy catalog sells them for real, so no vendor-prefix strip.
        assertEquals("", bridge.model);
        assertNull(bridge.dshPreset);
    }

    @Test
    public void sendToCliProviderOutsideGeminiSkipsTheClampAndForwardedRequestedCwd() throws Exception {
        // Review loop 3 (decision (a)): the send-path clamp + requestedCwd
        // forwarding are gemini-only. A sibling provider keeps its pre-story
        // behavior — raw cwd through, no requestedCwd key, no state mutation.
        Path projectDir = Files.createTempDirectory("kimi-send-proj-");
        projectDir.toFile().deleteOnExit();
        String outside = Paths.get(tmpdir(), "outside-sibling-" + System.nanoTime()).toString();
        SessionState state = new SessionState();
        state.setCwd(outside);
        CapturingBridge bridge = new CapturingBridge();
        Project project = projectWithBase(projectDir.toString());
        SessionSendService service = new SessionSendService(
                project,
                state,
                new SessionCallbackFacade(project),
                null,
                null,
                null,
                null,
                null,
                Map.of("kimi", bridge),
                new SessionContextService(project)
        );

        service.sendToCliProvider("kimi", "channel-1", "hello", null, null, null, null, null, null)
                .get(5, java.util.concurrent.TimeUnit.SECONDS);

        assertEquals(1, bridge.calls);
        assertEquals(outside, bridge.cwd);
        assertNull(bridge.requestedCwd);
        assertEquals("the clamp must not touch sibling session state", outside, state.getCwd());
    }
}
