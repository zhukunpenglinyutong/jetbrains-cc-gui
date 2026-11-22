package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class TurnUsageAccumulatorTest {

    private static JsonObject usage(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    @Test
    public void sumsTokenFieldsAcrossSteps() {
        TurnUsageAccumulator turn = new TurnUsageAccumulator();
        turn.add(usage("{\"input_tokens\":8725,\"output_tokens\":23,\"cache_read_input_tokens\":0,\"total_tokens\":8759}"));
        turn.add(usage("{\"input_tokens\":6723,\"output_tokens\":8,\"cache_read_input_tokens\":2048,\"total_tokens\":8794,"
                + "\"model_context_window\":32768}"));

        JsonObject total = turn.snapshot();
        assertEquals(15448, total.get("input_tokens").getAsLong());
        assertEquals(31, total.get("output_tokens").getAsLong());
        assertEquals(2048, total.get("cache_read_input_tokens").getAsLong());
        assertEquals(17553, total.get("total_tokens").getAsLong());
        assertFalse("context windows are not summed", total.has("model_context_window"));
    }

    @Test
    public void reportedCostWinsAndZeroMeansNoCost() {
        TurnUsageAccumulator paid = new TurnUsageAccumulator();
        paid.add(usage("{\"input_tokens\":1000,\"output_tokens\":10,\"cost_usd\":0.5}"));
        paid.add(usage("{\"input_tokens\":1000,\"output_tokens\":10,\"cost_usd\":0.25}"));
        assertEquals(0.75, paid.turnCostUsd("opencode", "anthropic/claude-sonnet-4-5"), 1e-9);

        TurnUsageAccumulator subscription = new TurnUsageAccumulator();
        subscription.add(usage("{\"input_tokens\":100000,\"output_tokens\":5000,\"cost_usd\":0}"));
        assertNull("a reported zero is not replaced by list price",
                subscription.turnCostUsd("opencode", "github-copilot/claude-sonnet-4-5"));
    }

    @Test
    public void estimatesCostWhenNoStepReportedOne() {
        TurnUsageAccumulator turn = new TurnUsageAccumulator();
        turn.add(usage("{\"input_tokens\":100000,\"output_tokens\":5000}"));

        assertNotNull(turn.turnCostUsd("opencode", "anthropic/claude-sonnet-4-5"));
    }

    @Test
    public void resetStartsAnEmptyTurn() {
        TurnUsageAccumulator turn = new TurnUsageAccumulator();
        turn.add(usage("{\"input_tokens\":1,\"cost_usd\":1.0}"));
        turn.reset();

        assertTrue(turn.isEmpty());
        assertNull(turn.turnCostUsd("opencode", "anthropic/claude-sonnet-4-5"));
    }
}
