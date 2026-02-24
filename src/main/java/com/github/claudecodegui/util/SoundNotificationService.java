package com.github.claudecodegui.util;

import com.github.claudecodegui.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.sound.sampled.*;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;

/**
 * 声音通知服务
 * 负责在任务完成时播放提示音
 */
public class SoundNotificationService {

    private static final Logger LOG = Logger.getInstance(SoundNotificationService.class);
    private static final String DEFAULT_SOUND_PATH = "/sounds/task-complete.wav";

    // 单例模式
    private static volatile SoundNotificationService instance;

    private SoundNotificationService() {
    }

    public static SoundNotificationService getInstance() {
        if (instance == null) {
            synchronized (SoundNotificationService.class) {
                if (instance == null) {
                    instance = new SoundNotificationService();
                }
            }
        }
        return instance;
    }

    /**
     * 播放任务完成提示音
     */
    public void playTaskCompleteSound() {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                CodemossSettingsService settings = new CodemossSettingsService();

                // 检查是否启用提示音
                if (!settings.getSoundNotificationEnabled()) {
                    LOG.debug("[SoundNotification] Sound notification is disabled");
                    return;
                }

                String customSoundPath = settings.getCustomSoundPath();

                if (customSoundPath != null && !customSoundPath.isEmpty()) {
                    // 播放自定义音频
                    LOG.info("[SoundNotification] Playing custom sound: " + customSoundPath);
                    playFromFile(new File(customSoundPath));
                } else {
                    // 播放默认音频
                    LOG.info("[SoundNotification] Playing default sound");
                    playFromResource(DEFAULT_SOUND_PATH);
                }
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to play notification sound: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 测试播放提示音（用于设置预览）
     *
     * @param soundPath 声音文件路径，为空则使用默认声音
     */
    public void testPlaySound(String soundPath) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                if (soundPath == null || soundPath.isEmpty()) {
                    LOG.info("[SoundNotification] Testing default sound");
                    playFromResource(DEFAULT_SOUND_PATH);
                } else {
                    LOG.info("[SoundNotification] Testing custom sound: " + soundPath);
                    playFromFile(new File(soundPath));
                }
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to play test sound: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 从资源文件播放音频
     */
    private void playFromResource(String resourcePath) throws Exception {
        try (InputStream rawStream = getClass().getResourceAsStream(resourcePath)) {
            if (rawStream == null) {
                LOG.info("[SoundNotification] Sound resource not found, using system beep as fallback");
                playSystemBeep();
                return;
            }

            // 使用 BufferedInputStream 包装，因为 AudioSystem 需要 mark/reset 支持
            try (BufferedInputStream bufferedStream = new BufferedInputStream(rawStream);
                 AudioInputStream audioIn = AudioSystem.getAudioInputStream(bufferedStream)) {
                playAudioStream(audioIn);
            }
        }
    }

    /**
     * 播放系统默认提示音（作为回退方案）
     */
    private void playSystemBeep() {
        try {
            java.awt.Toolkit.getDefaultToolkit().beep();
        } catch (Exception e) {
            LOG.debug("[SoundNotification] System beep failed: " + e.getMessage());
        }
    }

    /**
     * 从文件播放音频
     */
    private void playFromFile(File file) throws Exception {
        if (!file.exists() || !file.canRead()) {
            LOG.warn("[SoundNotification] Sound file not found or not readable: " + file.getAbsolutePath());
            return;
        }

        String fileName = file.getName().toLowerCase();

        // MP3 格式使用系统命令播放
        if (fileName.endsWith(".mp3")) {
            playWithSystemCommand(file);
            return;
        }

        // WAV 和 AIFF 格式使用 Java 标准库播放
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            playAudioStream(audioIn);
        }
    }

    /**
     * 使用系统命令播放音频文件（支持 MP3）
     */
    private void playWithSystemCommand(File file) {
        try {
            String os = System.getProperty("os.name").toLowerCase();
            ProcessBuilder pb;

            if (os.contains("mac")) {
                // macOS 使用 afplay
                pb = new ProcessBuilder("afplay", file.getAbsolutePath());
            } else if (os.contains("win")) {
                // Windows 使用 PowerShell 播放
                pb = new ProcessBuilder("powershell", "-c",
                    "(New-Object Media.SoundPlayer '" + file.getAbsolutePath() + "').PlaySync()");
            } else {
                // Linux 尝试使用 aplay 或 paplay
                pb = new ProcessBuilder("aplay", file.getAbsolutePath());
            }

            pb.redirectErrorStream(true);
            Process process = pb.start();

            // 等待播放完成，最多 30 秒
            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                LOG.warn("[SoundNotification] Sound playback timed out");
            }
        } catch (Exception e) {
            LOG.warn("[SoundNotification] Failed to play with system command: " + e.getMessage());
            // 回退到系统 beep
            playSystemBeep();
        }
    }

    /**
     * 播放音频流
     */
    private void playAudioStream(AudioInputStream audioIn) throws Exception {
        Clip clip = AudioSystem.getClip();
        clip.open(audioIn);
        clip.start();

        // 等待播放完成后关闭
        clip.addLineListener(event -> {
            if (event.getType() == LineEvent.Type.STOP) {
                clip.close();
            }
        });

        // 等待播放完成（最多等待 10 秒）
        int maxWaitMs = 10000;
        int waitedMs = 0;
        while (clip.isRunning() && waitedMs < maxWaitMs) {
            Thread.sleep(100);
            waitedMs += 100;
        }

        // 确保资源被释放
        if (clip.isOpen()) {
            clip.close();
        }
    }

    /**
     * 验证音频文件是否可用
     *
     * @param filePath 文件路径
     * @return 验证结果，包含成功状态和错误信息
     */
    public ValidationResult validateSoundFile(String filePath) {
        if (filePath == null || filePath.isEmpty()) {
            return new ValidationResult(true, null); // 空路径表示使用默认声音
        }

        File file = new File(filePath);

        if (!file.exists()) {
            return new ValidationResult(false, "文件不存在");
        }

        if (!file.canRead()) {
            return new ValidationResult(false, "文件无法读取");
        }

        // 验证文件格式
        String lowerPath = filePath.toLowerCase();
        if (!lowerPath.endsWith(".wav") && !lowerPath.endsWith(".mp3") && !lowerPath.endsWith(".aiff")) {
            return new ValidationResult(false, "仅支持 WAV、MP3、AIFF 格式");
        }

        // MP3 格式需要使用系统命令播放，跳过 AudioSystem 验证
        if (lowerPath.endsWith(".mp3")) {
            return new ValidationResult(true, null);
        }

        // 对于 WAV 和 AIFF 格式，尝试加载文件验证格式
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            return new ValidationResult(true, null);
        } catch (UnsupportedAudioFileException e) {
            return new ValidationResult(false, "不支持的音频格式");
        } catch (Exception e) {
            return new ValidationResult(false, "无法读取音频文件: " + e.getMessage());
        }
    }

    /**
     * 验证结果
     */
    public static class ValidationResult {
        private final boolean valid;
        private final String errorMessage;

        public ValidationResult(boolean valid, String errorMessage) {
            this.valid = valid;
            this.errorMessage = errorMessage;
        }

        public boolean isValid() {
            return valid;
        }

        public String getErrorMessage() {
            return errorMessage;
        }
    }
}
