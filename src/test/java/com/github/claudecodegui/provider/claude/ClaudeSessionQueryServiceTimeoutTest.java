package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.testing.TrackingProcessManager;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for the {@link ClaudeSessionQueryService#runSessionQuery}
 * timeout: stdout used to be drained to EOF before the timeout was checked, so a
 * hung bridge holding the pipe open blocked history loading forever. The large
 * payload case guards the other direction: moving the read off-thread must not
 * hand back a getSession payload cut short.
 */
public class ClaudeSessionQueryServiceTimeoutTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private static final int TEST_TIMEOUT_SECONDS = 2;
    // Generous on purpose: Windows CI terminates the child with taskkill /T.
    private static final long DEADLINE_SLACK_MILLIS = 8_000;
    private static final int MESSAGE_COUNT = 40;
    private static final int MESSAGE_CHARS = 100_000;

    private TrackingProcessManager processManager;
    private File workDir;
    private NodeDetector node;

    @Before
    public void setUp() throws Exception {
        processManager = new TrackingProcessManager();
        workDir = temporaryFolder.newFolder("bridge");
        NodeDetector.resetInstance();
        node = NodeDetector.getInstance();
        Field cache = NodeDetector.class.getDeclaredField("cachedNodeExecutable");
        cache.setAccessible(true);
        cache.set(node, "node");
    }

    @After
    public void tearDown() {
        NodeDetector.resetInstance();
    }

    @Test(timeout = 30_000)
    public void hungQueryTimesOutInsteadOfBlockingForever() throws Exception {
        writeChannelManager("setTimeout(() => {}, 60000);\n");
        ClaudeSessionQueryService service = newService(TEST_TIMEOUT_SECONDS);

        long start = System.currentTimeMillis();
        RuntimeException e = assertThrows(RuntimeException.class,
                () -> service.getSessionMessages("session-1", workDir.getAbsolutePath()));
        long elapsed = System.currentTimeMillis() - start;

        assertTrue("expected a timeout error, got: " + e.getMessage(),
                e.getMessage().contains("timed out"));
        assertTrue("timeout should fire promptly (took " + elapsed + " ms)",
                elapsed < TEST_TIMEOUT_SECONDS * 1000 + DEADLINE_SLACK_MILLIS);
        assertEquals(1, processManager.registerCalls.get());
        assertEquals(1, processManager.unregisterCalls.get());
        assertEquals(0, processManager.getActiveProcessCount());
        assertFalse("child must not outlive the call",
                processManager.registeredProcess.get().isAlive());
    }

    @Test(timeout = 60_000)
    public void multiMegabyteSessionIsReturnedComplete() throws Exception {
        writeChannelManager(
                "const text = 'x'.repeat(" + MESSAGE_CHARS + ");\n"
                        + "const messages = [];\n"
                        + "for (let i = 0; i < " + MESSAGE_COUNT + "; i++) {\n"
                        + "  messages.push({ type: 'assistant', uuid: 'm' + i,"
                        + " message: { content: [{ type: 'text', text }] } });\n"
                        + "}\n"
                        + "console.log(JSON.stringify({ success: true, messages }));\n");

        List<JsonObject> messages = newService(20)
                .getSessionMessages("session-1", workDir.getAbsolutePath());

        assertEquals(MESSAGE_COUNT, messages.size());
        JsonObject last = messages.get(MESSAGE_COUNT - 1);
        assertEquals("m" + (MESSAGE_COUNT - 1), last.get("uuid").getAsString());
        String lastText = last.getAsJsonObject("message").getAsJsonArray("content")
                .get(0).getAsJsonObject().get("text").getAsString();
        assertEquals(MESSAGE_CHARS, lastText.length());
        assertEquals(0, processManager.getActiveProcessCount());
    }

    private ClaudeSessionQueryService newService(int timeoutSeconds) {
        return new ClaudeSessionQueryService(
                Logger.getInstance(ClaudeSessionQueryServiceTimeoutTest.class),
                new Gson(),
                node,
                () -> workDir,
                processManager,
                new EnvironmentConfigurator(),
                new ClaudeJsonOutputExtractor(),
                timeoutSeconds
        );
    }

    private void writeChannelManager(String script) throws Exception {
        Files.writeString(new File(workDir, "channel-manager.js").toPath(), script, StandardCharsets.UTF_8);
    }
}
