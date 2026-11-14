package com.github.claudecodegui.voice;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class VoiceInputConfigTest {

    private static VoiceInputConfig parse(String json) {
        return VoiceInputConfig.from(JsonParser.parseString(json).getAsJsonObject());
    }

    @Test
    public void shipsNoDefaultEndpointOrModel() {
        VoiceInputConfig config = VoiceInputConfig.from(new JsonObject());

        assertEquals("", config.baseUrl());
        assertEquals("", config.model());
        assertEquals("", config.apiKey());
        assertFalse(config.hasApiKey());
        assertTrue(config.liveTranscription());
        assertEquals(List.of(), config.fillerWords());
        assertEquals(VoiceInputConfig.Problem.MISSING_ENDPOINT, config.problem());
        assertEquals(VoiceInputConfig.Problem.MISSING_ENDPOINT, VoiceInputConfig.from(null).problem());
    }

    @Test
    public void readsConfiguredValues() {
        VoiceInputConfig config = parse("""
                {"voiceInput": {"baseUrl": "https://stt.example.com/v1//", "apiKey": " sk-cfg ",
                 "model": "whisper-large-v3", "language": "uk", "liveTranscription": false,
                 "fillerWords": " uh, um ,, UH; эм "}}
                """);

        assertEquals("https://stt.example.com/v1", config.baseUrl());
        assertEquals("https://stt.example.com/v1/audio/transcriptions", config.transcriptionsUrl());
        assertEquals("sk-cfg", config.apiKey());
        assertEquals("whisper-large-v3", config.model());
        assertEquals("uk", config.language());
        assertFalse(config.liveTranscription());
        assertEquals(List.of("uh", "um", "эм"), config.fillerWords());
        assertEquals("uh, um, эм", config.toSettingsJson().get("fillerWords").getAsString());
        assertNull(config.problem());
    }

    @Test
    public void malformedValuesAreTreatedAsMissing() {
        VoiceInputConfig config = parse("""
                {"voiceInput": {"baseUrl": "  ", "model": {"x": 1}, "language": null, "liveTranscription": "yes"}}
                """);

        assertEquals("", config.baseUrl());
        assertEquals("", config.model());
        assertEquals("", config.language());
        assertTrue(config.liveTranscription());
        assertEquals(VoiceInputConfig.Problem.MISSING_ENDPOINT, parse("{\"voiceInput\": \"oops\"}").problem());
    }

    @Test
    public void endpointMustBeHttpsUnlessItIsThisMachine() {
        String model = "\"model\": \"m\"";
        assertNull(parse("{\"voiceInput\": {\"baseUrl\": \"https://stt.example.com/v1\", " + model + "}}").problem());
        assertNull(parse("{\"voiceInput\": {\"baseUrl\": \"http://localhost:8080/v1\", " + model + "}}").problem());
        assertNull(parse("{\"voiceInput\": {\"baseUrl\": \"http://127.0.0.1:9000\", " + model + "}}").problem());
        assertNull(parse("{\"voiceInput\": {\"baseUrl\": \"http://[::1]:9000/v1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INSECURE_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"http://stt.example.com/v1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INVALID_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"stt.example.com/v1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INVALID_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"ftp://stt.example.com\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INVALID_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"https://bad host/v1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INVALID_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"https://stt.example.com/v1?key=1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INVALID_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"https:stt.example.com\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INVALID_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"https://my_host/v1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INVALID_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"http://127.1/v1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.INSECURE_ENDPOINT,
                parse("{\"voiceInput\": {\"baseUrl\": \"http://[0:0:0:0:0:0:0:1]/v1\", " + model + "}}").problem());
        assertEquals(VoiceInputConfig.Problem.MISSING_MODEL,
                parse("{\"voiceInput\": {\"baseUrl\": \"https://stt.example.com/v1\"}}").problem());
    }

    @Test
    public void keyIsOptionalAndNeverLeavesThroughSettingsJsonOrToString() {
        VoiceInputConfig withKey = parse("{\"voiceInput\": {\"apiKey\": \"sk-secret-1234abcd\"}}");
        JsonObject json = withKey.toSettingsJson();

        assertFalse(json.toString().contains("sk-secret"));
        assertFalse(withKey.toString().contains("sk-secret"));
        assertTrue(json.get("apiKeySet").getAsBoolean());
        assertEquals("…abcd", json.get("apiKeyHint").getAsString());

        assertEquals("…", parse("{\"voiceInput\": {\"apiKey\": \"sk-12345\"}}").toSettingsJson().get("apiKeyHint").getAsString());

        JsonObject none = VoiceInputConfig.from(new JsonObject()).toSettingsJson();
        assertFalse(none.get("apiKeySet").getAsBoolean());
        assertEquals("", none.get("apiKeyHint").getAsString());
    }

    @Test
    public void applyUpdateKeepsKeyUnlessSentAndClearsBlankFields() {
        JsonObject root = JsonParser.parseString("""
                {"other": 1, "voiceInput": {"apiKey": "sk-old", "model": "whisper-1", "language": "en"}}
                """).getAsJsonObject();

        VoiceInputConfig.applyUpdate(root, JsonParser.parseString("""
                {"baseUrl": "https://stt.example.com/v1", "language": " ", "liveTranscription": true}
                """).getAsJsonObject());

        JsonObject section = root.getAsJsonObject("voiceInput");
        assertEquals("sk-old", section.get("apiKey").getAsString());
        assertEquals("https://stt.example.com/v1", section.get("baseUrl").getAsString());
        assertEquals("whisper-1", section.get("model").getAsString());
        assertFalse(section.has("language"));
        assertTrue(section.get("liveTranscription").getAsBoolean());
        assertEquals(1, root.get("other").getAsInt());

        VoiceInputConfig.applyUpdate(root, JsonParser.parseString("{\"apiKey\": \" sk-new \"}").getAsJsonObject());
        assertEquals("sk-new", root.getAsJsonObject("voiceInput").get("apiKey").getAsString());

        VoiceInputConfig.applyUpdate(root, JsonParser.parseString("{\"apiKey\": \"\"}").getAsJsonObject());
        assertFalse(root.getAsJsonObject("voiceInput").has("apiKey"));
    }

    @Test
    public void applyUpdateCreatesMissingSection() {
        JsonObject root = new JsonObject();

        VoiceInputConfig.applyUpdate(root, JsonParser.parseString("{\"model\": \"whisper-large-v3\"}").getAsJsonObject());

        assertEquals("whisper-large-v3", root.getAsJsonObject("voiceInput").get("model").getAsString());
    }

    @Test
    public void previewAppliesUnsavedFormWithoutTouchingTheStoredConfig() {
        JsonObject root = JsonParser.parseString(
                "{\"voiceInput\": {\"apiKey\": \"sk-stored\", \"model\": \"whisper-1\"}}").getAsJsonObject();
        String before = root.toString();

        VoiceInputConfig keepKey = VoiceInputConfig.preview(root,
                JsonParser.parseString("{\"model\": \"other-model\", \"fillerWords\": \"hmm\"}").getAsJsonObject());
        VoiceInputConfig newKey = VoiceInputConfig.preview(root,
                JsonParser.parseString("{\"apiKey\": \"sk-typed\"}").getAsJsonObject());

        assertEquals("other-model", keepKey.model());
        assertEquals("sk-stored", keepKey.apiKey());
        assertEquals(List.of("hmm"), keepKey.fillerWords());
        assertEquals("sk-typed", newKey.apiKey());
        assertEquals(before, root.toString());
    }

    @Test
    public void fillerListIsBoundedSoUserInputCannotBuildAHugePattern() {
        String many = String.join(",", java.util.stream.IntStream.range(0, 80).mapToObj(i -> "w" + i).toList());
        String tooLong = "x".repeat(VoiceInputConfig.MAX_FILLER_WORD_LENGTH + 1);

        assertEquals(VoiceInputConfig.MAX_FILLER_WORDS, VoiceInputConfig.parseFillerWords(many).size());
        assertEquals(List.of("ok"), VoiceInputConfig.parseFillerWords(tooLong + ", ok\n"));
    }
}
