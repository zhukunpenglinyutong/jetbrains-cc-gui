package com.github.claudecodegui.pet.office;

import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.util.EnumSet;
import java.util.List;
import java.util.UUID;

final class PetOfficeTestRoot {
    private PetOfficeTestRoot() { }

    static Path create(TemporaryFolder temporary) throws Exception {
        org.junit.Assume.assumeTrue(System.getProperty("os.name").startsWith("Windows"));
        Path root = temporary.newFolder().toPath();
        var owner = Files.getOwner(root, LinkOption.NOFOLLOW_LINKS);
        Files.getFileAttributeView(root, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS).setAcl(List.of(AclEntry.newBuilder()
                .setType(AclEntryType.ALLOW).setPrincipal(owner).setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)
                .setPermissions(EnumSet.allOf(AclEntryPermission.class)).build()));
        return root;
    }

    static PetOfficeModeStore.Member member() {
        var process = ProcessHandle.current();
        return new PetOfficeModeStore.Member(UUID.randomUUID().toString(), process.pid(), process.info().startInstant().orElseThrow().toEpochMilli(), "");
    }
}
