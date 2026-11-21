package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.settings.SessionSupplierStateService;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class HistoryMetadataServiceTest {

    @Test
    public void extractCustomTitleReturnsSavedTitle() {
        String titlesJson = "{\"session-one\":{\"customTitle\":\"Saved by hand\",\"updatedAt\":1}}";
        assertEquals("Saved by hand", HistoryMetadataService.extractCustomTitle(titlesJson, "session-one"));
    }

    @Test
    public void extractCustomTitleIgnoresUnknownSession() {
        String titlesJson = "{\"session-one\":{\"customTitle\":\"Saved by hand\"}}";
        assertNull(HistoryMetadataService.extractCustomTitle(titlesJson, "session-two"));
    }

    @Test
    public void extractCustomTitleTreatsBlankAsAbsent() {
        String titlesJson = "{\"session-one\":{\"customTitle\":\"   \"}}";
        assertNull(HistoryMetadataService.extractCustomTitle(titlesJson, "session-one"));
    }

    @Test
    public void extractCustomTitleHandlesMissingOrInvalidPayload() {
        assertNull(HistoryMetadataService.extractCustomTitle("{}", "session-one"));
        assertNull(HistoryMetadataService.extractCustomTitle("not-json", "session-one"));
        assertNull(HistoryMetadataService.extractCustomTitle(
                "{\"session-one\":{\"updatedAt\":1}}", "session-one"));
    }

    @Test
    public void resolveSupplierIdPrefersTheOpenTabSelection() {
        SessionSupplierStateService bindings = new SessionSupplierStateService();
        bindings.saveSupplier("claude", "session-one", "saved-supplier");
        assertEquals("tab-supplier", HistoryMetadataService.resolveSupplierId(
                "session-one", "session-one", "tab-supplier", bindings));
    }

    @Test
    public void resolveSupplierIdUsesTheSavedBindingForOtherSessions() {
        SessionSupplierStateService bindings = new SessionSupplierStateService();
        bindings.saveSupplier("claude", "session-two", "saved-supplier");
        assertEquals("saved-supplier", HistoryMetadataService.resolveSupplierId(
                "session-two", "session-one", "tab-supplier", bindings));
        assertEquals("saved-supplier", HistoryMetadataService.resolveSupplierId(
                "session-two", "session-two", null, bindings));
    }

    @Test
    public void resolveSupplierIdIsNullWithoutAClaudeBinding() {
        SessionSupplierStateService bindings = new SessionSupplierStateService();
        bindings.saveSupplier("codex", "session-three", "codex-supplier");
        assertNull(HistoryMetadataService.resolveSupplierId("session-three", null, null, bindings));
        assertNull(HistoryMetadataService.resolveSupplierId("session-three", null, null, null));
    }
}
