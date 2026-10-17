package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SessionContextServiceTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void buildUserMessageIncludesImageBlockAndTextContent() {
        SessionContextService service = new SessionContextService(null);
        List<ClaudeSession.Attachment> attachments = List.of(
                new ClaudeSession.Attachment("diagram.png", "image/png", "base64-data")
        );

        ClaudeSession.Message message = service.buildUserMessage("Please inspect this diagram", attachments);

        assertEquals(ClaudeSession.Message.Type.USER, message.type);
        assertEquals("Please inspect this diagram", message.content);
        JsonArray content = message.raw.getAsJsonObject("message").getAsJsonArray("content");
        assertEquals(2, content.size());
        assertEquals("image", content.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("text", content.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("Please inspect this diagram",
                content.get(1).getAsJsonObject().get("text").getAsString());
    }

    /** Module metadata belongs to native session instructions rather than every user turn. */
    @Test
    public void codexUserContextDoesNotRepeatProjectModules() {
        JsonObject openedFiles = new JsonObject();
        JsonArray modules = new JsonArray();
        for (String name : List.of("project", "project.main", "project.test")) {
            JsonObject module = new JsonObject();
            module.addProperty("name", name);
            modules.add(module);
        }
        openedFiles.add("modules", modules);
        openedFiles.addProperty("active", "src/Active.java");
        SessionContextService service = new SessionContextService(null);
        String firstTurn = service.buildCodexContextAppend(openedFiles, List.of("src/Other.java"));
        String nextTurn = service.buildCodexContextAppend(openedFiles, List.of("src/Next.java"));
        assertFalse(firstTurn.contains("Project Modules"));
        assertFalse(nextTurn.contains("project.main"));
        assertTrue(firstTurn.contains("src/Active.java"));
        assertTrue(firstTurn.contains("src/Other.java"));
        assertTrue(nextTurn.contains("src/Next.java"));
    }

    /** Role and project context survive native initialization without contaminating subsequent user input. */
    @Test
    public void nativeSessionInstructionsKeepModulesAndTheSelectedRole() {
        JsonObject openedFiles = com.google.gson.JsonParser.parseString("""
                {"modules":[{"name":"project"},{"name":"project.main"},{}]}
                """).getAsJsonObject();
        SessionContextService service = new SessionContextService(null);
        String instructions = service.buildCodexSessionInstructions("Review carefully.", openedFiles);
        assertTrue(instructions.startsWith("Review carefully.\n\n## Project Modules"));
        assertTrue(instructions.contains("`project.main`"));
        assertTrue(instructions.contains("`unknown`"));
        assertEquals(instructions, service.buildCodexSessionInstructions("Review carefully.", openedFiles));
        assertTrue(service.buildLegacyContextAppend(openedFiles, null).contains("## Project Modules"));
        assertEquals("## Project Modules", service.buildCodexSessionInstructions(null, openedFiles).lines().findFirst().orElseThrow());
        assertTrue(service.buildCodexSessionInstructions(" ", openedFiles).startsWith("## Project Modules"));
        for (JsonObject context : java.util.Arrays.asList(null, new JsonObject(),
                com.google.gson.JsonParser.parseString("{\"modules\":[]}").getAsJsonObject(),
                com.google.gson.JsonParser.parseString("{\"modules\":[{\"name\":\"one\"}]}").getAsJsonObject(),
                com.google.gson.JsonParser.parseString("{\"modules\":\"unknown\"}").getAsJsonObject(),
                com.google.gson.JsonParser.parseString("{\"isWorkspace\":true,\"modules\":[{},{}]}").getAsJsonObject())) {
            assertEquals("Role", service.buildCodexSessionInstructions("Role", context));
        }
    }

    @Test
    public void buildCodexContextAppendReferencesPathsWithoutInliningContent() throws Exception {
        File referencedFile = temporaryFolder.newFile("ReferencedExample.java");
        Files.writeString(referencedFile.toPath(), "class ReferencedExample {}", StandardCharsets.UTF_8);

        File activeFile = temporaryFolder.newFile("ActiveExample.java");
        Files.writeString(activeFile.toPath(), "class ActiveExample {}", StandardCharsets.UTF_8);

        JsonObject openedFilesJson = new JsonObject();
        openedFilesJson.addProperty("active", activeFile.getAbsolutePath());

        JsonObject selection = new JsonObject();
        selection.addProperty("startLine", 3);
        selection.addProperty("endLine", 5);
        selection.addProperty("selectedText", "logger.info(\"hello\");");
        openedFilesJson.add("selection", selection);

        SessionContextService service = new SessionContextService(null);

        String context = service.buildCodexContextAppend(
                openedFilesJson,
                List.of(referencedFile.getAbsolutePath(), "terminal://backend-shell")
        );

        assertTrue(context.contains("## Active Terminal Session"));
        assertTrue(context.contains("`backend-shell`"));
        assertTrue(context.contains("## Referenced Files"));
        assertTrue(context.contains(referencedFile.getAbsolutePath()));
        assertTrue(context.contains("## IDE Context"));
        assertTrue(context.contains(activeFile.getAbsolutePath() + "#L3-5"));

        // Content injection was removed: file contents and selected code must
        // never be inlined into the prompt (Windows argv length limit, token cost).
        assertFalse(context.contains("class ReferencedExample {}"));
        assertFalse(context.contains("class ActiveExample {}"));
        assertFalse(context.contains("logger.info(\"hello\");"));
    }

    @Test
    public void buildCodexContextAppendReferencesActiveFileWithoutContent() throws Exception {
        File activeFile = temporaryFolder.newFile("ActiveExample.java");
        Files.writeString(activeFile.toPath(), "class ActiveExample {}", StandardCharsets.UTF_8);

        JsonObject openedFilesJson = new JsonObject();
        openedFilesJson.addProperty("active", activeFile.getAbsolutePath());

        SessionContextService service = new SessionContextService(null);

        String context = service.buildCodexContextAppend(openedFilesJson, null);

        assertTrue(context.contains("## User's Current IDE Context"));
        assertTrue(context.contains(activeFile.getAbsolutePath()));
        assertFalse(context.contains("class ActiveExample {}"));
    }
}
