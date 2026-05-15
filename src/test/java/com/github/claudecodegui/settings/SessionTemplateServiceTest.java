package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.SessionTemplate;
import com.intellij.util.xmlb.XmlSerializer;
import org.jdom.Element;
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

        SessionTemplate firstGet = service.getTemplate("one");
        SessionTemplate secondGet = service.getTemplate("one");
        Assert.assertNotNull(firstGet);
        Assert.assertNotNull(secondGet);
        Assert.assertNotSame(firstGet, secondGet);
    }

    @Test
    public void xmlSerializationRoundTripPreservesAllFields() {
        SessionTemplateService original = new SessionTemplateService();
        original.saveTemplate(new SessionTemplate(
                "xml-rt", "codex", "claude-sonnet-4-6",
                "bypassPermissions", "high", "/work/dir", false));

        Element serialized = XmlSerializer.serialize(original.getState());
        SessionTemplateService.State restoredState =
                XmlSerializer.deserialize(serialized, SessionTemplateService.State.class);

        SessionTemplateService restored = new SessionTemplateService();
        restored.loadState(restoredState);

        SessionTemplate loaded = restored.getTemplate("xml-rt");
        Assert.assertNotNull("template must survive XML round-trip", loaded);
        Assert.assertEquals("xml-rt", loaded.getName());
        Assert.assertEquals("codex", loaded.getProvider());
        Assert.assertEquals("claude-sonnet-4-6", loaded.getModel());
        Assert.assertEquals("bypassPermissions", loaded.getPermissionMode());
        Assert.assertEquals("high", loaded.getReasoningEffort());
        Assert.assertEquals("/work/dir", loaded.getCwd());
        Assert.assertFalse(loaded.isPsiContextEnabled());
    }

    @Test
    public void saveTemplateUsesCopyIsolation() {
        SessionTemplateService service = new SessionTemplateService();
        SessionTemplate input = new SessionTemplate("iso", "claude", "model-a", "default", "medium", "/a", true);
        service.saveTemplate(input);

        List<SessionTemplate> firstRead = service.getAllTemplates();
        List<SessionTemplate> secondRead = service.getAllTemplates();
        Assert.assertEquals(1, firstRead.size());
        Assert.assertEquals(1, secondRead.size());
        Assert.assertNotSame(firstRead.get(0), secondRead.get(0));

        SessionTemplate loaded = service.getTemplate("iso");
        Assert.assertNotNull(loaded);
        Assert.assertEquals("claude", loaded.getProvider());
        Assert.assertEquals("model-a", loaded.getModel());
    }
}
