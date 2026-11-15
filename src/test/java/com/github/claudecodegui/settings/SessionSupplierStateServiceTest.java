package com.github.claudecodegui.settings;

import com.intellij.util.xmlb.XmlSerializer;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class SessionSupplierStateServiceTest {
    @Test
    public void removedHistoryBindingsStayRemovedAfterRestartWithoutAffectingOtherBindings() {
        SessionSupplierStateService service = new SessionSupplierStateService();
        service.saveSupplier("codex", "deleted-history", "codex-a");
        service.saveSupplier("claude", "deleted-history", "claude-b");
        service.saveSupplier("codex", "retained-history", "codex-c");
        service.removeSupplier("codex", "deleted-history");
        service.removeSupplier("codex", "deleted-history");
        SessionSupplierStateService restored = new SessionSupplierStateService();
        restored.loadState(XmlSerializer.deserialize(XmlSerializer.serialize(service.getState()), SessionSupplierStateService.Bindings.class));
        assertNull(restored.getSupplier("codex", "deleted-history"));
        assertEquals("claude-b", restored.getSupplier("claude", "deleted-history"));
        assertEquals("codex-c", restored.getSupplier("codex", "retained-history"));
    }

    @Test
    public void historyBindingsSurviveRestartAndRemainIndependentOfProjectAndEngine() {
        SessionSupplierStateService service = new SessionSupplierStateService();
        service.saveSupplier("claude", "history-session", "claude-a");
        service.saveSupplier("codex", "history-session", "codex-b");
        SessionSupplierStateService restored = new SessionSupplierStateService();
        restored.loadState(XmlSerializer.deserialize(XmlSerializer.serialize(service.getState()), SessionSupplierStateService.Bindings.class));
        assertEquals("claude-a", restored.getSupplier("claude", "history-session"));
        assertEquals("codex-b", restored.getSupplier("codex", "history-session"));
        service.getState().suppliers.clear();
        assertEquals("claude-a", service.getSupplier("claude", "history-session"));
    }
}
