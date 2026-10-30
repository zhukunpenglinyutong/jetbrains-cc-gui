package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
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
                "default", "high", null, null, "first", null, true, firstOwner);

        Object nextOwner = state.beginTurn();
        state.setClaudeUltracode(true);
        service.sendMessageToProvider("channel", "stale launch", null, null, "", null,
                "default", "high", null, null, "stale", null, true, firstOwner).join();
        var nextSend = service.sendMessageToProvider("channel", "next", null, null, "", null,
                "default", "high", null, null, "next", null, false, nextOwner);
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
}
