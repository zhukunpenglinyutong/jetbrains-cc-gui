package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public class ForkTitleFormatterTest {

    @Test
    public void buildForkTitle_usesBareSuffixForFirstFork() {
        assertEquals("测试消息[fork]",
                ForkTitleFormatter.buildForkTitle("测试消息", Collections.emptyList()));
    }

    @Test
    public void buildForkTitle_incrementsAcrossSiblingForks() {
        assertEquals("测试消息[fork 2]",
                ForkTitleFormatter.buildForkTitle(
                        "测试消息",
                        Arrays.asList("测试消息[fork]")));
        assertEquals("测试消息[fork 3]",
                ForkTitleFormatter.buildForkTitle(
                        "测试消息[fork 2]",
                        Arrays.asList("测试消息[fork]", "测试消息[fork 2]")));
    }

    @Test
    public void buildForkTitle_ignoresUnrelatedTitles() {
        assertEquals("测试消息[fork 4]",
                ForkTitleFormatter.buildForkTitle(
                        "测试消息",
                        Arrays.asList("别的[fork]", "测试消息[fork]", "测试消息[fork 2]", "测试消息[fork 3]")));
    }

    @Test
    public void buildForkTitle_incrementsRepeatedForksOfLongTitles() {
        String sourceTitle = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

        String firstFork = ForkTitleFormatter.buildForkTitle(sourceTitle, Collections.emptyList());
        String secondFork = ForkTitleFormatter.buildForkTitle(sourceTitle, Arrays.asList(firstFork));

        assertTrue(firstFork.endsWith("[fork]"));
        assertTrue(secondFork.endsWith("[fork 2]"));
        assertNotEquals(firstFork, secondFork);
        assertTrue(firstFork.length() <= 50);
        assertTrue(secondFork.length() <= 50);
    }

    @Test
    public void buildForkTitle_incrementsBareForkTitlesWhenSourceTitleIsEmpty() {
        assertEquals("[fork]", ForkTitleFormatter.buildForkTitle("", Collections.emptyList()));
        assertEquals("[fork 2]", ForkTitleFormatter.buildForkTitle("", Arrays.asList("[fork]")));
        assertEquals("[fork 3]", ForkTitleFormatter.buildForkTitle(null, Arrays.asList("[fork]", "[fork 2]")));
    }
}
