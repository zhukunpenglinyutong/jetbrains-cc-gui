package com.github.claudecodegui.markdown;

/** Project-local preferences; review content is transient unless explicitly enabled. */
public final class MarkdownReviewConfig {
    public boolean enabled = false;
    public boolean autoAddToChat = false;
    public String submitShortcut = "enter";
    public boolean autoDeleteAffected = true;
    public boolean persist = false;
}
