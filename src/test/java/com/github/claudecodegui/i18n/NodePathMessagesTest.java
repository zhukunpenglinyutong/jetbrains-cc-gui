package com.github.claudecodegui.i18n;

import org.junit.Assert;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.MessageFormat;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class NodePathMessagesTest {

    private static final List<String> BUNDLE_FILES = List.of(
            "ClaudeCodeGuiBundle", "ClaudeCodeGuiBundle_en", "ClaudeCodeGuiBundle_es",
            "ClaudeCodeGuiBundle_fr", "ClaudeCodeGuiBundle_hi", "ClaudeCodeGuiBundle_ja",
            "ClaudeCodeGuiBundle_ru", "ClaudeCodeGuiBundle_zh", "ClaudeCodeGuiBundle_zh_TW");

    private static final List<Path> SOURCES = List.of(
            Path.of("src/main/java/com/github/claudecodegui/handler/NodePathHandler.java"),
            Path.of("src/main/java/com/github/claudecodegui/bridge/NodeDetector.java"));

    private static final Pattern KEY_USE = Pattern.compile("message\\(\"(nodePath\\.[A-Za-z.]+)\"");
    private static final Pattern CJK = Pattern.compile("[\\u3040-\\u30ff\\u3400-\\u9fff]");
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{\\d+}");

    @Test
    public void theNodePathFlowShowsNoHardcodedChineseToTheUser() throws IOException {
        String handler = Files.readString(SOURCES.get(0), StandardCharsets.UTF_8);
        Assert.assertFalse(CJK.matcher(handler).find());

        String detector = Files.readString(SOURCES.get(1), StandardCharsets.UTF_8);
        Matcher literal = Pattern.compile("failure\\(\"[^\"]*\"").matcher(detector);
        while (literal.find()) {
            Assert.assertFalse(literal.group(), CJK.matcher(literal.group()).find());
        }
    }

    @Test
    public void everyLocaleDefinesEveryNodePathMessage() throws IOException {
        Set<String> keys = usedKeys();
        Assert.assertTrue(keys.contains("nodePath.saved"));
        for (String bundleFile : BUNDLE_FILES) {
            Properties properties = loadBundle(bundleFile);
            for (String key : keys) {
                String value = properties.getProperty(key);
                Assert.assertTrue(bundleFile + " is missing " + key, value != null && !value.isBlank());
            }
        }
    }

    @Test
    public void theEnglishBundlesAreEnglish() throws IOException {
        for (String bundleFile : List.of("ClaudeCodeGuiBundle", "ClaudeCodeGuiBundle_en")) {
            Properties properties = loadBundle(bundleFile);
            for (String key : usedKeys()) {
                Assert.assertFalse(bundleFile + " " + key, CJK.matcher(properties.getProperty(key)).find());
            }
        }
        Assert.assertEquals("Node.js path saved and applied. No IDE restart needed.",
                loadBundle("ClaudeCodeGuiBundle").getProperty("nodePath.saved"));
    }

    @Test
    public void everyTranslationKeepsTheEnglishPlaceholdersAndFormats() throws IOException {
        Properties english = loadBundle("ClaudeCodeGuiBundle");
        for (String bundleFile : BUNDLE_FILES) {
            Properties properties = loadBundle(bundleFile);
            for (String key : usedKeys()) {
                String value = properties.getProperty(key);
                Assert.assertEquals(bundleFile + " " + key, placeholders(english.getProperty(key)), placeholders(value));
                String formatted = MessageFormat.format(value, "ARG");
                Assert.assertEquals(bundleFile + " " + key, !placeholders(value).isEmpty(), formatted.contains("ARG"));
            }
        }
    }

    @Test
    public void windowsPathExamplesKeepTheirBackslashes() throws IOException {
        for (String bundleFile : BUNDLE_FILES) {
            String value = loadBundle(bundleFile).getProperty("nodePath.invalidName.windows");
            Assert.assertTrue(bundleFile, value.contains("C:\\Program Files\\nodejs\\node.exe"));
        }
    }

    private static Set<String> usedKeys() throws IOException {
        Set<String> keys = new TreeSet<>();
        for (Path source : SOURCES) {
            Matcher matcher = KEY_USE.matcher(Files.readString(source, StandardCharsets.UTF_8));
            while (matcher.find()) {
                keys.add(matcher.group(1));
            }
        }
        return keys;
    }

    private static Set<String> placeholders(String value) {
        Set<String> found = new TreeSet<>();
        Matcher matcher = PLACEHOLDER.matcher(value);
        while (matcher.find()) {
            found.add(matcher.group());
        }
        return found;
    }

    private static Properties loadBundle(String bundleFile) throws IOException {
        String resource = "messages/" + bundleFile + ".properties";
        try (InputStream in = NodePathMessagesTest.class.getClassLoader().getResourceAsStream(resource)) {
            Assert.assertNotNull("Missing bundle " + resource, in);
            Properties properties = new Properties();
            properties.load(new InputStreamReader(in, StandardCharsets.UTF_8));
            return properties;
        }
    }
}
