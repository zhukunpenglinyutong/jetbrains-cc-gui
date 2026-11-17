package com.github.claudecodegui.markdown;

/** Project-local preferences; review content is transient unless explicitly enabled. */
public final class MarkdownReviewConfig {
    public boolean enabled = false;
    public boolean autoAddToChat = false;
    public String submitShortcut = "enter";
    // Off by default: a cut-and-paste move would otherwise delete the comment for good.
    public boolean autoDeleteAffected = false;
    public boolean persist = false;
}
