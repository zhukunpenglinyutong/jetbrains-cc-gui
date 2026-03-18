package com.github.claudecodegui.session;

import com.github.claudecodegui.ClaudeSession;
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
import static org.junit.Assert.assertTrue;

public class SessionContextServiceTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void buildUserMessageIncludesImageBlockAndTextContent() {
        SessionContextService service = new SessionContextService(null, 1024);
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

    @Test
    public void buildCodexContextAppendIncludesReferencedFilesAndSelectionContext() throws Exception {
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

        SessionContextService service = new SessionContextService(null, 1024);

        String context = service.buildCodexContextAppend(
                openedFilesJson,
                List.of(referencedFile.getAbsolutePath(), "terminal://backend-shell")
        );

        assertTrue(context.contains("## Active Terminal Session"));
        assertTrue(context.contains("`backend-shell`"));
        assertTrue(context.contains("## Referenced Files"));
        assertTrue(context.contains(referencedFile.getAbsolutePath()));
        assertTrue(context.contains("class ReferencedExample {}"));
        assertTrue(context.contains("## IDE Context"));
        assertTrue(context.contains(activeFile.getAbsolutePath() + "#L3-5"));
        assertTrue(context.contains("logger.info(\"hello\");"));
    }
}
