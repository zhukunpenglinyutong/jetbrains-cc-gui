package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Regression tests for selection text normalization before sending content to CCG.
 */
public class SelectionTextUtilsTest {

    @Test
    public void normalizeSendableText_returnsNullForNull() {
        assertNull(SelectionTextUtils.normalizeSendableText(null));
    }

    @Test
    public void normalizeSendableText_returnsNullForBlankOnly() {
        assertNull(SelectionTextUtils.normalizeSendableText("   \n\t  "));
    }

    @Test
    public void normalizeSendableText_returnsNullForEmptyString() {
        assertNull(SelectionTextUtils.normalizeSendableText(""));
    }

    @Test
    public void normalizeSendableText_preservesOriginalContentWhenSendable() {
        String original = "  hello console  ";

        assertEquals(original, SelectionTextUtils.normalizeSendableText(original));
    }

    @Test
    public void normalizeSendableText_preservesTextWithNewlines() {
        String code = "public void test() {\n    System.out.println(\"hello\");\n}";

        assertEquals(code, SelectionTextUtils.normalizeSendableText(code));
    }

    @Test
    public void normalizeSendableText_handlesUnicodeText() {
        String chinese = "你好世界";

        assertEquals(chinese, SelectionTextUtils.normalizeSendableText(chinese));
    }
}
