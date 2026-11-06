package com.github.claudecodegui.session;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Receipt mapping for a steer request.
 *
 * <p>The case that matters: the host gives up after 10s but does NOT cancel the
 * daemon request, so reporting a reject would put the row back in the queue
 * while the message is still on its way and the prompt would run twice.
 */
public class SteerReceiptMapperTest {

    private static JsonObject delivered(boolean value) {
        JsonObject result = new JsonObject();
        result.addProperty("delivered", value);
        return result;
    }

    @Test
    public void deliveredBecomesAccepted() {
        SteerReceiptMapper.Outcome outcome = SteerReceiptMapper.fromDaemonResult(delivered(true));

        assertEquals("accepted", outcome.getStatus());
        assertNull(outcome.getReason());
        assertFalse(outcome.isUnconfirmed());
    }

    @Test
    public void timedOutDaemonCallBecomesAcceptedAndUnconfirmed() {
        JsonObject result = delivered(false);
        result.addProperty("reason", "timeout");
        result.addProperty("unconfirmed", true);

        SteerReceiptMapper.Outcome outcome = SteerReceiptMapper.fromDaemonResult(result);

        // A timeout is not terminal: the daemon may still enqueue the steer.
        assertEquals("accepted", outcome.getStatus());
        assertTrue(outcome.isUnconfirmed());
        assertNull(outcome.getReason());
    }

    @Test
    public void aLateFoldAfterTheTimeoutStillSettlesTheSteer() {
        // What the webview does with the mapped receipt: it keeps the row hidden
        // and the bubble pending, so the fold that follows has something to
        // settle instead of having already requeued the message.
        JsonObject timeout = delivered(false);
        timeout.addProperty("reason", "timeout");
        timeout.addProperty("unconfirmed", true);

        assertEquals("accepted", SteerReceiptMapper.fromDaemonResult(timeout).getStatus());
    }

    @Test
    public void rejectKeepsTheDaemonReason() {
        JsonObject result = delivered(false);
        result.addProperty("reason", "no_active_turn");

        SteerReceiptMapper.Outcome outcome = SteerReceiptMapper.fromDaemonResult(result);

        assertEquals("rejected", outcome.getStatus());
        assertEquals("no_active_turn", outcome.getReason());
        assertFalse(outcome.isUnconfirmed());
    }

    @Test
    public void missingReasonFallsBackToNoActiveTurn() {
        SteerReceiptMapper.Outcome outcome = SteerReceiptMapper.fromDaemonResult(delivered(false));

        assertEquals("rejected", outcome.getStatus());
        assertEquals("no_active_turn", outcome.getReason());
    }

    @Test
    public void emptyReasonFallsBackToNoActiveTurn() {
        JsonObject result = delivered(false);
        result.addProperty("reason", "");

        assertEquals("no_active_turn", SteerReceiptMapper.fromDaemonResult(result).getReason());
    }

    @Test
    public void nullResultIsRejectedNotCrashed() {
        SteerReceiptMapper.Outcome outcome = SteerReceiptMapper.fromDaemonResult(null);

        assertEquals("rejected", outcome.getStatus());
        assertEquals("no_active_turn", outcome.getReason());
    }
}
