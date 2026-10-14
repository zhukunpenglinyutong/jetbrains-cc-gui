package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.BiPredicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Per-turn question numbering, validated answer parsing and partial multi-question answers. */
public final class ClawBotInteractionExchange {
    private static final Pattern QUALIFIED = Pattern.compile("(?is)^Q(\\d+)\\s*[:：]\\s*(.+)$");
    private final Map<String, Integer> numbers = new LinkedHashMap<>();
    private final Map<String, JsonObject> answers = new LinkedHashMap<>();
    private List<ClawBotInteraction> interactions = List.of();
    private String signature = "";
    private String revision = "";
    private int nextNumber;

    public synchronized void update(List<ClawBotInteraction> current) {
        String next = current.stream().map(ClawBotInteraction::token).reduce("", (left, right) -> left + "/" + right);
        interactions = List.copyOf(current);
        answers.keySet().removeIf(token -> current.stream().noneMatch(value -> value.token().equals(token)));
        if (!signature.equals(next)) {
            signature = next;
            revision = current.isEmpty() ? "" : UUID.randomUUID().toString();
        }
    }

    public synchronized String revision() {
        return revision;
    }

    public synchronized String prompt() {
        List<Item> items = items();
        if (items.isEmpty()) {
            return "";
        }
        StringBuilder text = new StringBuilder("【等待回答】\n普通进度推送已暂停。\n");
        for (Item item : items) {
            JsonObject data = item.data();
            text.append("\nQ").append(item.number()).append(". ");
            switch (item.interaction().kind()) {
                case QUESTION -> {
                    text.append(string(data, "question"));
                    if (!string(data, "detail").isBlank()) {
                        text.append('\n').append(string(data, "detail"));
                    }
                    List<String> labels = labels(data);
                    for (int index = 0; index < labels.size(); index++) {
                        text.append('\n').append(index + 1).append(". ").append(labels.get(index));
                        JsonElement option = data.getAsJsonArray("options").get(index);
                        if (option.isJsonObject() && !string(option.getAsJsonObject(), "description").isBlank()) {
                            text.append(" — ").append(string(option.getAsJsonObject(), "description"));
                        }
                    }
                    text.append(multi(data) ? "\n可多选，用逗号分隔编号；也可直接输入答案。" : "\n回复选项编号、选项文字或直接输入答案。");
                }
                case PERMISSION -> text.append("操作审批：").append(string(data, "toolName"))
                        .append('\n').append(data.has("inputs") ? data.get("inputs").toString() : "")
                        .append("\n1. 允许本次操作\n2. 拒绝");
                case PLAN -> text.append("计划审批\n").append(string(data, "plan"))
                        .append(data.has("allowedPrompts") ? "\n申请权限：" + data.get("allowedPrompts") : "")
                        .append("\n1. 批准并执行（默认模式）")
                        .append("\n2. 批准并允许编辑")
                        .append("\n3. 批准并自动执行")
                        .append("\n4. 批准并绕过权限")
                        .append("\n5. 拒绝计划");
            }
        }
        text.append(items.size() == 1 ? "\n\n可直接回复。" : "\n\n有多个待回答问题，请使用 Q编号: 答案，例如 Q2: 1。");
        text.append("回复“取消回答”可取消对应问题；也可在 IDE 中处理。");
        // Do not offer a decision on content the user has not been able to review.
        return text.length() > 12000 ? "【等待回答】\n问题或操作内容过长，请在 IDE 中查看完整内容并处理。普通进度推送已暂停。" : text.toString();
    }

    public synchronized String answer(String expectedRevision, String raw, BiPredicate<String, JsonObject> complete) {
        if (revision.isEmpty() || !revision.equals(expectedRevision)) {
            return "问题已更新、已处理或已过期，请根据最新问题重新回答。";
        }
        if (prompt().contains("内容过长")) {
            return "请在 IDE 中查看完整内容并处理该问题。";
        }
        List<Item> items = items();
        String value = raw.trim();
        Item selected = null;
        Matcher matcher = QUALIFIED.matcher(value);
        if (matcher.matches()) {
            String number = matcher.group(1);
            selected = items.stream().filter(item -> Integer.toString(item.number()).equals(number)).findFirst().orElse(null);
            value = matcher.group(2).trim();
        } else if (items.size() == 1) {
            selected = items.get(0);
        }
        if (selected == null) {
            return "请注明当前问题编号，例如 Q2: 1。\n\n" + prompt();
        }
        boolean cancel = "取消回答".equals(value);
        JsonObject response = new JsonObject();
        ClawBotInteraction interaction = selected.interaction();
        if (interaction.kind() == ClawBotInteraction.Kind.QUESTION) {
            JsonObject collected = answers.computeIfAbsent(interaction.token(), ignored -> new JsonObject());
            if (!cancel) {
                JsonElement parsed;
                try {
                    parsed = parseAnswer(selected.data(), value);
                } catch (IllegalArgumentException error) {
                    return error.getMessage();
                }
                collected.add(string(selected.data(), "question"), parsed);
                if (collected.size() < questions(interaction.data()).size()) {
                    revision = UUID.randomUUID().toString();
                    return "已记录该题答案，请继续回答剩余问题。";
                }
            }
            response.add("answers", cancel ? new JsonObject() : collected.deepCopy());
        } else {
            PlanDecision selectedPlan = interaction.kind() == ClawBotInteraction.Kind.PLAN
                    ? planDecision(value) : null;
            Boolean allow = interaction.kind() == ClawBotInteraction.Kind.PLAN
                    ? selectedPlan == null ? null : selectedPlan.approved() : decision(value);
            if (allow == null && !cancel) {
                return interaction.kind() == ClawBotInteraction.Kind.PLAN
                        ? "请回复 1-4 批准并选择执行模式，或回复 5 拒绝计划。"
                        : "请回复 1（允许）或 2（拒绝）；该操作不会自动批准。";
            }
            response.addProperty(interaction.kind() == ClawBotInteraction.Kind.PLAN ? "approved" : "allow", !cancel && Boolean.TRUE.equals(allow));
            response.addProperty("remember", false);
            response.addProperty("targetMode", selectedPlan == null ? "default" : selectedPlan.targetMode());
        }
        if (!complete.test(interaction.token(), response)) {
            return "该问题已在 IDE 中处理、已过期或不属于当前任务，未重复提交。";
        }
        answers.remove(interaction.token());
        return cancel ? "已取消回答，结果已返回任务。" : "已收到回答或审批决定，结果已返回任务。";
    }

