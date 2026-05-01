package com.github.claudecodegui.util;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import javazoom.jl.decoder.JavaLayerException;
import javazoom.jl.player.Player;

import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.Clip;
import javax.sound.sampled.LineEvent;
import javax.sound.sampled.UnsupportedAudioFileException;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Sound notification service
 * Responsible for playing notification sounds when a task completes
 */
public class SoundNotificationService {

    private static final Logger LOG = Logger.getInstance(SoundNotificationService.class);

    /**
     * Built-in sound definition for settings dropdown and resource playback.
     */
    public record BuiltInSound(String id, String resourcePath, String i18nKey, String defaultLabel) {
    }

    /**
     * Built-in sounds in display order.
     */
    private static final List<BuiltInSound> BUILT_IN_SOUNDS;

    /**
     * Built-in sound resources: soundId -> resource path.
     * Insertion order preserved for UI display.
     */
    public static final Map<String, String> SOUND_RESOURCES;

    static {
        List<BuiltInSound> sounds = new ArrayList<>();
        sounds.add(new BuiltInSound(
                "default",
                "/sounds/success.wav",
                "settings.basic.soundNotification.soundDefault",
                "Default"
        ));
        sounds.add(new BuiltInSound(
                "chime",
                "/sounds/chime.wav",
                "settings.basic.soundNotification.soundChime",
                "Chime"
        ));
        sounds.add(new BuiltInSound(
                "bell",
                "/sounds/bell.wav",
                "settings.basic.soundNotification.soundBell",
                "Bell"
        ));
        sounds.add(new BuiltInSound(
                "ding",
                "/sounds/ding.wav",
                "settings.basic.soundNotification.soundDing",
                "Ding"
        ));
        sounds.add(new BuiltInSound(
                "success",
                "/sounds/task-complete.wav",
                "settings.basic.soundNotification.soundSuccess",
                "Success"
        ));
        sounds.add(new BuiltInSound("ring", "/sounds/ring.mp3", null, "Ring"));
        sounds.add(new BuiltInSound("dindong", "/sounds/dindong.mp3", null, "Dindong"));
        sounds.add(new BuiltInSound("rin", "/sounds/rin.mp3", null, "Rin"));
        sounds.add(new BuiltInSound("yring", "/sounds/yring.mp3", null, "Yring"));
        BUILT_IN_SOUNDS = Collections.unmodifiableList(sounds);

        Map<String, String> map = new LinkedHashMap<>();
        for (BuiltInSound sound : BUILT_IN_SOUNDS) {
            map.put(sound.id(), sound.resourcePath());
        }
        SOUND_RESOURCES = Collections.unmodifiableMap(map);
    }

    /**
     * Get built-in sounds in display order.
     */
    public static List<BuiltInSound> getBuiltInSounds() {
        return BUILT_IN_SOUNDS;
    }

    // Singleton pattern
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

