package com.github.claudecodegui.provider.claude;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;

public class ClaudeHistoryParserTest {

    @Test
    public void generateSummary_prefersLatestMeaningfulRequirement() {
        ClaudeHistoryParser parser = new ClaudeHistoryParser();

        ClaudeHistoryReader.ConversationMessage earlier = userMessage("请帮我修复历史标题逻辑");
        ClaudeHistoryReader.ConversationMessage continueMsg = userMessage("继续");
        ClaudeHistoryReader.ConversationMessage shortMsg = userMessage("哈哈");

        String summary = parser.generateSummary(List.of(earlier, continueMsg, shortMsg));

        assertEquals("请帮我修复历史标题逻辑", summary);
    }

    private static ClaudeHistoryReader.ConversationMessage userMessage(String text) {
        ClaudeHistoryReader.ConversationMessage msg = new ClaudeHistoryReader.ConversationMessage();
        msg.type = "user";
        msg.isMeta = false;
        msg.message = new ClaudeHistoryReader.ConversationMessage.Message();
        msg.message.role = "user";
        msg.message.content = text;
        return msg;
    }
}
