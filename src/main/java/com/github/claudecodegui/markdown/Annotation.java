package com.github.claudecodegui.markdown;

/** Persisted review data; offsets are UTF-16, end-exclusive. */
public final class Annotation {
    public String id;
    public String fileUrl;
    public String path;
    public String selectedText;
    public String sourceText;
    public String sourceContext;
    public String prefix;
    public String suffix;
    public String comment;
    public String status = "attached";
    public boolean completed;
    public boolean sourceMissing;
    public String precision = "block";
    public int start;
    public int end;
    public int startLine;
    public int endLine;
    public long revision = 1;
}
