package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.function.ThrowingRunnable;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for {@code InputHistoryHandler#executeNodeScript}: stdout used
 * to be drained to EOF before the timeout was checked, and stdin was written
 * synchronously before that. A hung child holding stdout open, or one that never
 * read a stdin payload larger than the pipe buffer, blocked the caller forever.
 */
public class InputHistoryHandlerTimeoutTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private static final long TEST_TIMEOUT_SECONDS = 2;
    // Generous on purpose: Windows CI terminates the child with taskkill /T.
    private static final long DEADLINE_SLACK_MILLIS = 8_000;
    private static final int FRAGMENT_COUNT = 20_000;

    // Parks the child synchronously at require() time: it prints nothing,
    // never reads stdin and burns no CPU while it holds both pipes open.
    private static final String HUNG_SERVICE =
            "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\n"
                    + "module.exports = { getAllHistoryData: () => ({}), recordHistory: () => ({}) };\n";

    private TestClaudeSDKBridge bridge;
    private HandlerContext context;
    private Path servicesDir;

    @Before
    public void setUp() throws Exception {
        Path bridgeDir = temporaryFolder.newFolder("bridge").toPath();
        servicesDir = Files.createDirectories(bridgeDir.resolve("services"));
        bridge = new TestClaudeSDKBridge(bridgeDir.toFile());
        context = new HandlerContext(null, bridge, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    @Test(timeout = 30_000)
    public void hungChildTimesOutInsteadOfBlockingForever() throws Exception {
        writeService(HUNG_SERVICE);
        InputHistoryHandler handler = new InputHistoryHandler(context, TEST_TIMEOUT_SECONDS);

        assertTimesOutPromptly(() -> handler.callInputHistoryService("getAllHistoryData", null));
    }

    @Test(timeout = 30_000)
    public void hungChildThatNeverReadsLargeStdinTimesOut() throws Exception {
        writeService(HUNG_SERVICE);
        String payload = largeJsonArray();
        assertTrue("payload must exceed any OS pipe buffer", payload.length() > 1024 * 1024);
        InputHistoryHandler handler = new InputHistoryHandler(context, TEST_TIMEOUT_SECONDS);

        assertTimesOutPromptly(() -> handler.callInputHistoryServiceWithArray("recordHistory", payload));
    }

    @Test(timeout = 30_000)
    public void largeStdinPayloadReachesTheService() throws Exception {
        writeService("module.exports = {"
                + " recordHistory: data => ({ count: data.length, last: data[data.length - 1] })"
                + " };\n");

        String result = new InputHistoryHandler(context, 20)
                .callInputHistoryServiceWithArray("recordHistory", largeJsonArray());

        JsonObject json = JsonParser.parseString(result).getAsJsonObject();
        assertEquals(FRAGMENT_COUNT, json.get("count").getAsInt());
        assertEquals(fragment(FRAGMENT_COUNT - 1), json.get("last").getAsString());
        assertEquals(0, bridge.getProcessManager().getActiveProcessCount());
    }

    private void assertTimesOutPromptly(ThrowingRunnable call) {
        long start = System.currentTimeMillis();
        Exception e = assertThrows(Exception.class, call);
        long elapsed = System.currentTimeMillis() - start;

        assertTrue("expected a timeout error, got: " + e.getMessage(),
                e.getMessage().contains("timed out"));
        assertTrue("timeout should fire promptly (took " + elapsed + " ms)",
                elapsed < TEST_TIMEOUT_SECONDS * 1000 + DEADLINE_SLACK_MILLIS);
        assertEquals("child should be unregistered after the timeout",
                0, bridge.getProcessManager().getActiveProcessCount());
    }

    private void writeService(String content) throws Exception {
        Files.writeString(servicesDir.resolve("input-history-service.cjs"), content, StandardCharsets.UTF_8);
    }

    private static String largeJsonArray() {
        JsonArray fragments = new JsonArray();
        for (int i = 0; i < FRAGMENT_COUNT; i++) {
            fragments.add(fragment(i));
        }
        return fragments.toString();
    }

    private static String fragment(int index) {
        return "history-fragment-" + index + "-" + "x".repeat(48);
    }

    private static final class TestClaudeSDKBridge extends ClaudeSDKBridge {
        private final File sdkDir;
        private final ProcessManager processManager = new ProcessManager();

        private TestClaudeSDKBridge(File sdkDir) {
            this.sdkDir = sdkDir;
        }

        @Override
        public File getSdkTestDir() {
            return sdkDir;
        }

        @Override
        public String getNodeExecutable() {
            return "node";
        }

        @Override
        public ProcessManager getProcessManager() {
            return processManager;
        }
    }
}
