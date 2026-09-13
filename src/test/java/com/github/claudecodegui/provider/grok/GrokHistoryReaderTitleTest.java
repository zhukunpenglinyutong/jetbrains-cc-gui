package com.github.claudecodegui.provider.grok;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Grok history titles should prefer the first real user prompt over CLI
 * {@code generated_title}, which is often an English paraphrase.
 */
public class GrokHistoryReaderTitleTest {

    @Test
    public void prefersChineseUserPromptOverEnglishGeneratedTitle() {
        String title = GrokHistoryReader.resolveSessionTitle(
                "新建一个文件 名称是 当前年月日, 时分秒, 内容123",
                "Create Datetime-Named File with Content 123",
                "Create Datetime-Named File with Content 123",
                "01a004df-c92d-7a51-ad6e-4d96d9c897da"
        );
        assertTrue(title.contains("新建一个文件"));
        assertTrue(title.contains("内容123"));
    }

    @Test
    public void fallsBackToGeneratedTitleWhenNoUserPrompt() {
        String title = GrokHistoryReader.resolveSessionTitle(
                null,
                "Create Timestamp-Named File With Content 123",
                null,
                "sess-1"
        );
        assertEquals("Create Timestamp-Named File With Content 123", title);
    }

    @Test
    public void fallsBackToSessionSummaryThenId() {
        assertEquals(
                "summary only",
                GrokHistoryReader.resolveSessionTitle(null, null, "summary only", "abc")
        );
        assertEquals(
                "Grok session abcdef12",
                GrokHistoryReader.resolveSessionTitle(null, null, null, "abcdef123456")
        );
    }

    @Test
    public void truncatesLongUserPrompt() {
        String longPrompt = "x".repeat(200);
        String title = GrokHistoryReader.resolveSessionTitle(longPrompt, "gen", null, "s");
        // truncate keeps maxChars then appends an ellipsis character
        assertEquals(81, title.length());
        assertTrue(title.startsWith("xxxx"));
        assertTrue(title.endsWith("…"));
    }
}
