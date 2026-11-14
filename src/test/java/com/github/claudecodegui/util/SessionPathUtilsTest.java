package com.github.claudecodegui.util;

import org.junit.Test;
import static org.junit.Assert.*;

public class SessionPathUtilsTest {
    @Test public void normalizesExtendedDrivePrefixesWithEitherSlashForm() {
        assertEquals("C:/Project/Repo", SessionPathUtils.normalize("\\\\?\\C:\\Project\\Repo"));
        assertEquals("c:/Project/Repo", SessionPathUtils.normalize("//?/c:/Project/Repo"));
        assertEquals("c:/project/repo", SessionPathUtils.forComparison("\\\\?\\C:\\Project\\Repo\\"));
    }

    @Test public void normalizesExtendedUncPrefixesWithoutDroppingTheServer() {
        assertEquals("//Server/Share/Repo", SessionPathUtils.normalize("\\\\?\\UNC\\Server\\Share\\Repo"));
        assertEquals("//Server/Share/Repo", SessionPathUtils.normalize("//?/unc/Server/Share/Repo"));
        assertEquals("//server/share/repo", SessionPathUtils.forComparison("//?/UNC/Server/Share/Repo/"));
    }

    @Test public void retainsNormalPathsPosixCaseAndUnsupportedDeviceNamespaces() {
        assertEquals("C:/Project/Repo", SessionPathUtils.normalize("C:\\Project\\Repo"));
        assertEquals("//Server/Share/Repo", SessionPathUtils.normalize("\\\\Server\\Share\\Repo"));
        assertEquals("/linux/Repo", SessionPathUtils.forComparison("/linux/Repo/"));
        assertEquals("//?/Volume{fixture}/Repo", SessionPathUtils.normalize("//?/Volume{fixture}/Repo"));
        assertEquals("//./pipe/fixture", SessionPathUtils.normalize("\\\\.\\pipe\\fixture"));
        assertEquals("", SessionPathUtils.normalize(null));
    }
}
