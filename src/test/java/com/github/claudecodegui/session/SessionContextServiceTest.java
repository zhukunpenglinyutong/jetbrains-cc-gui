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
import java.util.function.UnaryOperator;

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
        String firstTurn = contextValue(service.buildCodexAdditionalContext(openedFiles, List.of("src/Other.java"), UnaryOperator.identity()));
        String nextTurn = contextValue(service.buildCodexAdditionalContext(openedFiles, List.of("src/Next.java"), UnaryOperator.identity()));
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

    /** Keeps referenced files and selection positions out of the user text. */
    @Test
    public void codexContextReferencesPathsWithoutInliningContent() throws Exception {
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

        JsonObject fragments = service.buildCodexAdditionalContext(
                openedFilesJson,
                List.of(referencedFile.getAbsolutePath(), "terminal://backend-shell"),
                UnaryOperator.identity()
        );
        String context = contextValue(fragments);
        assertEquals("application", fragments.getAsJsonObject("ide_context").get("kind").getAsString());
        assertFalse(context.contains("primary subject"));

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

    /** Treats the active file as editor state rather than assuming the user's intent. */
    @Test
    public void codexContextReferencesActiveFileWithoutContent() throws Exception {
        File activeFile = temporaryFolder.newFile("ActiveExample.java");
        Files.writeString(activeFile.toPath(), "class ActiveExample {}", StandardCharsets.UTF_8);

        JsonObject openedFilesJson = new JsonObject();
        openedFilesJson.addProperty("active", activeFile.getAbsolutePath());

        SessionContextService service = new SessionContextService(null);

        JsonArray others = new JsonArray();
        others.add("src/Another.java");
        openedFilesJson.add("others", others);
        String context = contextValue(service.buildCodexAdditionalContext(openedFilesJson, null, UnaryOperator.identity()));

        assertTrue(context.contains("## User's Current IDE Context"));
        assertTrue(context.contains(activeFile.getAbsolutePath()));
        assertTrue(context.contains("src/Another.java"));
        assertFalse(context.contains("PRIMARY SUBJECT"));
        assertFalse(context.contains("class ActiveExample {}"));
    }

    /** Avoids inventing an editor context when automatic collection is disabled. */
    @Test
    public void emptyEditorStateProducesNoFragments() {
        assertTrue(new SessionContextService(null).buildCodexAdditionalContext(new JsonObject(), null, UnaryOperator.identity()).isEmpty());
    }

    /** Keeps long tab lists and file references from consuming the active selection's native budget. */
    @Test
    public void editorAndExplicitReferencesReceiveIndependentContextBudgets() {
        JsonObject openedFiles = new JsonObject();
        openedFiles.addProperty("active", "src/Active.java");
        JsonArray tabs = new JsonArray();
        List<String> references = new java.util.ArrayList<>();
        for (int index = 0; index < 40; index++) {
            String path = "src/" + "long_directory_name/".repeat(12) + "File" + index + ".java";
            tabs.add(path);
            references.add(path);
        }
        openedFiles.add("others", tabs);
        SessionContextService service = new SessionContextService(null);
        JsonObject fragments = service.buildCodexAdditionalContext(openedFiles, references, UnaryOperator.identity());
        String active = fragments.getAsJsonObject("ide_context").get("value").getAsString();
        assertTrue(active.contains("src/Active.java"));
        assertFalse(active.contains("long_directory_name"));
        for (int index = 0; index < references.size(); index++) {
            String reference = fragments.getAsJsonObject("referenced_files_" + index).get("value").getAsString();
            assertTrue(reference.contains(references.get(index)));
            assertFalse(reference.contains("src/Active.java"));
            assertTrue(reference.length() < 500);
        }
        String openTabs = fragments.getAsJsonObject("open_tabs").get("value").getAsString();
        assertTrue(openTabs.contains("File19.java"));
        assertFalse(openTabs.contains("File20.java"));
    }

    /** Codex runs where node runs, so inside WSL it can only open Linux paths. */
    @Test
    public void codexContextUsesPathsTheNodeRuntimeCanOpen() {
        JsonObject openedFiles = com.google.gson.JsonParser.parseString("""
                {"active":"//wsl.localhost/Ubuntu/home/u/p/A.java",
                 "others":["//wsl.localhost/Ubuntu/home/u/p/B.java"],
                 "isWorkspace":true,
                 "subprojects":[{"name":"sub","path":"//wsl.localhost/Ubuntu/home/u/p/sub"}]}
                """).getAsJsonObject();
        String original = openedFiles.toString();

        String context = contextValue(new SessionContextService(null).buildCodexAdditionalContext(
                openedFiles,
                List.of("//wsl.localhost/Ubuntu/home/u/p/C.java", "terminal://shell"),
                path -> path.replace("//wsl.localhost/Ubuntu", "/linux")));

        assertFalse(context, context.contains("wsl.localhost"));
        for (String file : List.of("A.java", "B.java", "C.java", "sub")) {
            assertTrue(file + " in " + context, context.contains("/linux/home/u/p/" + file));
        }
        assertTrue("terminal references are not paths", context.contains("Active Terminal Session"));
        assertEquals("the caller's context must stay untouched", original, openedFiles.toString());
    }

    private static String contextValue(JsonObject fragments) {
        return String.join("\n\n", fragments.entrySet().stream()
                .map(entry -> entry.getValue().getAsJsonObject().get("value").getAsString()).toList());
    }
}
