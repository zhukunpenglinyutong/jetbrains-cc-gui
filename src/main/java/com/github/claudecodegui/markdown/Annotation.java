package com.github.claudecodegui.markdown;

/** Persisted review data; offsets are UTF-16, end-exclusive. */
public final class Annotation {
    public String id;
    public String fileUrl;
    public String path;
    public String selectedText;
    public String sourceText;
    /** Matched head/tail fragment when status is "changed"; derived and refreshed on reconcile. */
    public String anchorText;
    public String sourceContext;
    public String prefix;
    public String suffix;
    public String comment;
    public String status = "attached";
    public boolean completed;
    public boolean sourceMissing;
    /** Ephemeral push-only marker: the annotation was completed or deleted after
     * handoff, so live chat drafts must drop this snapshot. Never persisted on purpose. */
    public boolean withdrawn;
    public String precision = "block";
    public int start;
    public int end;
    public int startLine;
    public int endLine;
    public long revision = 1;
}
