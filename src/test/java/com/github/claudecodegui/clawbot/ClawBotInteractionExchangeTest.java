package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClawBotInteractionExchangeTest {

    @Test
    public void resolvesSingleChoiceAndPreservesProviderAnswerShape() {
        JsonObject question = question("颜色", "红", "蓝");
        ClawBotInteractionExchange exchange = new ClawBotInteractionExchange();
        exchange.update(List.of(interaction("q-1", questionData(question), ClawBotInteraction.Kind.QUESTION)));
        AtomicReference<JsonObject> answer = new AtomicReference<>();

        String reply = exchange.answer(exchange.revision(), "2", (token, payload) -> {
            answer.set(payload);
            return true;
        });

        assertTrue(reply.contains("已收到回答"));
        assertEquals("蓝", answer.get().getAsJsonObject("answers").get("颜色").getAsString());
    }

    @Test
    public void collectsMultipleQuestionsBeforeCompletingTheFuture() {
        JsonObject first = question("第一个", "甲", "乙");
        JsonObject second = question("第二个", "丙", "丁");
        JsonObject data = questionData(first, second);
        ClawBotInteractionExchange exchange = new ClawBotInteractionExchange();
        exchange.update(List.of(interaction("q-2", data, ClawBotInteraction.Kind.QUESTION)));
        String firstRevision = exchange.revision();
        AtomicReference<JsonObject> answer = new AtomicReference<>();

        assertTrue(exchange.answer(firstRevision, "Q1: 1", (token, payload) -> {
            answer.set(payload);
            return true;
        }).contains("剩余问题"));
        assertEquals(null, answer.get());
        String secondRevision = exchange.revision();
        assertFalse(firstRevision.equals(secondRevision));

        String reply = exchange.answer(secondRevision, "Q2: 丁", (token, payload) -> {
            answer.set(payload);
            return true;
        });

        assertTrue(reply.contains("已收到回答"));
        JsonObject answers = answer.get().getAsJsonObject("answers");
        assertEquals("甲", answers.get("第一个").getAsString());
        assertEquals("丁", answers.get("第二个").getAsString());
    }

    @Test
    public void acceptsChineseSeparatorsForMultipleChoice() {
        JsonObject question = question("能力", "搜索", "编辑");
        question.addProperty("multiSelect", true);
        ClawBotInteractionExchange exchange = new ClawBotInteractionExchange();
        exchange.update(List.of(interaction("q-3", questionData(question), ClawBotInteraction.Kind.QUESTION)));
        AtomicReference<JsonObject> answer = new AtomicReference<>();

        exchange.answer(exchange.revision(), "1、2", (token, payload) -> {
            answer.set(payload);
            return true;
        });

        assertEquals(List.of("搜索", "编辑"), answer.get().getAsJsonObject("answers")
                .getAsJsonArray("能力").asList().stream().map(value -> value.getAsString()).toList());
    }

    @Test
    public void planApprovalCarriesSelectedExecutionMode() {
        JsonObject plan = new JsonObject();
        plan.addProperty("plan", "执行计划");
        ClawBotInteractionExchange exchange = new ClawBotInteractionExchange();
        exchange.update(List.of(interaction("plan-1", plan, ClawBotInteraction.Kind.PLAN)));
        AtomicReference<JsonObject> answer = new AtomicReference<>();

        exchange.answer(exchange.revision(), "2", (token, payload) -> {
            answer.set(payload);
            return true;
        });

        assertTrue(answer.get().get("approved").getAsBoolean());
        assertEquals("acceptEdits", answer.get().get("targetMode").getAsString());
    }

    private static ClawBotInteraction interaction(String token, JsonObject data, ClawBotInteraction.Kind kind) {
        return new ClawBotInteraction(token, kind, data, 1L, System.currentTimeMillis() + 60_000L);
    }

    @Test
    public void nativeQuestionIdsKeepRepeatedTextDistinctAndProduceTypedArrays() {
        JsonObject first = question("Choose", "A", "B");
        first.addProperty("id", "first");
        JsonObject second = first.deepCopy();
        second.addProperty("id", "second");
        second.addProperty("multiSelect", true);
        JsonObject data = questionData(first, second);
        data.addProperty("provider", "codex");
        ClawBotInteractionExchange exchange = new ClawBotInteractionExchange();
        exchange.update(List.of(interaction("native", data, ClawBotInteraction.Kind.QUESTION)));
        AtomicReference<JsonObject> result = new AtomicReference<>();
        String oldRevision = exchange.revision();
        assertTrue(exchange.answer(oldRevision, "Q1: 2", (token, answer) -> { result.set(answer); return true; }).contains("剩余问题"));
        assertFalse(exchange.prompt().contains("Q1."));
        assertTrue(exchange.prompt().contains("Q2."));
        assertTrue(exchange.answer(oldRevision, "Q2: 1", (token, answer) -> { throw new AssertionError(); }).contains("已更新"));
        exchange.answer(exchange.revision(), "Q2: 1、2", (token, answer) -> { result.set(answer); return true; });
        JsonObject answers = result.get().getAsJsonObject("answers");
        assertEquals("[\"B\"]", answers.getAsJsonObject("first").getAsJsonArray("answers").toString());
        assertEquals("[\"A\",\"B\"]", answers.getAsJsonObject("second").getAsJsonArray("answers").toString());
    }

    @Test
    public void nativeFreeTextAndCancelKeepTheQuestionIdAndEmptyCancellation() {
        for (boolean cancel : new boolean[]{false, true}) {
            JsonObject question = question("Detail");
            question.addProperty("id", "detail");
            JsonObject data = questionData(question);
            data.addProperty("provider", "codex");
            ClawBotInteractionExchange exchange = new ClawBotInteractionExchange();
            exchange.update(List.of(interaction("native", data, ClawBotInteraction.Kind.QUESTION)));
            AtomicReference<JsonObject> result = new AtomicReference<>();
            exchange.answer(exchange.revision(), cancel ? "取消回答" : "Custom text", (token, answer) -> { result.set(answer); return true; });
            assertEquals(cancel ? "{}" : "{\"detail\":{\"answers\":[\"Custom text\"]}}", result.get().get("answers").toString());
        }
    }

    private static JsonObject questionData(JsonObject... questions) {
        JsonObject data = new JsonObject();
        JsonArray values = new JsonArray();
        for (JsonObject question : questions) {
            values.add(question);
        }
        data.add("questions", values);
        return data;
    }

    private static JsonObject question(String text, String... options) {
        JsonObject question = new JsonObject();
        question.addProperty("question", text);
        JsonArray values = new JsonArray();
        for (String option : options) {
            values.add(option);
        }
        question.add("options", values);
        return question;
    }
}