    private List<Item> items() {
        List<Item> result = new ArrayList<>();
        for (ClawBotInteraction interaction : interactions) {
            List<JsonObject> data = interaction.kind() == ClawBotInteraction.Kind.QUESTION
                    ? questions(interaction.data()) : List.of(interaction.data());
            for (int index = 0; index < data.size(); index++) {
                JsonObject question = data.get(index);
                String key = interaction.token() + ":" + index;
                int number = numbers.computeIfAbsent(key, ignored -> ++nextNumber);
                JsonObject collected = answers.get(interaction.token());
                if (collected == null || !collected.has(string(question, "question"))) {
                    result.add(new Item(number, interaction, question));
                }
            }
        }
        return result;
    }

    private static List<JsonObject> questions(JsonObject data) {
        List<JsonObject> result = new ArrayList<>();
        if (data.has("questions") && data.get("questions").isJsonArray()) {
            for (JsonElement value : data.getAsJsonArray("questions")) {
                if (value.isJsonObject() && !string(value.getAsJsonObject(), "question").isBlank()) {
                    result.add(value.getAsJsonObject());
                }
            }
        }
        return result;
    }

    private static JsonElement parseAnswer(JsonObject question, String raw) {
        if (raw.isBlank() || raw.length() > 10000) {
            throw new IllegalArgumentException("答案不能为空且不能超过 10000 个字符。");
        }
        List<String> options = labels(question);
        String value = raw.replaceFirst("^(?:选择|选中)\\s*", "");
        JsonArray result = new JsonArray();
        if (!options.isEmpty() && value.matches("[0-9]+(?:\\s*[,，、]\\s*[0-9]+)*")) {
            for (String part : value.split("\\s*[,，、]\\s*")) {
                int index;
                try {
                    index = Integer.parseInt(part) - 1;
                } catch (NumberFormatException error) {
                    throw new IllegalArgumentException("选项编号无效，请根据当前问题重新回答。");
                }
                if (index < 0 || index >= options.size() || !multi(question) && result.size() > 0) {
                    throw new IllegalArgumentException("选项编号无效，或单选题提交了多个选项。");
                }
                JsonPrimitive label = new JsonPrimitive(options.get(index));
                if (!result.contains(label)) {
                    result.add(label);
                }
            }
        } else if (multi(question) && value.matches(".*[,，、].*")
                && List.of(value.split("\\s*[,，、]\\s*")).stream().allMatch(options::contains)) {
            for (String part : value.split("\\s*[,，、]\\s*")) {
                result.add(part);
            }
        } else {
            result.add(options.contains(value) ? value : raw);
        }
        return multi(question) ? result : result.get(0);
    }

    private static Boolean decision(String value) {
        return switch (value.toLowerCase(Locale.ROOT)) {
            case "1", "允许", "批准", "同意", "允许本次操作", "approve", "allow" -> true;
            case "2", "拒绝", "不同意", "拒绝计划", "deny", "reject" -> false;
            default -> null;
        };
    }

    private static PlanDecision planDecision(String value) {
        return switch (value.trim().toLowerCase(Locale.ROOT)) {
            case "1", "批准", "同意", "批准计划", "approve", "default" -> new PlanDecision(true, "default");
            case "2", "允许编辑", "接受编辑", "acceptedits" -> new PlanDecision(true, "acceptEdits");
            case "3", "自动执行", "自动", "auto" -> new PlanDecision(true, "auto");
            case "4", "绕过权限", "bypasspermissions" -> new PlanDecision(true, "bypassPermissions");
            case "5", "拒绝", "不同意", "拒绝计划", "deny", "reject" -> new PlanDecision(false, "default");
            default -> null;
        };
    }

    private static List<String> labels(JsonObject question) {
        List<String> result = new ArrayList<>();
        if (question.has("options") && question.get("options").isJsonArray()) {
            for (JsonElement option : question.getAsJsonArray("options")) {
                result.add(option.isJsonObject() ? string(option.getAsJsonObject(), "label") : option.getAsString());
            }
        }
        return result;
    }

    private static boolean multi(JsonObject data) {
        return data.has("multiSelect") && data.get("multiSelect").isJsonPrimitive() && data.get("multiSelect").getAsBoolean();
    }

    private static String string(JsonObject data, String key) {
        return data.has(key) && data.get(key).isJsonPrimitive() ? data.get(key).getAsString() : "";
    }

    private record Item(int number, ClawBotInteraction interaction, JsonObject data) { }

    private record PlanDecision(boolean approved, String targetMode) { }
}
