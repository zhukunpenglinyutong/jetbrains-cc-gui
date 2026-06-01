package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeCliAttachmentPromptTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void rendersImageAttachmentWithReadToolInstructionAndAllowedDirectory() throws IOException {
        ClaudeSession.Attachment attachment =
                new ClaudeSession.Attachment("screen.png", "image/png", null);
        File storeDir = folder.newFolder("attachments", "store");
        File image = new File(storeDir, "abc123.png");
        assertTrue(image.createNewFile());
        String promptPath = promptPath(image);

        ClaudeCliAttachmentPrompt.Rendered rendered = ClaudeCliAttachmentPrompt.render(
                "look at this",
                List.of(new ClaudeCliAttachmentPrompt.ResolvedAttachment(1, attachment, image))
        );

        assertTrue(rendered.prompt().contains("[Image #1: " + promptPath + "]"));
        assertTrue(rendered.prompt().contains("Use the Read tool to inspect this image file, then answer using its visible content: " + promptPath));
        assertFalse(rendered.prompt().contains("Referenced image:"));
        assertEquals(List.of(storeDir.getAbsolutePath()), rendered.addDirs());
    }

    @Test
    public void rendersNonImageAttachmentAsReadableFilePath() throws IOException {
        ClaudeSession.Attachment attachment =
                new ClaudeSession.Attachment("notes.txt", "text/plain", null);
        File storeDir = folder.newFolder("text-attachments", "store");
        File textFile = new File(storeDir, "notes.txt");
        assertTrue(textFile.createNewFile());

        ClaudeCliAttachmentPrompt.Rendered rendered = ClaudeCliAttachmentPrompt.render(
                "read it",
                List.of(new ClaudeCliAttachmentPrompt.ResolvedAttachment(1, attachment, textFile))
        );

        assertTrue(rendered.prompt().contains("[Attached file: notes.txt]"));
        assertTrue(rendered.prompt().contains("Please use the Read tool to read the file at:"));
        assertTrue(rendered.prompt().contains(promptPath(textFile)));
    }

    private static String promptPath(File file) {
        return file.getAbsolutePath().replace('\\', '/');
    }
}
