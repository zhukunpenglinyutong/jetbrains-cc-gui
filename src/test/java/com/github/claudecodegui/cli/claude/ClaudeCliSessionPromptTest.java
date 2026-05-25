package com.github.claudecodegui.cli.claude;

import com.github.claudecodegui.cli.CliSendRequest;
import com.github.claudecodegui.cli.common.CliAttachmentHandler;
import org.junit.Test;

import java.io.File;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeCliSessionPromptTest {

    @Test
    public void rendersImageAttachmentWithReadToolInstruction() throws Exception {
        ClaudeCliSession session = new ClaudeCliSession("tab-claude-prompt");
        CliSendRequest request = new CliSendRequest("tab-claude-prompt", "claude", "describe this image", null, null, List.of(), null, List.of(), null, null, null, null, Map.of());
        File image = new File("C:\\Users\\32979\\.codemoss\\attachments\\store\\abc123.png");
        List<CliAttachmentHandler.ContentBlock> blocks = List.of(new CliAttachmentHandler.ContentBlock(CliAttachmentHandler.ContentBlock.Kind.IMAGE, "image/png", image, null));

        Method method = ClaudeCliSession.class.getDeclaredMethod("buildPrompt", CliSendRequest.class, List.class);
        method.setAccessible(true);
        String prompt = (String) method.invoke(session, request, blocks);

        assertTrue(prompt.contains("[Image #1: C:/Users/32979/.codemoss/attachments/store/abc123.png]"));
        assertTrue(prompt.contains("Use the Read tool to inspect this image file, then answer using its visible content: " + "C:/Users/32979/.codemoss/attachments/store/abc123.png"));
        assertFalse(prompt.contains("Referenced image:"));
    }

    @Test
    public void buildsCommandWithoutPromptArgumentSoPromptCanBeWrittenToStdin() throws Exception {
        ClaudeCliSession session = new ClaudeCliSession("tab-claude-command");
        CliSendRequest request = new CliSendRequest("tab-claude-command", "claude", "first line\nsecond line", null, null, List.of(), null, List.of(), null, "default", "sonnet", "high", Map.of());

        Method method = ClaudeCliSession.class.getDeclaredMethod("buildCommand", String.class, CliSendRequest.class, String.class, List.class);
        method.setAccessible(true);
        @SuppressWarnings("unchecked") List<String> command = (List<String>) method.invoke(session, "claude", request, "first line\nsecond line", List.of("C:\\Users\\32979\\.codemoss\\attachments\\store"));

        assertFalse(command.contains("--"));
        assertFalse(command.contains("first line\nsecond line"));
        assertEquals("claude", command.get(0));
        assertTrue(command.contains("-p"));
        assertTrue(command.contains("--add-dir"));
    }
}
