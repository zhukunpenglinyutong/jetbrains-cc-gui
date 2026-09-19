package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * The identity rules here are what let the coalescer and the history loader agree
 * about which blocks are structural. A silent change to either side turns into a
 * dropped guard, so the rules are pinned directly.
 */
public class MessageStructureTest {

    @Test
    public void recognisesExactlyTheMirroredSetOfBlockTypes() {
        // The frontend keeps its own copy of these rules in messageSync.ts and
        // cannot share this code. This list is the contract between them: adding a
        // block type on one side alone fails here (or in the TS counterpart test),
        // which is the only warning available before the two silently disagree
        // about which blocks are structural.
        assertEquals(List.of("tool_use", "tool_result", "attachment", "image"),
                MessageStructure.STRUCTURAL_BLOCK_TYPES);
        for (String type : MessageStructure.STRUCTURAL_BLOCK_TYPES) {
            String key = MessageStructure.structuralBlockKey(
                    block("type", type, "id", "probe", "tool_use_id", "probe",
                            "fileName", "probe", "src", "probe"));
            assertTrue("every advertised type must actually produce a key: " + type,
                    key != null && key.startsWith(type + ':'));
        }
    }

    @Test
    public void keysEachStructuralBlockByItsIdentity() {
        assertEquals("tool_use:tool-1", MessageStructure.structuralBlockKey(block(
                "type", "tool_use", "id", "tool-1", "name", "Bash")));
        assertEquals("tool_result:tool-1", MessageStructure.structuralBlockKey(block(
                "type", "tool_result", "tool_use_id", "tool-1")));
        assertEquals("attachment:notes.txt", MessageStructure.structuralBlockKey(block(
                "type", "attachment", "fileName", "notes.txt")));
    }

    @Test
    public void distinguishesImagesWithEqualLengthAndTheSameHeader() {
        String payload = "data:image/png;base64," + "A".repeat(50_000);
        String key = MessageStructure.structuralBlockKey(block("type", "image", "src", payload));

        assertEquals("image:" + payload, key);
        String other = payload.substring(0, payload.length() - 1) + "B";
        assertTrue(!key.equals(MessageStructure.structuralBlockKey(block("type", "image", "src", other))));
    }

    @Test
    public void rejectsNonStringAndEmptyIdentitiesLikeTheTsMirror() {
        // Pinned against messageSync.ts's structuralBlockKey (`typeof === 'string'`
        // plus truthiness): both sides must reject these the same way, or the
        // history guard here and the finalize merge there disagree about the block.
        assertNull("an empty image src yields no key",
                MessageStructure.structuralBlockKey(block("type", "image", "src", "")));

        JsonObject numericId = new JsonObject();
        numericId.addProperty("type", "tool_use");
        numericId.addProperty("id", 123);
        assertNull("a numeric id is not an identity",
                MessageStructure.structuralBlockKey(numericId));

        JsonObject nonStringType = new JsonObject();
        nonStringType.addProperty("type", 42);
        nonStringType.addProperty("id", "probe");
        assertNull("a non-string type must yield no key, not throw",
                MessageStructure.structuralBlockKey(nonStringType));
    }

    @Test
    public void ignoresBlocksWithoutIdentityOrStructure() {
        assertNull(MessageStructure.structuralBlockKey(block("type", "text", "text", "hello")));
        assertNull(MessageStructure.structuralBlockKey(block("type", "thinking", "thinking", "hmm")));
        assertNull("a tool_use without an id cannot be matched", MessageStructure.structuralBlockKey(
                block("type", "tool_use", "name", "Bash")));
        assertNull(MessageStructure.structuralBlockKey(null));
    }

    @Test
    public void findsContentUnderBothRawShapes() {
        JsonObject nested = new JsonObject();
        JsonObject message = new JsonObject();
        JsonArray nestedContent = new JsonArray();
        nestedContent.add(block("type", "text", "text", "nested"));
        message.add("content", nestedContent);
        nested.add("message", message);
        assertEquals(1, MessageStructure.findContentArray(nested).size());

        JsonObject flat = new JsonObject();
        JsonArray flatContent = new JsonArray();
        flatContent.add(block("type", "text", "text", "flat"));
        flat.add("content", flatContent);
        assertEquals(1, MessageStructure.findContentArray(flat).size());

        assertNull(MessageStructure.findContentArray(new JsonObject()));
    }

    @Test
    public void tracksEachBlockIdentityOnceRegardlessOfPayloadSize() {
        JsonObject small = block("type", "tool_use", "id", "tool-1", "input", "x");
        JsonObject large = block("type", "tool_use", "id", "tool-1", "input", "x".repeat(500));
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(messageWithBlocks(small));
        messages.add(messageWithBlocks(large, block("type", "tool_result", "tool_use_id", "tool-1")));

        Set<String> keys = MessageStructure.structuralBlockKeys(messages);

        assertEquals(2, keys.size());
        assertEquals(Set.of("tool_use:tool-1", "tool_result:tool-1"), keys);
    }

    @Test
    public void includesImageIdentityWithoutSerializingTheBlock() {
        String payload = "data:image/png;base64," + "A".repeat(50_000);
        List<ClaudeSession.Message> messages = List.of(
                messageWithBlocks(block("type", "image", "src", payload)));

        Set<String> keys = MessageStructure.structuralBlockKeys(messages);

        assertEquals(1, keys.size());
        assertEquals(MessageStructure.structuralBlockKey(block("type", "image", "src", payload)), keys.iterator().next());
    }

    private static ClaudeSession.Message messageWithBlocks(JsonObject... blocks) {
        JsonArray content = new JsonArray();
        for (JsonObject block : blocks) {
            content.add(block);
        }
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.add("message", message);
        return new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "", raw);
    }

    private static JsonObject block(String... keyValues) {
        JsonObject block = new JsonObject();
        for (int i = 0; i < keyValues.length; i += 2) {
            block.addProperty(keyValues[i], keyValues[i + 1]);
        }
        return block;
    }
}
