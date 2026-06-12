package com.github.claudecodegui.handler.history;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression coverage for the per-row entrypoint rewrite that powers SDK-to-CLI session
 * conversion. The wider service does file I/O, but the rewrite decision is pure and is
 * where the convertible-vs-keep semantics live, so it is tested directly.
 */
public class SessionConversionServiceTest {

    // convertEntrypointInLine only touches the instance Gson, so a null context is fine.
    private final SessionConversionService service = new SessionConversionService(null);

    @Test
    public void rewritesSdkCliEntrypointToCli() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);

        String out = service.convertEntrypointInLine(
                "{\"entrypoint\":\"sdk-cli\",\"x\":1}", hasCli, modified);

        assertTrue(out.contains("\"entrypoint\":\"cli\""));
        assertEquals(1, modified.get());
        assertFalse(hasCli.get());
    }

    @Test
    public void rewritesClaudeVscodeEntrypointToCli() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);

        String out = service.convertEntrypointInLine(
                "{\"entrypoint\":\"claude-vscode\"}", hasCli, modified);

        assertTrue(out.contains("\"entrypoint\":\"cli\""));
        assertEquals(1, modified.get());
    }

    @Test
    public void leavesExistingCliSessionUnchangedAndFlagsIt() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "{\"entrypoint\":\"cli\"}";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
        assertTrue("an existing cli row must flag the session as already-CLI", hasCli.get());
    }

    @Test
    public void leavesNonConvertibleKnownEntrypointUnchanged() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "{\"entrypoint\":\"remote\"}";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
        assertFalse(hasCli.get());
    }

    @Test
    public void leavesRowWithoutEntrypointUnchanged() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "{\"type\":\"user\"}";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
    }

    @Test
    public void keepsNonJsonRowUnchanged() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "this is not json";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
    }
}