                if (settings.getSoundOnlyWhenUnfocused() && ApplicationManager.getApplication().isActive()) {
                    LOG.debug("[SoundNotification] IDE window is focused, skipping notification sound");
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
            String normalizedCustomPath = normalizeSoundPath(customPath);
            if (normalizedCustomPath != null && !normalizedCustomPath.isEmpty()) {
                LOG.debug("[SoundNotification] Playing custom sound: " + normalizedCustomPath);
                playFromFile(normalizedCustomPath);
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
     * @param soundId    sound ID ("default", "chime", "bell", "ding", "success", "custom")
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
     * Play audio from a bundled resource.
     */
    private void playFromResource(String resourcePath) throws Exception {
        try (InputStream rawStream = getClass().getResourceAsStream(resourcePath)) {
            if (rawStream == null) {
                LOG.warn("[SoundNotification] Sound resource not found: " + resourcePath);
                return;
            }

            // Wrap with BufferedInputStream because AudioSystem requires mark/reset support
            try (BufferedInputStream bufferedStream = new BufferedInputStream(rawStream);
                    AudioInputStream audioIn = AudioSystem.getAudioInputStream(bufferedStream)) {
                playAudioStream(audioIn);
            }
        }
    }

    /**
     * Normalize user provided sound path (supports file:// URI).
     */
    private String normalizeSoundPath(String filePath) {
        if (filePath == null) {
            return null;
        }

        String normalized = filePath.trim();
        if (normalized.isEmpty()) {
            return normalized;
        }

        // Remove wrapping quotes to avoid lookup failures on Windows.
        if (normalized.length() >= 2 && normalized.startsWith("\"") && normalized.endsWith("\"")) {
            normalized = normalized.substring(1, normalized.length() - 1);
        }

        if (normalized.startsWith("file://")) {
            try {
                normalized = new File(new URI(normalized)).getPath();
            } catch (Exception e) {
                LOG.warn("[SoundNotification] Failed to parse file URI: " + normalized + " - " + e.getMessage());
            }
        }

        return normalized;
    }

    /**
     * Play audio from a file.
     */
    private void playFromFile(String rawPath) throws Exception {
        String normalizedPath = normalizeSoundPath(rawPath);
        if (normalizedPath == null || normalizedPath.isEmpty()) {
            LOG.warn("[SoundNotification] Custom sound path is empty");
            return;
        }

        File file = new File(normalizedPath);
        if (!file.exists() || !file.canRead()) {
            LOG.warn("[SoundNotification] Sound file not found or not readable: " + file.getAbsolutePath());
            return;
        }

        String fileName = file.getName().toLowerCase(Locale.ROOT);

        // Decode and play MP3 files with JLayer on a background thread
        if (fileName.endsWith(".mp3")) {
            playMp3(file);
            return;
        }

        // Play WAV and AIFF files with the Java standard library
        try (AudioInputStream audioIn = AudioSystem.getAudioInputStream(file)) {
            playAudioStream(audioIn);
        }
    }

    /**
     * Max playback time for MP3 files (seconds).
     * Prevents a corrupted/oversized file from blocking the pooled thread indefinitely.
     */
    private static final int MP3_PLAYBACK_TIMEOUT_SECONDS = 30;

    /**
     * Play MP3 with JLayer (called from a background thread and blocks until playback completes or times out).
     */
    private void playMp3(File file) throws Exception {
        try (BufferedInputStream bufferedStream = new BufferedInputStream(new FileInputStream(file))) {
            Player player = new Player(bufferedStream);
            CountDownLatch latch = new CountDownLatch(1);

            Thread playThread = new Thread(() -> {
                try {
                    player.play();
                } catch (JavaLayerException e) {
                    LOG.warn("[SoundNotification] MP3 playback error: " + e.getMessage());
                } finally {
                    latch.countDown();
                }
            }, "SoundNotification-MP3");
            playThread.setDaemon(true);
            playThread.start();

            if (!latch.await(MP3_PLAYBACK_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                LOG.warn("[SoundNotification] MP3 playback timed out after " + MP3_PLAYBACK_TIMEOUT_SECONDS + "s");
                player.close();
                playThread.interrupt();
            }
        } catch (JavaLayerException e) {
            throw new Exception("Failed to decode MP3: " + e.getMessage(), e);
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
     * Validate whether an audio file is usable.
     *
     * @param filePath file path
     * @return validation result, including success state and error information
     */
    public ValidationResult validateSoundFile(String filePath) {
        String normalizedPath = normalizeSoundPath(filePath);
        if (normalizedPath == null || normalizedPath.isEmpty()) {
            return new ValidationResult(true, null); // An empty path means the default sound should be used
        }

        File file = new File(normalizedPath);

        if (!file.exists()) {
            return new ValidationResult(false, "File not found");
        }

        if (!file.canRead()) {
            return new ValidationResult(false, "File is not readable");
        }

        String lowerPath = normalizedPath.toLowerCase(Locale.ROOT);
        if (!lowerPath.endsWith(".wav") && !lowerPath.endsWith(".mp3") && !lowerPath.endsWith(".aiff")) {
            return new ValidationResult(false, "Only WAV, MP3, AIFF formats are supported");
        }

        // MP3 playback uses JLayer, so skip AudioSystem format validation
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
     * Validation result
     */
    public record ValidationResult(boolean valid, String errorMessage) {
    }
}
