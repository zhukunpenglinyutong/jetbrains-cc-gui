package com.github.claudecodegui.markdown;

import java.util.ArrayList;
import java.util.List;

/** Immutable-by-copy snapshot sent to a single chat window. */
public final class ReviewBatch {
    public String id;
    public String kind = "review";
    public String targetId;
    public String targetEpoch;
    public String targetSessionId;
    public String path;
    public long documentVersion;
    public String documentHash;
    public String state = "pending";
    public boolean autoDeleteAffected = true;
    public boolean automatic = false;
    public List<Annotation> annotations = new ArrayList<>();
}
