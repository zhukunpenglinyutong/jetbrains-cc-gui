package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;
import org.junit.Test;

import java.io.File;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeCliAttachmentPromptTest {

    @Test
    public void rendersImageAttachmentAsReferencedImageWithAllowedDirectory() {
        ClaudeSession.Attachment attachment =
                new ClaudeSession.Attachment("screen.png", "image/png", null);
        File image = new File("C:\\Users\\32979\\.codemoss\\attachments\\store\\abc123.png");

        ClaudeCliAttachmentPrompt.Rendered rendered = ClaudeCliAttachmentPrompt.render(
                "look at this",
                List.of(new ClaudeCliAttachmentPrompt.ResolvedAttachment(1, attachment, image))
        );

        assertTrue(rendered.prompt().contains("Referenced image: "));
        assertTrue(rendered.prompt().contains("C:/Users/32979/.codemoss/attachments/store/abc123.png"));
        assertFalse(rendered.prompt().contains("Please use the Read tool to view"));
        assertEquals(List.of(new File("C:\\Users\\32979\\.codemoss\\attachments\\store").getAbsolutePath()), rendered.addDirs());
    }

    @Test
    public void rendersNonImageAttachmentAsReadableFilePath() {
        ClaudeSession.Attachment attachment =
                new ClaudeSession.Attachment("notes.txt", "text/plain", null);
        File textFile = new File("C:\\Users\\32979\\.codemoss\\attachments\\store\\notes.txt");

        ClaudeCliAttachmentPrompt.Rendered rendered = ClaudeCliAttachmentPrompt.render(
                "read it",
                List.of(new ClaudeCliAttachmentPrompt.ResolvedAttachment(1, attachment, textFile))
        );

        assertTrue(rendered.prompt().contains("[Attached file: notes.txt]"));
        assertTrue(rendered.prompt().contains("Please use the Read tool to read the file at:"));
    }
}
