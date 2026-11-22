# Windows MCP launch and refresh

The STDIO verifier and tool reader resolve extensionless Windows commands by
listing the absolute `PATH` directories in order and taking the first name that
matches an executable `PATHEXT` extension (`.exe`, `.bat`, `.cmd`). Node's file
APIs keep non-ASCII paths such as `C:\Users\张三\...` intact, unlike `where.exe`
output in the console code page. Relative `PATH` entries are skipped. Each
directory is listed once, concurrent lookups share a listing still in flight,
and a lookup stops after five seconds, so an offline share cannot stall
verification or tie up more than one file-system thread. When nothing is found,
the configured command is launched as before.

Native executables run without a shell. Batch shims quote the executable and
each argument so spaces and parentheses remain intact; trailing backslashes are
doubled so the closing quote is not read as an escaped quote. Programs behind
`%*` receive the original value; a batch file that reads `%~1` itself sees the
doubled backslash, which Windows paths tolerate. Shell chaining, expansion and
quote syntax are rejected before a batch launch, including in the resolved
`PATH` entry. The error names only the refused character, never the argument,
and suggests passing such values through `env`.

Full refresh clears tool caches, reloads the server catalog and connection
status, and waits for the new catalog before requesting tools for the single
expanded, enabled card. A plain catalog reload does not cancel a pending
refresh. Deleted and disabled servers are not queried. The persistent Codex
app-server remains the source of Codex status and tools.

## Coverage

The Windows-only test in `process-launcher.test.js` creates real `.cmd` shims
in a directory whose name contains spaces and Chinese characters. It launches
them through both status verification and tools/list, as an explicit path and
as a bare command found only through `PATH` (the server runs from a different
working directory). It checks that spaces, parentheses, an empty argument and a
trailing backslash reach the server unchanged. No external MCP service or live
account is required.
