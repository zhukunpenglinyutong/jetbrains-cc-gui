package com.github.claudecodegui.session;

import org.junit.Assert;
import org.junit.Test;

/**
 * Regression tests for retired Claude model id migration on session state writes
 * (persisted tab / history restore self-heal) - see #1678.
 */
public class SessionStateTest {

    @Test
    public void setModelMigratesRetiredSonnet47ToSonnet5() {
        SessionState state = new SessionState();
        // Saved by versions <= 0.5.2 where sonnet-4-7 was the default model.
        state.setModel("claude-sonnet-4-7");
        Assert.assertEquals("claude-sonnet-5", state.getModel());
    }

    @Test
    public void setModelMigratesRetiredSonnet46ToSonnet5() {
        SessionState state = new SessionState();
        state.setModel("claude-sonnet-4-6");
        Assert.assertEquals("claude-sonnet-5", state.getModel());
    }

    @Test
    public void setModelMigratesRetiredOpus48ToOpus5() {
        SessionState state = new SessionState();
        state.setModel("claude-opus-4-8");
        Assert.assertEquals("claude-opus-5", state.getModel());
    }

    @Test
    public void setModelPreserves1MSuffixWhenMigrating() {
        SessionState state = new SessionState();
        state.setModel("claude-sonnet-4-7[1m]");
        Assert.assertEquals("claude-sonnet-5[1m]", state.getModel());
    }

    @Test
    public void setModelLeavesLiveModelsUntouched() {
        SessionState state = new SessionState();
        state.setModel("claude-sonnet-5");
        Assert.assertEquals("claude-sonnet-5", state.getModel());
        state.setModel("claude-fable-5-1[1m]");
        Assert.assertEquals("claude-fable-5-1[1m]", state.getModel());
        // claude-opus-4-6 is still live and is commonly added as a custom model.
        state.setModel("claude-opus-4-6[1m]");
        Assert.assertEquals("claude-opus-4-6[1m]", state.getModel());
    }

    @Test
    public void setModelLeavesNonClaudeAndUnknownIdsUntouched() {
        SessionState state = new SessionState();
        // Non-Claude provider models must pass through unchanged.
        state.setModel("gpt-5.6-sol");
        Assert.assertEquals("gpt-5.6-sol", state.getModel());
        state.setModel("qwen3.5-plus");
        Assert.assertEquals("qwen3.5-plus", state.getModel());
    }

    @Test
    public void setModelHandlesNullAndBlank() {
        SessionState state = new SessionState();
        state.setModel(null);
        Assert.assertNull(state.getModel());
        // Blank input is trimmed like every other normalizeRetiredModelId path.
        state.setModel("  ");
        Assert.assertEquals("", state.getModel());
    }

    @Test
    public void nativeAutoIsAValidPermissionMode() {
        SessionState state = new SessionState();
        state.setPermissionMode("auto");
        Assert.assertEquals("auto", state.getPermissionMode());
        Assert.assertTrue(SessionState.isValidPermissionMode("auto"));
    }

    @Test
    public void unknownPermissionModeDoesNotReplaceCurrentMode() {
        SessionState state = new SessionState();
        state.setPermissionMode("auto");
        state.setPermissionMode("automatic-but-unknown");
        Assert.assertEquals("auto", state.getPermissionMode());
    }

    @Test
    public void legacyAutoEditPermissionModeMigratesToAcceptEdits() {
        SessionState state = new SessionState();
        state.setPermissionMode(" autoEdit ");
        Assert.assertEquals("acceptEdits", state.getPermissionMode());
    }

    @Test
    public void setModelVerbatimKeepsRetiredIdsForExplicitUserSelection() {
        SessionState state = new SessionState();
        // A user-defined custom model that happens to be in the retired table
        // must be stored as typed - the user chose it on purpose.
        state.setModelVerbatim("claude-opus-4-8[1m]");
        Assert.assertEquals("claude-opus-4-8[1m]", state.getModel());
        state.setModelVerbatim("  claude-sonnet-4-7  ");
        Assert.assertEquals("claude-sonnet-4-7", state.getModel());
        state.setModelVerbatim(null);
        Assert.assertNull(state.getModel());
    }

    @Test
    public void defaultModelIsTheLiveSonnet5() {
        SessionState state = new SessionState();
        // The initial value must never be a retired id (#1678).
        Assert.assertEquals("claude-sonnet-5", state.getModel());
    }

    @Test
    public void capabilitiesDefaultFalseAndPersistUntilClearMessages() {
        SessionState state = new SessionState();
        Assert.assertFalse(state.isSteerCapable());
        Assert.assertFalse(state.getCapabilitiesJson().get("steer").getAsBoolean());

        state.setSteerCapable(true);
        state.setSessionId("same-turn-session");
        Assert.assertTrue(state.isSteerCapable());

        state.clearMessages();
        Assert.assertFalse(state.isSteerCapable());
    }
}
