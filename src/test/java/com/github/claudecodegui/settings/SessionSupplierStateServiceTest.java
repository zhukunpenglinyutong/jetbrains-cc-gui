package com.github.claudecodegui.settings;

import com.intellij.util.xmlb.XmlSerializer;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class SessionSupplierStateServiceTest {
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
