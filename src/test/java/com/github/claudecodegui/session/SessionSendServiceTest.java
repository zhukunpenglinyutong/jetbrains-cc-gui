package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.provider.zcode.ZcodeSDKBridge;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class SessionSendServiceTest {

    @Test
    public void workflowSnapshotKeepsItsExecutionOwnerAcrossOverlappingTurnSettlement() {
        java.util.List<Boolean> selections = new java.util.ArrayList<>();
        var firstResult = new java.util.concurrent.CompletableFuture<com.github.claudecodegui.provider.common.SDKResult>();
        var nextResult = new java.util.concurrent.CompletableFuture<com.github.claudecodegui.provider.common.SDKResult>();
        var bridge = new com.github.claudecodegui.provider.claude.ClaudeSDKBridge() {
            @Override
            public java.util.concurrent.CompletableFuture<com.github.claudecodegui.provider.common.SDKResult> sendMessage(
                    String channelId, String message, String sessionId, String epoch, String cwd,
                    java.util.List<ClaudeSession.Attachment> attachments, String permissionMode, String model,
                    com.google.gson.JsonObject openedFiles, String agentPrompt, Boolean streaming,
                    Boolean disableThinking, String effort, boolean ultracode,
                    com.github.claudecodegui.provider.common.MessageCallback callback) {
                selections.add(ultracode);
                return selections.size() == 1 ? firstResult : nextResult;
            }
        };
        SessionState state = new SessionState();
        SessionSendService service = new SessionSendService(null, state, new SessionCallbackFacade(null),
                new MessageParser(), new MessageMerger(), new com.google.gson.Gson(), bridge, null, null, null);
        Object firstOwner = state.beginTurn();
        SessionExecutionOwnership firstExecution = state.currentExecutionOwnership();
        state.setClaudeUltracode(false);
        var firstSend = service.sendMessageToProvider("channel", "first", null, null, "", null,
                "default", "high", null, null, null, "first", null, true, firstOwner);

        Object nextOwner = state.beginTurn();
        state.setClaudeUltracode(true);
        service.sendMessageToProvider("channel", "stale launch", null, null, "", null,
                "default", "high", null, null, null, "stale", null, true, firstOwner).join();
        var nextSend = service.sendMessageToProvider("channel", "next", null, null, "", null,
                "default", "high", null, null, null, "next", null, false, nextOwner);
        assertEquals(java.util.List.of(true, false), selections);
        SessionExecutionState.Snapshot pendingNextTurn = state.getExecutionSnapshot();

        var cancelled = com.github.claudecodegui.provider.common.SDKResult.error("Native cancellation confirmed");
        cancelled.cancelled = true;
        firstResult.complete(cancelled);
        firstSend.join();
        assertEquals(SessionExecutionState.Outcome.CANCELLED, firstExecution.state().snapshot().outcome());
        assertEquals(pendingNextTurn, state.getExecutionSnapshot());
        nextResult.complete(com.github.claudecodegui.provider.common.SDKResult.success("Next reply"));
        nextSend.join();
        assertEquals(SessionExecutionState.Outcome.SUCCEEDED, state.getExecutionSnapshot().outcome());
    }

    @Test
    public void explicitWorkflowSelectionWinsOverMutableSessionForBothEnableAndDisable() {
        java.util.List<Boolean> selections = new java.util.ArrayList<>();
        java.util.List<String> efforts = new java.util.ArrayList<>();
        var bridge = new com.github.claudecodegui.provider.claude.ClaudeSDKBridge() {
            @Override
            public java.util.concurrent.CompletableFuture<com.github.claudecodegui.provider.common.SDKResult> sendMessage(
                    String channelId, String message, String sessionId, String epoch, String cwd,
                    java.util.List<ClaudeSession.Attachment> attachments, String permissionMode, String model,
                    com.google.gson.JsonObject openedFiles, String agentPrompt, Boolean streaming,
                    Boolean disableThinking, String effort, boolean ultracode,
                    com.github.claudecodegui.provider.common.MessageCallback callback) {
                selections.add(ultracode);
                efforts.add(effort);
                return java.util.concurrent.CompletableFuture.completedFuture(new com.github.claudecodegui.provider.common.SDKResult());
            }
        };
        SessionState state = new SessionState();
        SessionSendService service = new SessionSendService(null, state, new SessionCallbackFacade(null),
                new MessageParser(), new MessageMerger(), new com.google.gson.Gson(), bridge, null, null, null);
        state.setClaudeUltracode(false);
        service.sendMessageToProvider("channel", "first", null, null, "", null,
                "default", "high", null, null, "first", null, true).join();
        state.setClaudeUltracode(true);
        service.sendMessageToProvider("channel", "next", null, null, "", null,
                "default", "max", null, null, "next", null, false).join();
        assertEquals(java.util.List.of(true, false), selections);
        assertEquals(java.util.List.of("high", "max"), efforts);
    }

    @Test
    public void ultraIsNativeCodexEffortAndCannotLeakToOtherProviders() {
        assertEquals("ultra", SessionSendService.normalizeRequestedReasoningEffort(" ultra "));
        assertEquals("ultra", SessionSendService.resolveEffectiveReasoningEffort("codex", "ultra", "high"));
        assertEquals("ultra", SessionSendService.resolveEffectiveReasoningEffort("codex", null, "ultra"));
        for (String provider : new String[]{"claude", "grok", "zcode", "kimi"}) {
            assertNull(SessionSendService.resolveEffectiveReasoningEffort(provider, "ultra", "high"));
            assertNull(SessionSendService.resolveEffectiveReasoningEffort(provider, null, "ultra"));
            assertEquals("high", SessionSendService.resolveEffectiveReasoningEffort(provider, "high", "ultra"));
        }
    }

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
    public void resolveEffectivePermissionModeFallsBackToSessionModeAndKeepsCodexPlan() {
        assertEquals(
                "plan",
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
        // The sandbox posture is only supported by gemini; non-gemini providers normalize it to default.
        for (String provider : new String[] {"gemini", "kimi", "opencode", "pi", "dsh", "omp", "codex", "grok", "claude"}) {
            assertEquals(
                    "sandbox for " + provider,
                    "gemini".equals(provider) ? "sandbox" : "default",
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
    public void resolveEffectivePermissionModeNormalizesSandboxToDefaultForNonGemini() {
        assertEquals("sandbox", SessionSendService.resolveEffectivePermissionMode("gemini", "sandbox", null));
        assertEquals("default", SessionSendService.resolveEffectivePermissionMode("claude", "sandbox", null));
        assertEquals("default", SessionSendService.resolveEffectivePermissionMode("codex", "sandbox", null));
        assertEquals("default", SessionSendService.resolveEffectivePermissionMode("grok", "sandbox", null));
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
    public void cliReasoningEffortPassesEveryLevelToOmpAndForcesNothingWhenUnset() {
        for (String level : new String[]{"low", "medium", "high", "xhigh", "max"}) {
            assertEquals(level, SessionSendService.normalizeCliReasoningEffort("omp", level));
        }
        assertEquals("xhigh", SessionSendService.normalizeCliReasoningEffort("omp", " XHigh "));
        // No --thinking flag: the level configured in OMP itself applies.
        assertEquals("", SessionSendService.normalizeCliReasoningEffort("omp", null));
        assertEquals("", SessionSendService.normalizeCliReasoningEffort("omp", "extreme"));
    }

    @Test
    public void cliReasoningEffortKeepsThreeLevelsAndMediumDefaultForOtherCliProviders() {
        assertEquals("high", SessionSendService.normalizeCliReasoningEffort("pi", "high"));
        assertEquals("medium", SessionSendService.normalizeCliReasoningEffort("pi", "xhigh"));
        assertEquals("medium", SessionSendService.normalizeCliReasoningEffort("kimi", null));
    }

    @Test
    public void ompApprovalModeKeepsKnownModesAndTreatsEverythingElseAsOmpsOwnSetting() {
        SessionState state = new SessionState();
        assertEquals("", state.getOmpApprovalMode());

        for (String mode : new String[]{"always-ask", "write", "yolo"}) {
            state.setOmpApprovalMode(mode);
            assertEquals(mode, state.getOmpApprovalMode());
        }
        // "default" is the webview's name for "pass no --approval-mode flag".
        for (String mode : new String[]{"default", "", "bypassPermissions", "always-ask-cached", null}) {
            state.setOmpApprovalMode("yolo");
            state.setOmpApprovalMode(mode);
            assertEquals("", state.getOmpApprovalMode());
        }
    }

    @Test
    public void ompApprovalModeTravelsWithItsMessageAndOtherwiseFollowsTheTab() {
        SessionState state = new SessionState();
        state.setProvider("omp");
        state.setOmpApprovalMode("always-ask");
        List<String> sentModes = new ArrayList<>();
        MarkerCliBridge omp = new MarkerCliBridge(SessionSendServiceTest.class) {
            @Override
            protected String getProviderName() {
                return "omp";
            }

            @Override
            protected String getStdinEnvKey() {
                return "OMP_USE_STDIN";
            }

            @Override
            public CompletableFuture<SDKResult> sendMessage(String channelId, String message, String sessionId,
                    String cwd, String model, String reasoningEffort, List<ClaudeSession.Attachment> attachments,
                    String permissionMode, String dshPreset, String ompApprovalMode, Boolean thinking,
                    MessageCallback callback) {
                sentModes.add(ompApprovalMode);
                return CompletableFuture.completedFuture(SDKResult.success("ok"));
            }
        };
        SessionSendService sender = new SessionSendService(null, state, new SessionCallbackFacade(null),
                new MessageParser(), new MessageMerger(), new Gson(), null, null,
                Map.of("omp", omp), new SessionContextService(null), null, null);

        // Quick Fix states no mode: the tab's choice applies, not OMP's own (usually full auto) setting.
        sender.sendMessageToProvider("ch", "fix this", null, null, "", null, null, null, null, null,
                null, null, null, state.beginTurn()).join();
        // A message carries its own mode, whatever the tab held when the send started.
        sender.sendMessageToProvider("ch", "go", null, null, "", null, null, null, null, null,
                "yolo", null, null, state.beginTurn()).join();
        // "" is the webview's Default: no flag, even though the previous message ran in full auto.
        sender.sendMessageToProvider("ch", "again", null, null, "", null, null, null, null, null,
                "", null, null, state.beginTurn()).join();

        assertEquals(List.of("always-ask", "yolo", ""), sentModes);
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
                String ompApprovalMode,
                Boolean thinking,
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

    private static final class CapturingZcodeBridge extends ZcodeSDKBridge {
        boolean sendCalled = false;

        @Override
        public CompletableFuture<SDKResult> sendMessage(
                String channelId,
                String message,
                String sessionId,
                String runtimeSessionEpoch,
                String cwd,
                List<ClaudeSession.Attachment> attachments,
                String permissionMode,
                String model,
                JsonObject openedFiles,
                String agentPrompt,
                Boolean streaming,
                boolean disableThinking,
                String reasoningEffort,
                MessageCallback callback
        ) {
            this.sendCalled = true;
            return CompletableFuture.completedFuture(new SDKResult());
        }
    }

    private static final class CapturingClaudeBridge extends ClaudeSDKBridge {
        boolean sendCalled = false;

        @Override
        public CompletableFuture<SDKResult> sendMessage(
                String channelId,
                String message,
                String sessionId,
                String runtimeSessionEpoch,
                String cwd,
                List<ClaudeSession.Attachment> attachments,
                String permissionMode,
                String model,
                JsonObject openedFiles,
                String agentPrompt,
                Boolean streaming,
                Boolean disableThinking,
                String reasoningEffort,
                boolean ultracode,
                MessageCallback callback
        ) {
            this.sendCalled = true;
            return CompletableFuture.completedFuture(new SDKResult());
        }
    }

    private static SessionLifecycleManager.SessionHost hostWithZcode(Project project, ZcodeSDKBridge zcodeBridge) {
        return (SessionLifecycleManager.SessionHost) Proxy.newProxyInstance(
                SessionLifecycleManager.SessionHost.class.getClassLoader(),
                new Class<?>[]{SessionLifecycleManager.SessionHost.class},
                (proxy, method, args) -> {
                    String name = method.getName();
                    if ("getProject".equals(name)) return project;
                    if ("getZcodeSDKBridge".equals(name)) return zcodeBridge;
                    if ("getCliBridges".equals(name)) return Map.of();
                    Class<?> rt = method.getReturnType();
                    if (rt == boolean.class) return false;
                    if (rt == int.class) return 0;
                    if (rt == long.class) return 0L;
                    return null;
                }
        );
    }

    @Test
    public void createDefaultSessionPreservesZcodeBridge() throws Exception {
        CapturingZcodeBridge zcodeBridge = new CapturingZcodeBridge();
        Project project = projectWithBase(tmpdir());
        SessionLifecycleManager.SessionHost host = hostWithZcode(project, zcodeBridge);
        SessionLifecycleManager lifecycleManager = new SessionLifecycleManager(host);

        Method m = SessionLifecycleManager.class.getDeclaredMethod("createDefaultSession");
        m.setAccessible(true);
        ClaudeSession session = (ClaudeSession) m.invoke(lifecycleManager);

        Field field = ClaudeSession.class.getDeclaredField("zcodeSDKBridge");
        field.setAccessible(true);
        Object bridgeInSession = field.get(session);

        assertSame(zcodeBridge, bridgeInSession);
    }

    @Test
    public void zcodeWithoutBridgeDoesNotTriggerCliProviderNotImplementedError() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("zcode");
        CapturingClaudeBridge claudeBridge = new CapturingClaudeBridge();
        Project project = projectWithBase(tmpdir());

        SessionSendService service = new SessionSendService(
                project,
                state,
                new SessionCallbackFacade(project),
                null,
                null,
                null,
                claudeBridge,
                null,
                Map.of(),
                new SessionContextService(project),
                null,
                null
        );

        service.sendMessageToProvider(
                "channel-1", "hello", null, null, null, null, null, null, null, null
        ).get(5, java.util.concurrent.TimeUnit.SECONDS);

        assertNull(state.getError());
        assertTrue(claudeBridge.sendCalled);
    }
}
