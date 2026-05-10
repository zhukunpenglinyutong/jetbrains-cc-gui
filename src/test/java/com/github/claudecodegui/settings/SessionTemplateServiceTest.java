package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.SessionTemplate;
import org.junit.Assert;
import org.junit.Test;

import java.util.List;

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
        Assert.assertEquals(1, service.getAllTemplates().size());
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

    @Test
    public void getAllTemplatesReturnsDefensiveCopies() {
        SessionTemplateService service = new SessionTemplateService();
        service.saveTemplate(new SessionTemplate("one", "claude", "m1", "default", "medium", "/a", true));
        service.saveTemplate(new SessionTemplate("two", "codex", "m2", "plan", "high", "/b", false));

        List<SessionTemplate> firstRead = service.getAllTemplates();
        List<SessionTemplate> secondRead = service.getAllTemplates();

        Assert.assertEquals(2, firstRead.size());
        Assert.assertEquals(2, secondRead.size());
        Assert.assertNotSame(firstRead.get(0), secondRead.get(0));
        firstRead.clear();
        Assert.assertEquals(2, service.getAllTemplates().size());
    }

    @Test
    public void saveTemplateUsesCopyIsolation() {
        SessionTemplateService service = new SessionTemplateService();
        SessionTemplate input = new SessionTemplate("iso", "claude", "model-a", "default", "medium", "/a", true);
        service.saveTemplate(input);

        input = new SessionTemplate("iso", "codex", "model-b", "plan", "high", "/b", false);
        SessionTemplate loaded = service.getTemplate("iso");
        Assert.assertNotNull(loaded);
        Assert.assertEquals("claude", loaded.getProvider());
        Assert.assertEquals("model-a", loaded.getModel());
    }
}
