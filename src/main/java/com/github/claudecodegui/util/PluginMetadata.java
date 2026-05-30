package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.Nullable;
import org.w3c.dom.Document;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.InputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.CodeSource;
import java.util.jar.Manifest;

/**
 * Public-API-only metadata helpers for this plugin.
 */
public final class PluginMetadata {

    private static final Logger LOG = Logger.getInstance(PluginMetadata.class);
    private static final String FALLBACK_PLUGIN_ID = "com.github.idea-claude-code-gui";
    private static final String FALLBACK_VERSION = "unknown";

    private static volatile String cachedPluginId;
    private static volatile String cachedPluginVersion;

    private PluginMetadata() {
    }

    public static String getPluginId() {
        if (cachedPluginId == null) {
            synchronized (PluginMetadata.class) {
                if (cachedPluginId == null) {
                    cachedPluginId = readPluginXmlTag("id", FALLBACK_PLUGIN_ID);
                }
            }
        }
        return cachedPluginId;
    }

    public static String getPluginVersion() {
        if (cachedPluginVersion == null) {
            synchronized (PluginMetadata.class) {
                if (cachedPluginVersion == null) {
                    cachedPluginVersion = readPluginXmlTag("version", null);
                    if (cachedPluginVersion == null) {
                        cachedPluginVersion = readManifestVersion();
                    }
                    if (cachedPluginVersion == null || cachedPluginVersion.isBlank()) {
                        cachedPluginVersion = FALLBACK_VERSION;
                    }
                }
            }
        }
        return cachedPluginVersion;
    }

    @Nullable
    public static java.io.File getPluginDirectory(Class<?> anchorClass) {
        try {
            CodeSource codeSource = anchorClass.getProtectionDomain().getCodeSource();
            if (codeSource == null || codeSource.getLocation() == null) {
                return null;
            }

            java.io.File location = new java.io.File(codeSource.getLocation().toURI());
            if (location.isFile()) {
                java.io.File parent = location.getParentFile();
                return parent != null && "lib".equals(parent.getName()) ? parent.getParentFile() : parent;
            }
            return location;
        } catch (Exception e) {
            LOG.debug("Failed to resolve plugin directory from classpath: " + e.getMessage());
            return null;
        }
    }

    @Nullable
    private static String readManifestVersion() {
        try (InputStream stream = PluginMetadata.class.getResourceAsStream("/META-INF/MANIFEST.MF")) {
            if (stream == null) {
                return null;
            }
            return new Manifest(stream).getMainAttributes().getValue("Version");
        } catch (Exception e) {
            LOG.debug("Failed to read plugin version from manifest: " + e.getMessage());
            return null;
        }
    }

    private static String readPluginXmlTag(String tagName, @Nullable String fallback) {
        try (InputStream stream = PluginMetadata.class.getResourceAsStream("/META-INF/plugin.xml")) {
            if (stream == null) {
                return fallback;
            }

            String xml = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setExpandEntityReferences(false);
            Document document = factory.newDocumentBuilder()
                .parse(new InputSource(new StringReader(xml)));
            NodeList nodes = document.getElementsByTagName(tagName);
            if (nodes.getLength() == 0) {
                return fallback;
            }
            String value = nodes.item(0).getTextContent();
            return value == null || value.isBlank() ? fallback : value.trim();
        } catch (Exception e) {
            LOG.debug("Failed to read plugin " + tagName + " from plugin.xml: " + e.getMessage());
            return fallback;
        }
    }
}
