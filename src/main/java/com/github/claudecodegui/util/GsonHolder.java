package com.github.claudecodegui.util;

import com.google.gson.Gson;

/**
 * 共享 Gson 实例。Gson 是线程安全且不可变的，可全局复用。
 */
public final class GsonHolder {
    public static final Gson GSON = new Gson();

    private GsonHolder() {}
}
