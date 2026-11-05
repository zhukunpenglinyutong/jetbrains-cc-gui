package com.github.claudecodegui.util;

import org.junit.Assert;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Properties;

/**
 * Covers which guidance is chosen when JCEF classes are missing and how it is rendered
 * in a balloon notification.
 */
public class JcefMissingGuidanceTest {

    private static final List<String> BUNDLE_FILES = List.of(
            "ClaudeCodeGuiBundle", "ClaudeCodeGuiBundle_en", "ClaudeCodeGuiBundle_es",
            "ClaudeCodeGuiBundle_fr", "ClaudeCodeGuiBundle_hi", "ClaudeCodeGuiBundle_ja",
            "ClaudeCodeGuiBundle_ru", "ClaudeCodeGuiBundle_zh", "ClaudeCodeGuiBundle_zh_TW");

    @Test
    public void androidStudioWithSeparateJcefModuleOnWindowsOrMac() {
        Assert.assertTrue(JcefMissingGuidance.isAndroidStudioWithSeparateJcefModule("AI", 262, true));
        Assert.assertTrue(JcefMissingGuidance.isAndroidStudioWithSeparateJcefModule("AI", 263, true));
    }

    @Test
    public void androidStudioBeforeModuleSplitIsNotPluginCase() {
        Assert.assertFalse(JcefMissingGuidance.isAndroidStudioWithSeparateJcefModule("AI", 261, true));
    }

    @Test
    public void androidStudioOnLinuxIsNotPluginCase() {
        Assert.assertFalse(JcefMissingGuidance.isAndroidStudioWithSeparateJcefModule("AI", 262, false));
    }

    @Test
    public void otherIdesAreNotPluginCase() {
        Assert.assertFalse(JcefMissingGuidance.isAndroidStudioWithSeparateJcefModule("IC", 262, true));
        Assert.assertFalse(JcefMissingGuidance.isAndroidStudioWithSeparateJcefModule("", 262, true));
        Assert.assertFalse(JcefMissingGuidance.isAndroidStudioWithSeparateJcefModule(null, 262, true));
    }

    @Test
    public void pluginCaseUsesAndroidStudioPluginText() {
        Assert.assertEquals("toolwindow.jcefPluginMissing", JcefMissingGuidance.titleKey(true));
        Assert.assertEquals("toolwindow.jcefPluginMissingSolution", JcefMissingGuidance.solutionKey(true));
    }

    /**
     * Missing JCEF classes mean the IDE module is absent; the Boot Runtime advice used when
     * only the native CEF runtime is missing cannot bring those classes back.
     */
    @Test
    public void otherCasesUseIdeNeutralModuleMissingText() {
        Assert.assertEquals("toolwindow.jcefModuleMissing", JcefMissingGuidance.titleKey(false));
        Assert.assertEquals("toolwindow.jcefModuleMissingSolution", JcefMissingGuidance.solutionKey(false));
    }

    @Test
    public void everyLocaleDefinesTheGuidanceText() throws IOException {
        List<String> keys = List.of(
                JcefMissingGuidance.titleKey(true), JcefMissingGuidance.solutionKey(true),
                JcefMissingGuidance.titleKey(false), JcefMissingGuidance.solutionKey(false));
        for (String bundleFile : BUNDLE_FILES) {
            Properties properties = loadBundle(bundleFile);
            for (String key : keys) {
                String value = properties.getProperty(key);
                Assert.assertTrue(bundleFile + " is missing " + key, value != null && !value.isBlank());
            }
        }
    }

    @Test
    public void notificationHtmlEscapesMarkupAndKeepsLineBreaks() {
        String html = JcefMissingGuidance.toNotificationHtml(
                "Open Settings > Plugins.\nInstall <Web Browser> & restart.");

        Assert.assertEquals(
                "Open Settings &gt; Plugins.<br>Install &lt;Web Browser&gt; &amp; restart.",
                html);
    }

    private static Properties loadBundle(String bundleFile) throws IOException {
        String resource = "messages/" + bundleFile + ".properties";
        try (InputStream in = JcefMissingGuidanceTest.class.getClassLoader().getResourceAsStream(resource)) {
            Assert.assertNotNull("Missing bundle " + resource, in);
            Properties properties = new Properties();
            properties.load(new InputStreamReader(in, StandardCharsets.UTF_8));
            return properties;
        }
    }
}
