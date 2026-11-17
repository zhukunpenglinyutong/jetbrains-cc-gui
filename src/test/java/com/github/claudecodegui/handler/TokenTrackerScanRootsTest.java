package com.github.claudecodegui.handler;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class TokenTrackerScanRootsTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static JsonObject json(String text) {
        return JsonParser.parseString(text).getAsJsonObject();
    }

    private static TokenTrackerScanRoots.Result apply(String config, String added, String desired) {
        return TokenTrackerScanRoots.apply(json(config), added, desired, false);
    }

    @Test
    public void addsTheDirectoryToAnEmptyConfig() {
        TokenTrackerScanRoots.Result result = apply("{}", null, "/work/profile");

        assertTrue(result.changed());
        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/work/profile\"]}}"), result.config());
        assertEquals("/work/profile", result.trackedEntry());
    }

    @Test
    public void keepsEveryOtherKeyAndProvider() {
        String config = "{\"installedAt\":\"2026-11-01\",\"baseUrl\":\"https://x\",\"scanRoots\":{\"codex\":[\"/codex/extra\"]}}";

        TokenTrackerScanRoots.Result result = apply(config, null, "/work/profile");

        assertEquals(json("{\"installedAt\":\"2026-11-01\",\"baseUrl\":\"https://x\","
                + "\"scanRoots\":{\"codex\":[\"/codex/extra\"],\"claude\":[\"/work/profile\"]}}"), result.config());
    }

    @Test
    public void appendsAfterRootsTheUserAlreadyListed() {
        TokenTrackerScanRoots.Result result = apply("{\"scanRoots\":{\"claude\":[\"/mine\"]}}", null, "/work/profile");

        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/mine\",\"/work/profile\"]}}"), result.config());
        assertEquals("/work/profile", result.trackedEntry());
    }

    @Test
    public void clearingRemovesOnlyTheEntryThePluginAdded() {
        TokenTrackerScanRoots.Result result = apply(
                "{\"scanRoots\":{\"claude\":[\"/mine\",\"/work/profile\"]}}", "/work/profile", null);

        assertTrue(result.changed());
        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/mine\"]}}"), result.config());
        assertNull(result.trackedEntry());
    }

    @Test
    public void clearingTheLastEntryRemovesTheEmptyContainers() {
        TokenTrackerScanRoots.Result result = apply(
                "{\"installedAt\":\"x\",\"scanRoots\":{\"claude\":[\"/work/profile\"]}}", "/work/profile", null);

        assertEquals(json("{\"installedAt\":\"x\"}"), result.config());
    }

    @Test
    public void clearingKeepsOtherProvidersRoots() {
        TokenTrackerScanRoots.Result result = apply(
                "{\"scanRoots\":{\"codex\":[\"/c\"],\"claude\":[\"/work/profile\"]}}", "/work/profile", null);

        assertEquals(json("{\"scanRoots\":{\"codex\":[\"/c\"]}}"), result.config());
    }

    @Test
    public void changingTheDirectoryReplacesOnlyThePluginsEntry() {
        TokenTrackerScanRoots.Result result = apply(
                "{\"scanRoots\":{\"claude\":[\"/mine\",\"/old\"]}}", "/old", "/new");

        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/mine\",\"/new\"]}}"), result.config());
        assertEquals("/new", result.trackedEntry());
    }

    @Test
    public void anEntryTheUserAlreadyHasIsNeitherAddedNorLaterRemoved() {
        TokenTrackerScanRoots.Result added = apply("{\"scanRoots\":{\"claude\":[\"/work/profile\"]}}", null, "/work/profile");

        assertFalse(added.changed());
        assertNull(added.trackedEntry());

        TokenTrackerScanRoots.Result cleared = apply("{\"scanRoots\":{\"claude\":[\"/work/profile\"]}}", added.trackedEntry(), null);

        assertFalse(cleared.changed());
        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/work/profile\"]}}"), cleared.config());
    }

    @Test
    public void anEntryAlreadyPresentAndTrackedStaysTracked() {
        TokenTrackerScanRoots.Result result = apply("{\"scanRoots\":{\"claude\":[\"/work/profile\"]}}", "/work/profile", "/work/profile");

        assertFalse(result.changed());
        assertEquals("/work/profile", result.trackedEntry());
    }

    @Test
    public void aTrackedEntryTheUserDeletedIsAddedBack() {
        TokenTrackerScanRoots.Result result = apply("{\"scanRoots\":{\"claude\":[\"/mine\"]}}", "/work/profile", "/work/profile");

        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/mine\",\"/work/profile\"]}}"), result.config());
        assertEquals("/work/profile", result.trackedEntry());
    }

    @Test
    public void aSingleStringValueIsTreatedAsAOneEntryList() {
        TokenTrackerScanRoots.Result result = apply("{\"scanRoots\":{\"claude\":\"/mine\"}}", null, "/work/profile");

        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/mine\",\"/work/profile\"]}}"), result.config());
    }

    @Test
    public void separatorsAndTrailingSlashesDoNotCreateDuplicates() {
        TokenTrackerScanRoots.Result result = TokenTrackerScanRoots.apply(
                json("{\"scanRoots\":{\"claude\":[\"D:/profiles/work/\"]}}"), null, "D:\\profiles\\work", false);

        assertFalse(result.changed());
    }

    @Test
    public void windowsPathsCompareCaseInsensitively() {
        assertTrue(TokenTrackerScanRoots.sameEntry("D:\\Profiles\\Work", "d:/profiles/work", true));
        assertFalse(TokenTrackerScanRoots.sameEntry("/Profiles/Work", "/profiles/work", false));
    }

    @Test
    public void anUncDirectoryIsRecognisedWhateverTheSlashStyle() {
        assertTrue(TokenTrackerScanRoots.sameEntry(
                "\\\\wsl.localhost\\Debian\\home\\me\\profile", "//wsl.localhost/Debian/home/me/profile/", true));
    }

    @Test
    public void anUnexpectedShapeIsLeftUntouched() {
        for (String config : List.of("{\"scanRoots\":[\"/x\"]}", "{\"scanRoots\":{\"claude\":7}}",
                "{\"scanRoots\":{\"claude\":[\"/x\",3]}}", "{\"scanRoots\":{\"claude\":{\"a\":1}}}")) {
            JsonObject original = json(config);
            TokenTrackerScanRoots.Result result = TokenTrackerScanRoots.apply(original, "/old", "/work/profile", false);

            assertFalse(config, result.changed());
            assertSame(config, original, result.config());
            assertEquals(config, "/old", result.trackedEntry());
        }
    }

    @Test
    public void clearingWithNothingTrackedDoesNothing() {
        TokenTrackerScanRoots.Result result = apply("{\"scanRoots\":{\"claude\":[\"/mine\"]}}", null, null);

        assertFalse(result.changed());
        assertNull(result.trackedEntry());
    }

    @Test
    public void blankDesiredValueIsTreatedAsNoDirectory() {
        TokenTrackerScanRoots.Result result = apply("{}", null, "  ");

        assertFalse(result.changed());
        assertNull(result.trackedEntry());
    }

    private Path configFile() {
        return tmp.getRoot().toPath().resolve("home").resolve(".tokentracker").resolve("tracker").resolve("config.json");
    }

    private static List<String> filesIn(Path directory) throws IOException {
        try (Stream<Path> files = Files.list(directory)) {
            return files.map(path -> path.getFileName().toString()).sorted().collect(Collectors.toList());
        }
    }

    @Test
    public void createsTheConfigFileAndItsDirectories() throws Exception {
        String tracked = TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);

        assertEquals("/work/profile", tracked);
        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/work/profile\"]}}"),
                json(Files.readString(configFile(), StandardCharsets.UTF_8)));
        assertEquals(List.of("config.json"), filesIn(configFile().getParent()));
    }

    @Test
    public void doesNotCreateAFileWhenThereIsNothingToWrite() throws Exception {
        assertNull(TokenTrackerScanRoots.sync(configFile(), null, null));

        assertFalse(Files.exists(configFile()));
    }

    @Test
    public void preservesTheFileContentsThePluginDoesNotOwn() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "{\"installedAt\":\"2026-11-01\",\"baseUrl\":\"https://x\"}", StandardCharsets.UTF_8);

        TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);

        assertEquals(json("{\"installedAt\":\"2026-11-01\",\"baseUrl\":\"https://x\","
                + "\"scanRoots\":{\"claude\":[\"/work/profile\"]}}"), json(Files.readString(configFile(), StandardCharsets.UTF_8)));
    }

    @Test
    public void repeatingTheSameSyncLeavesTheFileUnchanged() throws Exception {
        String first = TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);
        String contents = Files.readString(configFile(), StandardCharsets.UTF_8);

        String second = TokenTrackerScanRoots.sync(configFile(), "/work/profile", first);

        assertEquals(first, second);
        assertEquals(contents, Files.readString(configFile(), StandardCharsets.UTF_8));
    }

    @Test
    public void clearingTheSettingRemovesWhatWasAddedFromTheFile() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "{\"installedAt\":\"x\"}", StandardCharsets.UTF_8);
        String tracked = TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);

        String after = TokenTrackerScanRoots.sync(configFile(), null, tracked);

        assertNull(after);
        assertEquals(json("{\"installedAt\":\"x\"}"), json(Files.readString(configFile(), StandardCharsets.UTF_8)));
    }

    @Test
    public void readsAFileThatStartsWithAByteOrderMark() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "\uFEFF{\"installedAt\":\"x\"}", StandardCharsets.UTF_8);

        TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);

        assertEquals(json("{\"installedAt\":\"x\",\"scanRoots\":{\"claude\":[\"/work/profile\"]}}"),
                json(Files.readString(configFile(), StandardCharsets.UTF_8)));
    }

    @Test
    public void aFileThatIsNotJsonIsNeverOverwritten() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "not json at all", StandardCharsets.UTF_8);

        String tracked = TokenTrackerScanRoots.sync(configFile(), "/work/profile", "/previous");

        assertEquals("/previous", tracked);
        assertEquals("not json at all", Files.readString(configFile(), StandardCharsets.UTF_8));
    }

    @Test
    public void aJsonArrayAtTheTopLevelIsNeverOverwritten() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "[1,2]", StandardCharsets.UTF_8);

        TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);

        assertEquals("[1,2]", Files.readString(configFile(), StandardCharsets.UTF_8));
    }

    @Test
    public void anEmptyFileIsTreatedAsAnEmptyConfig() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "", StandardCharsets.UTF_8);

        TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);

        assertEquals(json("{\"scanRoots\":{\"claude\":[\"/work/profile\"]}}"),
                json(Files.readString(configFile(), StandardCharsets.UTF_8)));
    }

    private Path markerFile() {
        return tmp.getRoot().toPath().resolve("home").resolve(".codemoss").resolve("tokentracker-scanroots.json");
    }

    @Test
    public void aMarkerRoundTripsTheTrackedEntry() throws Exception {
        TokenTrackerScanRoots.writeMarker(markerFile(), "/work/profile");

        assertEquals("/work/profile", TokenTrackerScanRoots.readMarker(markerFile()));
        assertEquals(json("{\"claudeEntry\":\"/work/profile\"}"), json(Files.readString(markerFile(), StandardCharsets.UTF_8)));
        assertEquals(List.of("tokentracker-scanroots.json"), filesIn(markerFile().getParent()));
    }

    @Test
    public void writingNoEntryRemovesTheMarker() throws Exception {
        TokenTrackerScanRoots.writeMarker(markerFile(), "/work/profile");

        TokenTrackerScanRoots.writeMarker(markerFile(), null);

        assertFalse(Files.exists(markerFile()));
        assertNull(TokenTrackerScanRoots.readMarker(markerFile()));
    }

    @Test
    public void removingAMarkerThatDoesNotExistIsHarmless() throws Exception {
        TokenTrackerScanRoots.writeMarker(markerFile(), null);

        assertFalse(Files.exists(markerFile()));
    }

    @Test
    public void anUnreadableMarkerMeansNothingIsTracked() throws Exception {
        Files.createDirectories(markerFile().getParent());
        for (String content : List.of("garbage", "[1]", "{}", "{\"claudeEntry\":5}", "{\"claudeEntry\":\"  \"}")) {
            Files.writeString(markerFile(), content, StandardCharsets.UTF_8);

            assertNull(content, TokenTrackerScanRoots.readMarker(markerFile()));
        }
    }

    @Test
    public void anEntryAddedBeforeARestartIsStillRemovedAfterwards() throws Exception {
        String trackedBefore = TokenTrackerScanRoots.sync(configFile(), "/work/profile", TokenTrackerScanRoots.readMarker(markerFile()));
        TokenTrackerScanRoots.writeMarker(markerFile(), trackedBefore);

        String trackedAfterRestart = TokenTrackerScanRoots.readMarker(markerFile());
        String afterClearing = TokenTrackerScanRoots.sync(configFile(), null, trackedAfterRestart);

        assertEquals("/work/profile", trackedAfterRestart);
        assertNull(afterClearing);
        assertEquals(json("{}"), json(Files.readString(configFile(), StandardCharsets.UTF_8)));
    }

    @Test
    public void eachIdeProductKeepsItsOwnMarker() {
        assertNotEquals(TokenTrackerScanRoots.markerFile("IU"), TokenTrackerScanRoots.markerFile("PY"));
        assertEquals("tokentracker-scanroots-IU.json", TokenTrackerScanRoots.markerFile("IU").getFileName().toString());
    }

    private Path trackerLock() {
        return configFile().resolveSibling("config.json.lock");
    }

    @Test
    public void aSyncInAnExistingTrackerDirectoryLeavesNoLockFilesBehind() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "{\"installedAt\":\"2026-11-01\"}", StandardCharsets.UTF_8);

        TokenTrackerScanRoots.sync(configFile(), "/work/profile", null);

        assertEquals(List.of("config.json"), filesIn(configFile().getParent()));
        assertEquals(json("{\"installedAt\":\"2026-11-01\",\"scanRoots\":{\"claude\":[\"/work/profile\"]}}"),
                json(Files.readString(configFile(), StandardCharsets.UTF_8)));
    }

    @Test
    public void aLockHeldByTokentrackerLeavesEverythingUntouched() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(configFile(), "{\"installedAt\":\"2026-11-01\"}", StandardCharsets.UTF_8);
        Files.writeString(trackerLock(), "{\"pid\":1,\"token\":\"theirs\"}", StandardCharsets.UTF_8);

        assertThrows(IOException.class,
                () -> TokenTrackerScanRoots.sync(configFile(), "/work/profile", null, Duration.ofMillis(100)));

        assertEquals("{\"installedAt\":\"2026-11-01\"}", Files.readString(configFile(), StandardCharsets.UTF_8));
        assertEquals("{\"pid\":1,\"token\":\"theirs\"}", Files.readString(trackerLock(), StandardCharsets.UTF_8));
    }

    @Test
    public void aLockReleasedWhileWaitingIsTaken() throws Exception {
        Files.createDirectories(configFile().getParent());
        Files.writeString(trackerLock(), "{\"pid\":1,\"token\":\"theirs\"}", StandardCharsets.UTF_8);
        Thread releaser = new Thread(() -> {
            try {
                Thread.sleep(150);
                Files.delete(trackerLock());
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        releaser.start();

        String tracked = TokenTrackerScanRoots.sync(configFile(), "/work/profile", null, Duration.ofSeconds(5));
        releaser.join();

        assertEquals("/work/profile", tracked);
        assertEquals(List.of("config.json"), filesIn(configFile().getParent()));
    }
}
