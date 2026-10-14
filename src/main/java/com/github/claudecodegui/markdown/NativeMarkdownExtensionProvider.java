package com.github.claudecodegui.markdown;

import com.intellij.openapi.application.ApplicationInfo;
import org.intellij.plugins.markdown.extensions.MarkdownBrowserPreviewExtension;
import org.intellij.plugins.markdown.ui.preview.MarkdownHtmlPanel;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/** Uses the IDE-owned preview; never creates another Markdown renderer/browser. */
public final class NativeMarkdownExtensionProvider implements MarkdownBrowserPreviewExtension.Provider {
    @Override
    public @Nullable MarkdownBrowserPreviewExtension createBrowserExtension(@NotNull MarkdownHtmlPanel panel) {
        if (ApplicationInfo.getInstance().getBuild().getBaselineVersion() < 243) {
            return null;
        }
        if (panel.getProject() == null || panel.getVirtualFile() == null || panel.getBrowserPipe() == null) {
            return null;
        }
        return new NativeMarkdownAnnotations(panel);
    }
}
