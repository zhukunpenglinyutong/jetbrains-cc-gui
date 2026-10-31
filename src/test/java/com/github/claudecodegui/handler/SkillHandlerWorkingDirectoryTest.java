package com.github.claudecodegui.handler;

import com.github.claudecodegui.skill.CodexSkillService;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SkillHandlerWorkingDirectoryTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void codexManagementUsesTheExternalSessionDirectory() throws Exception {
        Path project = temporary.newFolder("idea-project").toPath();
        Path session = temporary.newFolder("session-project").toPath();
        Path skill = Files.createDirectories(session.resolve(".agents/skills/example")).resolve("SKILL.md");
        Files.writeString(skill, "---\nname: example\ndescription: Test skill\n---\n");

        String cwd = SkillHandler.resolveWorkspaceRoot(true, session.toString(), project.toString());
        assertEquals(session.toString(), cwd);
        assertTrue(CodexSkillService.isToggleSkillPathAllowed(skill.toString(), cwd));
        assertFalse(CodexSkillService.isToggleSkillPathAllowed(skill.toString(), project.toString()));
    }

    @Test public void missingSessionDirectoryFallsBackToProject() {
        assertEquals("project", SkillHandler.resolveWorkspaceRoot(true, null, "project"));
        assertEquals("project", SkillHandler.resolveWorkspaceRoot(true, "  ", "project"));
    }

    @Test public void claudeManagementKeepsUsingProjectDirectory() {
        assertEquals("project", SkillHandler.resolveWorkspaceRoot(false, "session", "project"));
    }
}
