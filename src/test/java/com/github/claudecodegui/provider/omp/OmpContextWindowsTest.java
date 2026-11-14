package com.github.claudecodegui.provider.omp;

import com.github.claudecodegui.handler.provider.ModelProviderHandler;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/** The selector -> context window registry filled from the omp model list. */
public class OmpContextWindowsTest {

    private static JsonObject payload(String json) {
        return JsonParser.parseString(json.replace('\'', '"')).getAsJsonObject();
    }

    @Before
    public void setUp() {
        OmpContextWindows.reset();
    }

    @After
    public void tearDown() {
        OmpContextWindows.reset();
    }

    @Test
    public void updateKeepsOnlyModelsWithAPositiveWindow() {
        OmpContextWindows.update(payload("{'success':true,'models':["
                + "{'id':'anthropic/a','contextWindow':200000},"
                + "{'id':'anthropic/zero','contextWindow':0},"
                + "{'id':'anthropic/negative','contextWindow':-1},"
                + "{'id':'anthropic/text','contextWindow':'9'},"
                + "{'id':'anthropic/none'}]}"));
        assertEquals(Integer.valueOf(200_000), OmpContextWindows.resolve("anthropic/a"));
        assertNull(OmpContextWindows.resolve("anthropic/zero"));
        assertNull(OmpContextWindows.resolve("anthropic/negative"));
        assertNull(OmpContextWindows.resolve("anthropic/text"));
        assertNull(OmpContextWindows.resolve("anthropic/none"));
        assertNull(OmpContextWindows.resolve(null));
    }

    @Test
    public void unusablePayloadsKeepThePreviousRegistry() {
        OmpContextWindows.update(payload("{'models':[{'id':'a/m','contextWindow':1000}]}"));
        OmpContextWindows.update(payload("{'success':false,'error':'omp not found','models':[]}"));
        OmpContextWindows.update(payload("{'success':false,'models':[{'id':'a/m','contextWindow':5}]}"));
        OmpContextWindows.update(payload("{'success':true,'models':[{'id':'auto','label':'OMP Auto'}]}"));
        OmpContextWindows.update(payload("{'success':true}"));
        OmpContextWindows.update(null);
        assertEquals(Integer.valueOf(1000), OmpContextWindows.resolve("a/m"));
    }

    @Test
    public void aGoodPayloadReplacesTheRegistry() {
        OmpContextWindows.update(payload("{'models':[{'id':'a/old','contextWindow':1000}]}"));
        OmpContextWindows.update(payload("{'models':[{'id':'a/new','contextWindow':2000}]}"));
        assertNull(OmpContextWindows.resolve("a/old"));
        assertEquals(Integer.valueOf(2000), OmpContextWindows.resolve("a/new"));
    }

    @Test
    public void ompContextLimitComesFromTheRegistry() {
        OmpContextWindows.update(payload("{'models':[{'id':'anthropic/claude-opus-5-5','contextWindow':777000}]}"));
        assertEquals(777_000, ModelProviderHandler.getModelContextLimit("omp", "anthropic/claude-opus-5-5"));
    }
}
