package com.github.claudecodegui.hooks;

import com.google.gson.JsonObject;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.DosFileAttributeView;
import java.nio.file.attribute.DosFileAttributes;
import java.nio.file.attribute.UserPrincipal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Uses actual writable NTFS fixtures, rather than mocked attribute views. */
public class HookWindowsAttributesTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void saveAndBackupRestorePreserveCustomAclOwnerAndDosFlags() throws Exception {
        Path home = windowsHome();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        String original = "{\"hooks\":{},\"unrelated\":17}";
        Files.writeString(settings, original);
        Attributes expected = customizeAndCapture(settings);
        HookMutationService service = new HookMutationService(home);
        String revision = service.read(null, settings.toString()).get("revision").getAsString();

        JsonObject saved = service.write(null, settings.toString(), revision,
                "{\"hooks\":{},\"unrelated\":17,\"accepted\":true}");

        assertTrue(saved.toString(), saved.get("success").getAsBoolean());
        assertAttributes(expected, settings);
        JsonObject restored = service.restore(null, settings.toString(), saved.get("revision").getAsString(),
                saved.get("backupPath").getAsString());
        assertTrue(restored.toString(), restored.get("success").getAsBoolean());
        assertEquals(original, Files.readString(settings));
        assertAttributes(expected, settings);
    }

    @Test
    public void scriptQuarantineAndRestorePreserveContentAclOwnerAndDosFlags() throws Exception {
        Path home = windowsHome();
        Path script = Files.createDirectories(home.resolve(".codemoss/hooks/nested")).resolve("guard.ps1");
        String original = "Write-Output 'isolated hook fixture'\n";
        Files.writeString(script, original);
        Attributes expected = customizeAndCapture(script);
        HookCatalogService catalog = new HookCatalogService(home);
        JsonObject item = catalog.scan(null).getAsJsonArray("items").get(0).getAsJsonObject();
        HookToggleService toggles = new HookToggleService(home);

        JsonObject disabled = toggles.toggle(null, request(item, false));
        assertTrue(disabled.toString(), disabled.get("success").getAsBoolean());
        assertFalse(Files.exists(script));
        JsonObject disabledItem = catalog.scan(null).getAsJsonArray("items").get(0).getAsJsonObject();
        JsonObject enabled = toggles.toggle(null, request(disabledItem, true));
        assertTrue(enabled.toString(), enabled.get("success").getAsBoolean());
        assertEquals(original, Files.readString(script));
        assertAttributes(expected, script);
    }

    @Test
    public void claudeToggleRoundTripPreservesAttributesAndUnrelatedFields() throws Exception {
        Path home = windowsHome();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        Files.writeString(settings,
                "{\"hooks\":{\"Stop\":[{\"type\":\"command\",\"command\":\"echo marker\"}]},\"unrelated\":17}");
        Attributes expected = customizeAndCapture(settings);
        HookCatalogService catalog = new HookCatalogService(home);
        HookToggleService toggles = new HookToggleService(home);
        JsonObject item = catalog.scan(null).getAsJsonArray("items").get(0).getAsJsonObject();

        JsonObject disabled = toggles.toggle(null, request(item, false));
        assertTrue(disabled.toString(), disabled.get("success").getAsBoolean());
        assertAttributes(expected, settings);
        JsonObject disabledItem = catalog.scan(null).getAsJsonArray("items").get(0).getAsJsonObject();
        JsonObject enabled = toggles.toggle(null, request(disabledItem, true));
        assertTrue(enabled.toString(), enabled.get("success").getAsBoolean());
        assertAttributes(expected, settings);
        JsonObject restored = com.google.gson.JsonParser.parseString(Files.readString(settings)).getAsJsonObject();
        assertEquals(17, restored.get("unrelated").getAsInt());
        assertEquals("echo marker", restored.getAsJsonObject("hooks").getAsJsonArray("Stop")
                .get(0).getAsJsonObject().get("command").getAsString());
    }

    private Path windowsHome() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Assume.assumeTrue("Windows NTFS attributes require a native NTFS fixture",
                System.getProperty("os.name").startsWith("Windows")
                        && "NTFS".equalsIgnoreCase(Files.getFileStore(home).type()));
        return home;
    }

    private static Attributes customizeAndCapture(Path path) throws Exception {
        AclFileAttributeView acl = Files.getFileAttributeView(path, AclFileAttributeView.class);
        DosFileAttributeView dos = Files.getFileAttributeView(path, DosFileAttributeView.class);
        assertTrue("NTFS ACL view must be available", acl != null);
        assertTrue("NTFS DOS view must be available", dos != null);
        List<AclEntry> original = acl.getAcl();
        List<AclEntry> custom = new ArrayList<>(original);
        custom.add(0, AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(acl.getOwner())
                .setPermissions(AclEntryPermission.READ_ATTRIBUTES, AclEntryPermission.READ_NAMED_ATTRS).build());
        acl.setAcl(custom);
        assertFalse("Fixture must have a genuinely customized ACL", original.equals(acl.getAcl()));
        dos.setHidden(true);
        dos.setSystem(true);
        dos.setArchive(false);
        dos.setReadOnly(false);
        return new Attributes(acl.getOwner(), List.copyOf(acl.getAcl()), dos.readAttributes(), securityDescriptor(path));
    }

    private static void assertAttributes(Attributes expected, Path path) throws Exception {
        AclFileAttributeView acl = Files.getFileAttributeView(path, AclFileAttributeView.class);
        DosFileAttributes dos = Files.getFileAttributeView(path, DosFileAttributeView.class).readAttributes();
        assertEquals("Owner changed", expected.owner(), acl.getOwner());
        assertEquals("Custom ACL changed", expected.acl(), acl.getAcl());
        assertTrue("Windows security descriptor, including inheritance flags, changed",
                expected.securityDescriptor().equals(securityDescriptor(path)));
        assertEquals("Hidden attribute changed", expected.dos().isHidden(), dos.isHidden());
        assertEquals("System attribute changed", expected.dos().isSystem(), dos.isSystem());
        assertEquals("Archive attribute changed", expected.dos().isArchive(), dos.isArchive());
        assertEquals("Read-only attribute changed", expected.dos().isReadOnly(), dos.isReadOnly());
    }

    private static JsonObject request(JsonObject item, boolean enabled) {
        JsonObject request = item.deepCopy();
        request.addProperty("location", item.get("rawLocation").getAsString());
        request.addProperty("expectedRevision", item.get("revision").getAsString());
        request.addProperty("requestId", "windows-attributes-fixture");
        request.addProperty("enabled", enabled);
        return request;
    }

    private static String securityDescriptor(Path path) throws Exception {
        Path script = Path.of("test", "WindowsHookSecurityFixture.ps1").toAbsolutePath();
        Process process = new ProcessBuilder("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass", "-File", script.toString(), "-FixturePath", path.toString())
                .redirectErrorStream(true).start();
        try {
            assertTrue("Security descriptor helper did not exit", process.waitFor(15, TimeUnit.SECONDS));
            assertEquals("Security descriptor helper failed", 0, process.exitValue());
            return new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
                assertTrue(process.waitFor(5, TimeUnit.SECONDS));
            }
        }
    }

    private record Attributes(UserPrincipal owner, List<AclEntry> acl, DosFileAttributes dos, String securityDescriptor) {
    }
}
