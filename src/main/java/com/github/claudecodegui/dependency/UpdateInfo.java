package com.github.claudecodegui.dependency;

/**
 * SDK 更新信息 DTO
 */
public class UpdateInfo {

    private final String sdkId;
    private final String sdkName;
    private final String currentVersion;
    private final String latestVersion;
    private final boolean hasUpdate;
    private final String errorMessage;

    private UpdateInfo(Builder builder) {
        this.sdkId = builder.sdkId;
        this.sdkName = builder.sdkName;
        this.currentVersion = builder.currentVersion;
        this.latestVersion = builder.latestVersion;
        this.hasUpdate = builder.hasUpdate;
        this.errorMessage = builder.errorMessage;
    }

    public String getSdkId() {
        return sdkId;
    }

    public String getSdkName() {
        return sdkName;
    }

    public String getCurrentVersion() {
        return currentVersion;
    }

    public String getLatestVersion() {
        return latestVersion;
    }

    public boolean hasUpdate() {
        return hasUpdate;
    }

    public String getErrorMessage() {
        return errorMessage;
    }

    /**
     * 创建有更新可用的结果
     */
    public static UpdateInfo updateAvailable(String sdkId, String sdkName,
                                              String currentVersion, String latestVersion) {
        return new Builder()
            .sdkId(sdkId)
            .sdkName(sdkName)
            .currentVersion(currentVersion)
            .latestVersion(latestVersion)
            .hasUpdate(true)
            .build();
    }

    /**
     * 创建无更新的结果
     */
    public static UpdateInfo noUpdate(String sdkId, String sdkName, String currentVersion) {
        return new Builder()
            .sdkId(sdkId)
            .sdkName(sdkName)
            .currentVersion(currentVersion)
            .latestVersion(currentVersion)
            .hasUpdate(false)
            .build();
    }

    /**
     * 创建检查失败的结果
     */
    public static UpdateInfo error(String sdkId, String sdkName, String errorMessage) {
        return new Builder()
            .sdkId(sdkId)
            .sdkName(sdkName)
            .errorMessage(errorMessage)
            .hasUpdate(false)
            .build();
    }

    public static class Builder {
        private String sdkId;
        private String sdkName;
        private String currentVersion;
        private String latestVersion;
        private boolean hasUpdate;
        private String errorMessage;

        public Builder sdkId(String sdkId) {
            this.sdkId = sdkId;
            return this;
        }

        public Builder sdkName(String sdkName) {
            this.sdkName = sdkName;
            return this;
        }

        public Builder currentVersion(String currentVersion) {
            this.currentVersion = currentVersion;
            return this;
        }

        public Builder latestVersion(String latestVersion) {
            this.latestVersion = latestVersion;
            return this;
        }

        public Builder hasUpdate(boolean hasUpdate) {
            this.hasUpdate = hasUpdate;
            return this;
        }

        public Builder errorMessage(String errorMessage) {
            this.errorMessage = errorMessage;
            return this;
        }

        public UpdateInfo build() {
            return new UpdateInfo(this);
        }
    }
}
