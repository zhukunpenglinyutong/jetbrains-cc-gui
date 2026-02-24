package com.github.claudecodegui.util;

import com.github.claudecodegui.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.sound.sampled.*;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.InputStream;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 声音通知服务
 * 负责在任务完成时播放提示音
 */
public class SoundNotificationService {

    private static final Logger LOG = Logger.getInstance(SoundNotificationService.class);

    /**
     * Built-in sound resources: soundId -> resource path.
     * Insertion order preserved for UI display.
     */
    public static final Map<String, String> SOUND_RESOURCES;
    static {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("default", "/sounds/success.wav");
        map.put("chime",   "/sounds/chime.wav");
        map.put("bell",    "/sounds/bell.wav");
        map.put("ding",    "/sounds/ding.wav");
        map.put("success", "/sounds/task-complete.wav");
        SOUND_RESOURCES = Collections.unmodifiableMap(map);
    }

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
     * Play task completion notification sound based on user settings.
     */
    public void playTaskCompleteSound() {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                CodemossSettingsService settings = new CodemossSettingsService();

                if (!settings.getSoundNotificationEnabled()) {
                    LOG.debug("[SoundNotification] Sound notification is disabled");
                    return;
                }

                String selectedSound = settings.getSelectedSound();
                playBySelection(selectedSound, settings.getCustomSoundPath());
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to play notification sound: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Play sound by selection: built-in soundId or custom file path.
     */
    private void playBySelection(String soundId, String customPath) throws Exception {
        if ("custom".equals(soundId)) {
            if (customPath != null && !customPath.isEmpty()) {
                LOG.debug("[SoundNotification] Playing custom sound");
                playFromFile(new File(customPath));
            } else {
                LOG.debug("[SoundNotification] Custom selected but no path, falling back to default");
                playFromResource(SOUND_RESOURCES.get("default"));
            }
        } else {
            String resourcePath = SOUND_RESOURCES.getOrDefault(soundId, SOUND_RESOURCES.get("default"));
            LOG.debug("[SoundNotification] Playing built-in sound: " + soundId);
            playFromResource(resourcePath);
        }
    }

    /**
     * Test play a sound (for settings preview).
     *
     * @param soundId  sound ID ("default", "chime", "bell", "ding", "success", "custom")
     * @param customPath custom file path (only used when soundId is "custom")
     */
    public void testPlaySound(String soundId, String customPath) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                playBySelection(
                    soundId != null ? soundId : "default",
                    customPath
                );
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
     * Play audio file using system command (for MP3 support).
     */
    private void playWithSystemCommand(File file) {
        try {
            String os = System.getProperty("os.name").toLowerCase();
            String filePath = file.getAbsolutePath();
            ProcessBuilder pb;

            if (os.contains("mac")) {
                pb = new ProcessBuilder("afplay", filePath);
            } else if (os.contains("win")) {
                // Use PowerShell Add-Type to avoid string injection via file path.
                // Pass file path as a separate -FilePath argument to the script block.
                pb = new ProcessBuilder("powershell", "-NoProfile", "-Command",
                    "Add-Type -AssemblyName PresentationCore; " +
                    "$p = New-Object System.Windows.Media.MediaPlayer; " +
                    "$p.Open([Uri]::new($args[0])); " +
                    "$p.Play(); Start-Sleep -Seconds 5; $p.Close()",
                    filePath);
            } else {
                // Linux: try ffplay (most MP3-compatible), then paplay, then aplay
                if (isCommandAvailable("ffplay")) {
                    pb = new ProcessBuilder("ffplay", "-nodisp", "-autoexit", filePath);
                } else if (isCommandAvailable("mpv")) {
                    pb = new ProcessBuilder("mpv", "--no-video", filePath);
                } else {
                    pb = new ProcessBuilder("aplay", filePath);
                }
            }

            pb.redirectErrorStream(true);
            Process process = pb.start();

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                LOG.warn("[SoundNotification] Sound playback timed out");
            }
        } catch (Exception e) {
            LOG.warn("[SoundNotification] Failed to play with system command: " + e.getMessage());
            playSystemBeep();
        }
    }

    /**
     * Check if a command is available on the system PATH.
     */
    private boolean isCommandAvailable(String command) {
        try {
            ProcessBuilder pb = new ProcessBuilder("which", command);
            pb.redirectErrorStream(true);
            Process process = pb.start();
            boolean finished = process.waitFor(3, TimeUnit.SECONDS);
            return finished && process.exitValue() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Play an audio stream and block until playback completes.
     */
    private void playAudioStream(AudioInputStream audioIn) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        Clip clip = AudioSystem.getClip();
        clip.addLineListener(event -> {
            if (event.getType() == LineEvent.Type.STOP) {
                latch.countDown();
            }
        });
        clip.open(audioIn);
        clip.start();

        // Wait for playback to complete (max 10 seconds)
        latch.await(10, TimeUnit.SECONDS);

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
            return new ValidationResult(false, "File not found");
        }

        if (!file.canRead()) {
            return new ValidationResult(false, "File is not readable");
        }

        String lowerPath = filePath.toLowerCase();
        if (!lowerPath.endsWith(".wav") && !lowerPath.endsWith(".mp3") && !lowerPath.endsWith(".aiff")) {
            return new ValidationResult(false, "Only WAV, MP3, AIFF formats are supported");
        }

        // MP3 uses system command playback, skip AudioSystem validation
        if (lowerPath.endsWith(".mp3")) {
            return new ValidationResult(true, null);
        }

        // For WAV and AIFF, try loading to validate format
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            return new ValidationResult(true, null);
        } catch (UnsupportedAudioFileException e) {
            return new ValidationResult(false, "Unsupported audio format");
        } catch (Exception e) {
            return new ValidationResult(false, "Cannot read audio file: " + e.getMessage());
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
