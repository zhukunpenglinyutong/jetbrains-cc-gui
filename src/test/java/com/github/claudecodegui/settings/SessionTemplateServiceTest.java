package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.SessionTemplate;
import org.junit.Assert;
import org.junit.Test;

public class SessionTemplateServiceTest {

    @Test
    public void saveGetDeleteAndExistsWork() {
        SessionTemplateService service = new SessionTemplateService();
        SessionTemplate template = new SessionTemplate(
                "base",
                "claude",
                "claude-sonnet-4-6",
                "bypassPermissions",
                "high",
                "/tmp/project",
                true
        );

        service.saveTemplate(template);
        Assert.assertTrue(service.templateExists("base"));

        SessionTemplate loaded = service.getTemplate("base");
        Assert.assertNotNull(loaded);
        Assert.assertEquals("claude", loaded.getProvider());
        Assert.assertEquals("claude-sonnet-4-6", loaded.getModel());

        service.deleteTemplate("base");
        Assert.assertFalse(service.templateExists("base"));
        Assert.assertNull(service.getTemplate("base"));
    }

    @Test
    public void saveTemplateOverwritesByName() {
        SessionTemplateService service = new SessionTemplateService();
        service.saveTemplate(new SessionTemplate("dup", "claude", "a", "default", "low", null, true));
        service.saveTemplate(new SessionTemplate("dup", "codex", "b", "plan", "high", "/cwd", false));

        SessionTemplate loaded = service.getTemplate("dup");
        Assert.assertNotNull(loaded);
        Assert.assertEquals("codex", loaded.getProvider());
        Assert.assertEquals("b", loaded.getModel());
        Assert.assertEquals("plan", loaded.getPermissionMode());
        Assert.assertEquals("high", loaded.getReasoningEffort());
        Assert.assertEquals("/cwd", loaded.getCwd());
        Assert.assertFalse(loaded.isPsiContextEnabled());
    }

    @Test
    public void stateRoundTripPersistsTemplates() {
        SessionTemplateService original = new SessionTemplateService();
        original.saveTemplate(new SessionTemplate("rt", "claude", "m", "default", "medium", "/x", true));

        SessionTemplateService restored = new SessionTemplateService();
        restored.loadState(original.getState());

        SessionTemplate loaded = restored.getTemplate("rt");
        Assert.assertNotNull(loaded);
        Assert.assertEquals("m", loaded.getModel());
        Assert.assertEquals("/x", loaded.getCwd());
    }
}

