package com.github.claudecodegui.provider.omp;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/** Path resolution of restored writes; POSIX bases must resolve identically on every host OS. */
public class OmpToolMapperPathTest {

    private static final String CWD = "/home/u/proj";

    @Test
    public void relativePathsJoinAndNormalizeWithPosixRulesAgainstAPosixCwd() {
        assertEquals("/home/u/proj/a.txt", OmpToolMapper.absolute("a.txt", CWD, null));
        assertEquals("/home/u/x/b.txt", OmpToolMapper.absolute("../x/./b.txt", CWD, null));
    }

    @Test
    public void aPathEscapingTheRootStaysAsWritten() {
        assertEquals("../../../../x", OmpToolMapper.absolute("../../../../x", CWD, null));
    }

    @Test
    public void absolutePathsStayUntouched() {
        assertEquals("/etc/hosts", OmpToolMapper.absolute("/etc/hosts", CWD, "/home/u"));
        assertEquals("C:\\a\\b.txt", OmpToolMapper.absolute("C:\\a\\b.txt", CWD, "/home/u"));
    }

    @Test
    public void tildeExpandsAgainstAPosixHome() {
        assertEquals("/home/u/x", OmpToolMapper.absolute("~/x", CWD, "/home/u"));
        assertEquals("/home/u", OmpToolMapper.absolute("~", CWD, "/home/u"));
        assertEquals("/home/u/y/z", OmpToolMapper.absolute("~/y/./z", CWD, "/home/u/"));
    }

    @Test
    public void tildeWithoutAUsableHomeStaysAsWritten() {
        assertEquals("~/x", OmpToolMapper.absolute("~/x", CWD, null));
        assertEquals("~/x", OmpToolMapper.absolute("~/x", CWD, ""));
        assertEquals("~", OmpToolMapper.absolute("~", CWD, null));
    }

    @Test
    public void withoutACwdARelativePathStaysAsWritten() {
        assertEquals("a.txt", OmpToolMapper.absolute("a.txt", null, "/home/u"));
    }
}
