package com.github.claudecodegui.model;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.github.claudecodegui.util.LogSanitizer;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.intellij.openapi.diagnostic.Logger;
import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;
import org.snakeyaml.engine.v2.exceptions.MarkedYamlEngineException;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Frontmatter parser for Claude Code subagent files ({@code agents/*.md}).
 *
 * <p>Exists because {@code SkillFrontmatterParser} is the wrong shape for this
 * job, in ways that are invisible until you point it at a real directory. A sweep
 * of the developer's {@code ~/.claude/agents} found 274 files, of which:
 *
 * <ul>
 *   <li><b>122 have no frontmatter at all</b> — they are reference notes parked
 *       in the directory. The skill parser returns {@code null} for these, which a
 *       caller cannot distinguish from a read failure.</li>
 *   <li><b>39 of the 152 that do have frontmatter have no {@code name}</b>.</li>
 *   <li>Three different {@code tools} encodings are in use (block list,
 *       comma-separated string, JSON array literal).</li>
 *   <li>The largest frontmatter is 2082 bytes; the largest body is ~49 KB, and
 *       agent system prompts are routinely hundreds of kilobytes.</li>
 * </ul>
 *
 * <h2>How this differs from {@code SkillFrontmatterParser}</h2>
 *
 * <p><b>Carried over</b> — all four rules hold, for the same reasons:
 *
 * <ul>
 *   <li><b>snakeyaml-engine with aliases disabled.</b> A YAML alias is a billion-laughs
 *       vector; a frontmatter block is not a place that needs one.</li>
 *   <li><b>The opening delimiter must be at the start of the file</b> (modulo a
 *       byte-order mark, see below). This is the one rule that changes the verdict
 *       from a warning to a refusal, and it is a refusal because the alternative is
 *       guessing: a file that opens with prose is a reference note (122 of 274), and
 *       scanning an arbitrary markdown body for a delimiter is unbounded work.</li>
 *   <li><b>A size limit, but a different one.</b> The skill parser uses snakeyaml's
 *       8192-<em>codepoint</em> limit. Codepoints are the wrong unit for a decision
 *       about how much to buffer, and 8192 is tight for an agent: the largest real
 *       block is 2082 bytes, but {@code tools} block lists of MCP tool names grow
 *       fast. The limit here is
 *       {@value #DEFAULT_MAX_FRONTMATTER_BYTES} <em>bytes</em>, enforced by
 *       {@link InputStream#mark(int)} on the stream rather than by the YAML engine,
 *       so it bounds memory before the parser ever sees the text.</li>
 *   <li><b>YAML aliases rejected rather than expanded</b> — same
 *       {@code setMaxAliasesForCollections(0)} call.</li>
 * </ul>
 *
 * <p><b>Deliberately not carried over</b>:
 *
 * <ul>
 *   <li><b>Reading the whole file with {@code Files.readString}.</b> The skill
 *       parser does this twice per file ({@code extractFrontmatter} and
 *       {@code extractFirstParagraph}). Here the body may be hundreds of kilobytes
 *       and there are hundreds of files, so the read is streamed and abandoned at
 *       the closing delimiter — see {@link #extractFrontmatter}.</li>
 *   <li><b>A silent {@code null} return.</b> Every failure is a
 *       {@link Result} with a {@link Status} and a human-readable
 *       {@link Result#warning()}, because PRD AC3 requires the UI to say
 *       <em>why</em> something did not load.</li>
 *   <li><b>Falling back to the directory name for an invalid name.</b> A skill
 *       lives in its own directory, so the directory name is a free fallback. An
 *       agent is a single file whose stem is <em>already</em> the fallback — using
 *       the same string twice would make the two indistinguishable. Here an
 *       invalid name refuses the file, and the offending name is still reported.</li>
 *   <li><b>Re-deriving the description from the body's first paragraph.</b> That
 *       fallback exists because a skill's description is optional. Here it would
 *       mean reading the body, which is the thing this parser exists to avoid.</li>
 *   <li><b>A fixed, non-loadable null for the whole file.</b> Unknown fields are
 *       preserved rather than filtered: the specification is still growing
 *       ({@code effort}, {@code isolation}, {@code memory} are recent), and
 *       filtering would truncate a newer file on a read/write round trip.</li>
 * </ul>
 *
 * <h2>Bounded reading</h2>
 *
 * <p>{@link #extractFrontmatter} reads line by line through a
 * {@link BoundedInputStream} and returns the instant the closing delimiter is
 * seen, so the remaining bytes are never touched. A file whose frontmatter is 60
 * bytes costs 60 bytes of I/O whether its body is 60 bytes or 6 MB. When the
 * budget runs out before a closing delimiter, the file is refused — the bound is
 * enforced by the stream reporting EOF, so no amount of caller carelessness can
 * turn an unterminated block into a full-file scan.
 *
 * <p>The one shape this does <em>not</em> fully protect against is a file whose
 * content is a single line with no newline at all (a minified document): no
 * line-based reader can bound that, and the byte budget is what catches it.
 */
public final class SubagentFrontmatterParser {

    private static final Logger LOG = Logger.getInstance(SubagentFrontmatterParser.class);

    /**
     * Upper bound on the frontmatter block, in bytes.
     *
     * <p>30x the largest block measured in the field ({@code github-inbox.md},
     * 2082 bytes), which leaves room for an agent listing every MCP tool it may
     * call — {@code codebase-memory-auditor.md} already lists 13. Byte length
     * rather than codepoints because the decision is about buffering, and because
     * {@link InputStream#mark(int)} is specified in bytes.
     */
    public static final int DEFAULT_MAX_FRONTMATTER_BYTES = 64 * 1024;

    /**
     * The YAML engine's own codepoint cap, kept as a second line of defence.
     *
     * <p>Raised from the skill parser's 8192 to 16384: the byte budget above is
     * the real limit, and leaving a tighter codepoint cap underneath it would
     * reject a legal 20 KB block with an opaque "code point limit exceeded".
     */
    private static final int YAML_CODEPOINT_LIMIT = 16384;

    /** The bytes {@code ---} occupies, and the minimum run a delimiter needs. */
    private static final int DELIMITER_LENGTH = 3;

    /**
     * File names that are documentation or another Claude Code artifact rather
     * than an agent.
     *
     * <p>{@code README.md} and {@code SKILL.md} both sit in real
     * {@code ~/.claude/agents} directories on the developer's machine and neither
     * is an agent. {@code SKILL.md} is the interesting one: it <em>does</em> carry
     * valid frontmatter, and its {@code name} is {@code workflow-patterns}, which
     * collides with the real {@code workflow-patterns.md} beside it. Accepting it
     * would make two different artifacts fight over one name, so the scanner skips
     * it by filename. The parser stays format-driven and only exposes this
     * predicate so the scanner and the tests can agree on the rule in one place.
     */
    private static final Set<String> RESERVED_NON_AGENT_FILENAMES = Set.of(
            "readme.md",
            "skill.md",
            "claude.md",
            "agents.md",
            "changelog.md",
            "license.md",
            "contributing.md");

    private SubagentFrontmatterParser() {
    }

    /**
     * Why a parse ended the way it did.
     *
     * <p>{@link #isLoadable()} is the only method callers need in the common path:
     * a non-loadable status still carries a name and a warning, so the entry can be
     * surfaced with an explanation rather than dropped (PRD R4).
     */
    public enum Status {

        /** Frontmatter found, valid, and carrying at least a usable name. */
        PARSED,

        /**
         * The file does not start with a frontmatter delimiter. Not an error:
         * 122 of the 274 real files are reference notes, and Claude Code ignores
         * them too. The scanner should skip the file quietly.
         */
        NO_FRONTMATTER,

        /**
         * A block was present but nothing in it can be trusted: unterminated,
         * empty, invalid YAML, oversized, or not a mapping. The scanner should
         * surface it with {@link Result#warning()}.
         */
        UNPARSEABLE;

        /**
         * Whether this result may be turned into an agent entry.
         *
         * @return true only for {@link #PARSED}
         */
        public boolean isLoadable() {
            return this == PARSED;
        }
    }

    /**
     * The outcome of a parse. Never null, and never obtained via an exception:
     * discovery runs over hundreds of files on a background path, so one broken
     * file must not abort the sweep.
     *
     * @param status  why the parse ended as it did
     * @param name    the agent name, the file stem when frontmatter omits it, and
     *                the raw declared name even when that name is invalid
     * @param fields  every frontmatter key converted to JSON, unknown keys
     *                included; empty when nothing could be read
     * @param warning a human-readable cause, or null when there is nothing to say
     * @param path    the file that was read, or null for a null path
     */
    public record Result(
            Status status,
            String name,
            JsonObject fields,
            String warning,
            Path path,
            Integer warningLine
    ) {
        /**
         * A result with no known position.
         *
         * <p>Most failures are not positional — a file with no frontmatter, a
         * name that breaks the specification — and naming a line for those would
         * send the user somewhere that has nothing to do with the problem.
         *
         * @param status  why the parse ended as it did
         * @param name    the agent name
         * @param fields  the frontmatter that could be read
         * @param warning the cause, or null
         * @param path    the file that was read
         */
        public Result(Status status, String name, JsonObject fields, String warning, Path path) {
            this(status, name, fields, warning, path, null);
        }
        /**
         * Whether this result may be turned into an agent entry.
         *
         * @return true when the frontmatter parsed
         */
        public boolean isLoadable() {
            return status.isLoadable();
        }
    }

    // ------------------------------------------------------------------
    // Entry points
    // ------------------------------------------------------------------

    /**
     * Parse an agent file using the default frontmatter budget.
     *
     * @param file the {@code agents/*.md} file
     * @return a result describing what was found; never null, never throwing
     */
    public static Result parse(Path file) {
        return parse(file, DEFAULT_MAX_FRONTMATTER_BYTES);
    }

    /**
     * Parse an agent file with an explicit frontmatter budget.
     *
     * @param file     the {@code agents/*.md} file
     * @param maxBytes the largest frontmatter block to accept, in bytes
     * @return a result describing what was found; never null, never throwing
     */
    public static Result parse(Path file, int maxBytes) {
        if (file == null) {
            return new Result(Status.NO_FRONTMATTER, "", new JsonObject(),
                    "no path given", null);
        }
        String stem = stemOf(file);
        if (!Files.isRegularFile(file)) {
            return new Result(Status.NO_FRONTMATTER, stem, new JsonObject(),
                    "not a readable file: " + file, file);
        }
        try (InputStream in = Files.newInputStream(file)) {
            return parse(in, stem, maxBytes, file);
        } catch (IOException e) {
            // A file that vanished between the scan and the read, or a permission
            // problem. Reported, never thrown.
            // The file name is attacker-controlled — an agent file can arrive
            // from a cloned repository — so the name is escaped. The throwable
            // is NOT passed: its message repeats the same path in the clear and
            // the stack trace is printed verbatim, which would undo the escaping
            // beside it. The exception class is the part that says anything
            // about what went wrong; the path is already on the line above.
            LOG.debug("Failed to open subagent file: "
                    + LogSanitizer.sanitize(file.toString())
                    + " (" + e.getClass().getSimpleName() + ")");
            return new Result(Status.NO_FRONTMATTER, stem, new JsonObject(),
                    "could not read file: " + file, file);
        }
    }

    /**
     * Parse an agent file already open as a stream. The stream is read only as far
     * as the closing delimiter and is not closed by this method.
     *
     * <p>Overload used by the bounded-read tests, and by any caller that already
     * holds a stream (a zip entry, for instance).
     *
     * @param in        the stream positioned at the start of the file
     * @param fileName  the file name, used only for the stem fallback and messages
     * @param maxBytes  the largest frontmatter block to accept, in bytes
     * @return a result describing what was found; never null, never throwing
     */
    public static Result parse(InputStream in, String fileName, int maxBytes) {
        return parse(in, fileName, maxBytes, null);
    }

    private static Result parse(InputStream in, String fileName, int maxBytes, Path path) {
        String stem = stemOfName(fileName);
        if (in == null) {
            return new Result(Status.NO_FRONTMATTER, stem, new JsonObject(),
                    "no stream given", path);
        }
        int budget = Math.max(DELIMITER_LENGTH + 1, maxBytes);

        Extraction extraction;
        try {
            extraction = extractFrontmatter(in, budget);
        } catch (IOException e) {
            // Same reason as above: the IOException's message carries the path
            // unescaped, and passing it would reinstate the forging path.
            LOG.debug("Failed to read subagent frontmatter: "
                    + LogSanitizer.sanitize(fileName)
                    + " (" + e.getClass().getSimpleName() + ")");
            return new Result(Status.NO_FRONTMATTER, stem, new JsonObject(),
                    "could not read file: " + fileName, path);
        }

        if (extraction.error() != null) {
            // The block was opened but could not be closed. lastLine is where
            // reading stopped, which is the line where the closing --- was due —
            // a usable place to send someone who wants to fix it.
            return new Result(Status.UNPARSEABLE, stem, new JsonObject(),
                    extraction.error(), path, extraction.lastLine());
        }
        if (extraction.yaml() == null) {
            return new Result(Status.NO_FRONTMATTER, stem, new JsonObject(),
                    "no YAML frontmatter at the start of " + fileName
                            + " (expected a line containing only ---);"
                            + " files without frontmatter are not Claude Code subagents",
                    path, null);
        }
        if (extraction.yaml().isEmpty()) {
            return new Result(Status.UNPARSEABLE, stem, new JsonObject(),
                    "frontmatter block in " + fileName + " is empty",
                    path, extraction.lastLine());
        }

        Map<String, Object> yamlMap;
        try {
            yamlMap = loadMapping(extraction.yaml());
        } catch (StackOverflowError e) {
            // A deeply nested YAML document makes snakeyaml recurse in its
            // parser until the stack is gone — the size limits do not help,
            // because 3000 levels of "[[[" is under 6 KB and therefore passes
            // both of them. StackOverflowError is an Error, so a
            // `catch (Exception)` here lets it straight through, and it would
            // then unwind the whole discovery sweep and leave the settings tab
            // with no agents at all. One file from a cloned repository would be
            // enough to do that, so the file is treated as unusable and the
            // sweep continues.
            // The nesting is not localised to a line, so the block as a whole is
            // the thing to point at.
            return new Result(Status.UNPARSEABLE, stem, new JsonObject(),
                    "frontmatter of " + fileName + " is nested too deeply to parse",
                    path, extraction.lastLine());
        } catch (Exception e) {
            // snakeyaml raises a zoo of exception types for malformed input
            // (YAMLException, plus RuntimeExceptions from code-point limits), so
            // the broad catch is deliberate: the contract is that this method does
            // not throw. The declared name is salvaged from the raw text below so
            // the entry does not vanish without a trace.
            String rawName = salvageName(extraction.yaml());
            // The mark names the exact offending line, which is more useful than
            // where reading stopped; it falls back to that when the exception
            // carries no mark, which is the case for a plain codepoint-limit
            // refusal.
            Integer line = yamlProblemLine(e);
            return new Result(Status.UNPARSEABLE, rawName.isEmpty() ? stem : rawName,
                    new JsonObject(),
                    "invalid YAML in the frontmatter of " + fileName + ": "
                            + rootMessage(e), path,
                    line != null ? line : extraction.lastLine());
        }

        return build(extraction, yamlMap, stem, fileName, path);
    }

    // ------------------------------------------------------------------
    // Bounded extraction
    // ------------------------------------------------------------------

    /**
     * What {@link #extractFrontmatter} found: either the YAML text, or a reason it
     * is absent, or a reason it is unusable. Exactly one of {@code yaml} and
     * {@code error} is non-null, except that both may be null to mean "no
     * frontmatter here, and that is fine".
     *
     * @param yaml   the block between the delimiters, or null
     * @param error  why the block is unusable, or null
     * @param hadBom whether a byte-order mark preceded the opening delimiter
     * @param lastLine the 1-based file line the block occupied, so an extraction
     *                 failure can point at where reading stopped rather than
     *                 only saying what went wrong
     */
    private record Extraction(String yaml, String error, boolean hadBom, int lastLine) {
    }

    /**
     * Read the frontmatter block and stop.
     *
     * <p>Reads line by line and returns the instant the closing delimiter is seen,
     * so a 6 MB body costs the same as a 6 KB one. The stream itself enforces the
     * budget: {@link BoundedInputStream} reports EOF once {@code maxBytes} have
     * been pulled, which means an unterminated block in a 49 KB body cannot turn
     * into an unbounded scan — the scan simply runs out of budget and the file is
     * refused.
     *
     * @param in       the stream to read
     * @param maxBytes the largest frontmatter region to accept, in bytes
     * @return what was found
     * @throws IOException if the stream itself fails mid-read
     */
    private static Extraction extractFrontmatter(InputStream in, int maxBytes) throws IOException {
        BoundedInputStream bounded = new BoundedInputStream(in, maxBytes);

        // A UTF-8 BOM is tolerated. Windows editors add one silently, and insisting
        // on byte 0 being '-' would drop those agents for a reason no user could
        // see. Everything else at the start is a refusal, not a warning.
        boolean hadBom = skipBom(bounded);

        // 1-based file line, tracked so a failure can point somewhere. The
        // opening delimiter is line 1, which is why the block below starts at 2
        // and why a YAML mark of 0 means file line 2.
        int lineNumber = 0;

        String opening = readLine(bounded);
        lineNumber++;
        if (bounded.limitReached() && opening == null) {
            return oversize(maxBytes, lineNumber);
        }
        if (opening == null || !isDelimiterLine(opening)) {
            return new Extraction(null, null, hadBom, lineNumber);
        }

        StringBuilder yaml = new StringBuilder();
        for (; ; ) {
            String line = readLine(bounded);
            if (line != null) {
                lineNumber++;
            }
            if (line == null) {
                if (bounded.limitReached()) {
                    return oversize(maxBytes, lineNumber);
                }
                // Real EOF with no closing delimiter. The block may well have been
                // intended, so this is an error rather than "no frontmatter".
                // The line reported is where reading stopped, which is the end of
                // the block -- the point where a closing --- was expected.
                return new Extraction(null,
                        "unterminated frontmatter: the block opened with --- but no"
                                + " closing delimiter (a line containing only ---)"
                                + " was found in the first " + bounded.count() + " bytes",
                        hadBom, lineNumber);
            }
            if (isDelimiterLine(line)) {
                // The budget may have run out while this very line was being read:
                // readLine stops at EOF and hands back a partial line, and a
                // delimiter we could not see terminated is not a delimiter. Without
                // this check the cap is not binding at the exact boundary -- one
                // byte short of the region would still parse as a clean file.
                if (bounded.limitReached()) {
                    return oversize(maxBytes, lineNumber);
                }
                return new Extraction(yaml.toString().strip(), null, hadBom, lineNumber);
            }
            // Budget the accumulated block as well, so a file made of many small
            // lines cannot exceed the cap while the byte counter still looks low.
            if (yaml.length() + line.length() + 1 > maxBytes) {
                return oversize(maxBytes, lineNumber);
            }
            yaml.append(line).append('\n');
        }
    }

    /**
     * Refuse a block that outgrew the budget, naming the limit so the user can tell
     * a resource guard from a syntax error.
     */
    private static Extraction oversize(int maxBytes, int lastLine) {
        return new Extraction(null,
                "frontmatter exceeds the " + maxBytes + "-byte read limit and was not"
                        + " parsed; real agent frontmatter is far smaller"
                        + " (the largest on the developer's machine is 2082 bytes)",
                false, lastLine);
    }

    /**
     * Read one line, or null at end of input.
     *
     * <p>A line with no trailing newline is still returned — an agent file whose
     * closing delimiter is the very last line is legal. Carriage returns are
     * dropped so a CRLF file needs no special case downstream; the byte budget
     * counts what was read, not what was stored.
     *
     * @param in the bounded stream
     * @return the line, or null when the input ended before any byte
     * @throws IOException if the stream fails
     */
    private static String readLine(BoundedInputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        // Decoded rather than cast byte-by-byte: casting a raw byte to char
        // shreds any multi-byte UTF-8 sequence, and agent descriptions are full
        // of them (arrows, emoji, accented letters). A mangled multi-byte
        // sequence is not merely cosmetic -- it can land as a YAML control
        // character and make the whole frontmatter unparsable.
        int b = -1;
        while ((b = in.read()) != -1) {
            if (b == '\n') {
                break;
            }
            if (b == '\r') {
                continue;
            }
            // -1 when the byte is not a valid lead byte, which can only happen
            // for a stray continuation byte; the replacement character keeps the
            // line parsable instead of aborting the sweep.
            line.appendCodePoint(utf8SequenceLength(b) < 0 ? 0xFFFD : codePoint(in, b));
        }
        if (b == -1 && line.isEmpty()) {
            return null;
        }
        return line.toString();
    }

    /**
     * How many bytes the UTF-8 sequence starting at {@code b} occupies.
     *
     * @return the sequence length, or -1 when {@code b} cannot start one
     */
    private static int utf8SequenceLength(int b) {
        if (b < 0) {
            return -1;
        }
        if ((b & 0x80) == 0) {
            return 1;
        }
        if ((b & 0xE0) == 0xC0) {
            return 2;
        }
        if ((b & 0xF0) == 0xE0) {
            return 3;
        }
        if ((b & 0xF8) == 0xF0) {
            return 4;
        }
        return -1;
    }

    /**
     * Read the rest of a UTF-8 sequence whose lead byte has already been consumed.
     *
     * <p>A truncated sequence at the end of the stream yields U+FFFD rather than
     * an exception: a half-written line is a cosmetic problem here, whereas a
     * thrown IOException would abort discovery over every remaining file.
     *
     * @param in       the stream, positioned after the lead byte
     * @param leadByte the lead byte already read
     * @return the decoded code point
     * @throws IOException if the stream fails
     */
    private static int codePoint(BoundedInputStream in, int leadByte) throws IOException {
        int length = utf8SequenceLength(leadByte);
        if (length <= 1) {
            return leadByte;
        }
        int value = leadByte & (0x7F >> length);
        for (int i = 1; i < length; i++) {
            int next = in.read();
            if (next == -1 || (next & 0xC0) != 0x80) {
                return 0xFFFD;
            }
            value = (value << 6) | (next & 0x3F);
        }
        return value;
    }

    /**
     * Check whether a line is a frontmatter delimiter.
     *
     * <p>A run of three or more dashes, optionally followed by a comment. Requiring
     * the dashes to own the line is the fix for a bug the skill parser has: it
     * searches for {@code "\n---"} without looking at what follows, so a content
     * line such as {@code description: Contains --- inline} can end the block
     * early and hand the YAML parser a fragment.
     *
     * @param line the line, already stripped of its line ending
     * @return true when the line is a delimiter
     */
    private static boolean isDelimiterLine(String line) {
        String stripped = line.strip();
        int i = 0;
        while (i < stripped.length() && stripped.charAt(i) == '-') {
            i++;
        }
        if (i < DELIMITER_LENGTH) {
            return false;
        }
        String rest = stripped.substring(i).strip();
        return rest.isEmpty() || rest.startsWith("#");
    }

    /**
     * Skip a leading UTF-8 byte-order mark, if any.
     *
     * @param in the stream, which supports a small pushback
     * @return true when a BOM was consumed
     * @throws IOException if the stream fails
     */
    private static boolean skipBom(BoundedInputStream in) throws IOException {
        int b1 = in.read();
        if (b1 != 0xEF) {
            // Not a BOM, and b1 is a real byte the caller still needs: for an
            // ordinary subagent file it is the first '-'. Handing it straight back
            // is what keeps the delimiter intact -- returning early without the
            // pushback silently turns "---" into "--" and no agent parses at all.
            if (b1 != -1) {
                in.unread(b1);
            }
            return false;
        }
        int b2 = in.read();
        int b3 = in.read();
        if (b2 == 0xBB && b3 == 0xBF) {
            return true;
        }
        // Not a BOM after all. A stream cannot seek, so the bytes are given back.
        // Only this one branch needs the pushback, which is why it is three bytes
        // wide rather than a general rewind window.
        if (b3 != -1) {
            in.unread(b3);
        }
        if (b2 != -1) {
            in.unread(b2);
        }
        if (b1 != -1) {
            in.unread(b1);
        }
        return false;
    }

    // ------------------------------------------------------------------
    // YAML
    // ------------------------------------------------------------------

    /**
     * Load the block as a YAML mapping.
     *
     * <p>Aliases are disabled: a frontmatter block has no legitimate use for one
     * and a billion-laughs expansion is the classic YAML denial of service. The
     * codepoint cap is a second line of defence behind the byte budget, set well
     * above it so a legal block never trips the less informative message.
     *
     * @param yaml the block text
     * @return the mapping
     * @throws Exception if the text is not a loadable YAML mapping
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> loadMapping(String yaml) throws Exception {
        LoadSettings settings = LoadSettings.builder()
                .setMaxAliasesForCollections(0)
                .setCodePointLimit(YAML_CODEPOINT_LIMIT)
                .build();
        Object parsed = new Load(settings).loadFromString(yaml);
        if (parsed == null) {
            throw new IllegalArgumentException("frontmatter block is empty or only comments");
        }
        if (!(parsed instanceof Map)) {
            throw new IllegalArgumentException(
                    "frontmatter must be a YAML mapping, found " + parsed.getClass().getSimpleName());
        }
        return (Map<String, Object>) parsed;
    }

    /**
     * Best-effort name recovery from a block that failed to parse.
     *
     * <p>Used so that a file with one typo still surfaces under the name its author
     * intended instead of under a stem that looks like a filename accident. A
     * single-line {@code name:} is the only form attempted, because anything more
     * elaborate would be guessing at YAML that just failed to parse.
     *
     * @param yaml the block text
     * @return the unquoted name, or an empty string
     */
    private static String salvageName(String yaml) {
        for (String line : yaml.split("\n", 24)) {
            if (line.startsWith("name:")) {
                String value = line.substring("name:".length()).trim();
                if (value.startsWith("\"") && value.endsWith("\"") && value.length() > 1) {
                    value = value.substring(1, value.length() - 1);
                } else if (value.startsWith("'") && value.endsWith("'") && value.length() > 1) {
                    value = value.substring(1, value.length() - 1);
                }
                return value.trim();
            }
        }
        return "";
    }

    /**
     * The 1-based file line a YAML failure points at, or null when it points
     * nowhere.
     *
     * <p>snakeyaml counts from 0 within the block it was handed, and the block
     * begins on file line 2 — the opening {@code ---} is line 1 — so the two
     * differ by exactly 2. The offset is verified against duplicate-key,
     * unterminated-sequence and bad-indent failures.
     *
     * <p>The whole cause chain is walked, because the mark usually sits on the
     * wrapper rather than the exception that names the problem.
     */
    private static Integer yamlProblemLine(Throwable t) {
        Throwable current = t;
        while (current != null) {
            if (current instanceof MarkedYamlEngineException marked) {
                Integer line = marked.getProblemMark().map(mark -> mark.getLine() + 2).orElse(null);
                if (line != null) {
                    return line;
                }
            }
            Throwable cause = current.getCause();
            current = cause == current ? null : cause;
        }
        return null;
    }

    /**
     * The innermost cause of a YAML failure, which is the part that names the
     * actual problem rather than the wrapper.
     */
    private static String rootMessage(Throwable t) {
        Throwable root = t;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        String message = root.getMessage();
        if (message == null || message.isBlank()) {
            message = root.getClass().getSimpleName();
        }
        // snakeyaml reports a line and column prefix; keep it, it is the useful part.
        message = message.replaceAll("\\s*\\R\\s*", " ").trim();
        return message.length() > 300 ? message.substring(0, 300) + "..." : message;
    }

    // ------------------------------------------------------------------
    // Field conversion
    // ------------------------------------------------------------------

    /**
     * Turn the parsed mapping into a loadable result, or refuse it.
     */
    private static Result build(Extraction extraction, Map<String, Object> yamlMap,
                                String stem, String fileName, Path path) {
        List<String> warnings = new ArrayList<>();
        if (extraction.hadBom()) {
            warnings.add("the file starts with a byte-order mark, which was skipped");
        }

        JsonObject fields = new JsonObject();
        for (Map.Entry<String, Object> entry : yamlMap.entrySet()) {
            String key = entry.getKey();
            if (key == null) {
                continue;
            }
            // Unknown keys are kept on purpose: the specification is still
            // growing, and dropping them would truncate a newer file on a
            // read/write round trip. Only the *shape* of known list-ish fields
            // is normalised.
            JsonElement value = toJson(entry.getValue());
            if (LIST_LIKE_FIELDS.contains(key)) {
                value = normalizeStringList(value);
            }
            fields.add(key, value);
        }

        Object nameValue = yamlMap.get("name");
        String declared = nameValue == null ? null : String.valueOf(nameValue).trim();

        if (declared == null || declared.isEmpty()) {
            // 39 of the 152 real files with frontmatter have no name key. Dropping
            // them would be the silent loss PRD R4 forbids, so the file stem stands
            // in and says so. The same applies to a name that parses to a non-scalar.
            String reason = declared == null
                    ? "frontmatter has no name field"
                    : "frontmatter has an empty name field";
            warnings.add(reason + "; using the file name \"" + stem + "\" instead");
            return new Result(Status.PARSED, stem, fields, join(warnings), path);
        }

        if (!AgentFields.isValidName(declared)) {
            // The one character the specification forbids, because it is reserved
            // for plugin-scoped ids like "my-plugin:reviewer". Refuse, but keep the
            // offending name in the result so the entry is visible and explainable
            // rather than vanished.
            warnings.add("name \"" + declared + "\" is not a valid agent name"
                    + " (a colon is reserved for plugin-scoped identifiers); the file was not loaded");
            return new Result(Status.UNPARSEABLE, declared, fields, join(warnings), path);
        }

        if (AgentFields.isNonHyphenCaseName(declared)) {
            // Task 56's decision: a warning, never a rejection. The specification
            // documents no hyphen-case constraint, and real stores contain names
            // like "New Agent".
            warnings.add("name \"" + declared + "\" is not hyphen-case"
                    + " (the specification's examples use e.g. \"code-reviewer\");"
                    + " it still works");
        }

        // The name is normalised into the payload so the UI does not have to
        // re-derive it, but the field map itself keeps the raw declared value.
        fields.addProperty("name", declared);

        return new Result(Status.PARSED, declared, fields, join(warnings), path);
    }

    /**
     * Fields that the specification models as string lists but that authors write
     * in several YAML shapes. Everything else keeps whatever type it parsed as.
     */
    private static final Set<String> LIST_LIKE_FIELDS = Set.of(
            "tools",
            "disallowedTools",
            "skills",
            "mcpServers");

    private static String join(List<String> warnings) {
        return warnings.isEmpty() ? null : String.join("; ", warnings);
    }

    /**
     * Normalise a list-shaped field to a JSON array of strings.
     *
     * <p>Three encodings are in real use across the developer's 274 files:
     * a YAML block list, a flow sequence ({@code [a, b]} and
     * {@code ["a", "b"]} are the same thing to YAML), and a comma-separated
     * string. The third is not valid YAML for a list but is what half the real
     * agents contain, so a scalar is split on commas rather than being wrapped
     * whole — otherwise {@code tools: Read, Grep} would become a single tool
     * literally named "Read, Grep".
     *
     * <p>Splitting is deliberately naive: tool names never contain commas, and
     * guessing at quoting rules would be a more likely source of error than the
     * problem it solves.
     */
    private static JsonElement normalizeStringList(JsonElement value) {
        if (value == null || value.isJsonNull()) {
            return new JsonArray();
        }
        if (value.isJsonArray()) {
            JsonArray out = new JsonArray();
            for (JsonElement item : value.getAsJsonArray()) {
                String text = asText(item);
                if (text != null) {
                    out.add(text);
                }
            }
            return out;
        }
        if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
            JsonArray out = new JsonArray();
            for (String part : value.getAsString().split(",")) {
                String trimmed = unquote(part.trim());
                if (!trimmed.isEmpty()) {
                    out.add(trimmed);
                }
            }
            return out;
        }
        if (value.isJsonObject()) {
            // mcpServers may be an inline map of definitions rather than names.
            // It is already the right shape; hand it back untouched.
            return value;
        }
        String single = asText(value);
        JsonArray out = new JsonArray();
        if (single != null && !single.isEmpty()) {
            out.add(single);
        }
        return out;
    }

    private static String unquote(String value) {
        if (value.length() > 1
                && ((value.startsWith("\"") && value.endsWith("\""))
                || (value.startsWith("'") && value.endsWith("'")))) {
            return value.substring(1, value.length() - 1).trim();
        }
        return value;
    }

    private static String asText(JsonElement element) {
        if (element == null || element.isJsonNull()) {
            return null;
        }
        if (element.isJsonPrimitive()) {
            return element.getAsString();
        }
        // A nested structure inside a list field is kept as JSON rather than
        // stringified, so a caller that expects objects (mcpServers entries) gets
        // them and a caller that does not can still render the element.
        return element.toString();
    }

    /**
     * Convert an arbitrary snakeyaml value to GSON, preserving structure.
     *
     * <p>Maps keep key order, sequences stay arrays, scalars become primitives. A
     * {@code null} scalar becomes a JSON null rather than the string "null", which
     * is the difference between "explicitly empty" and "the word null".
     */
    private static JsonElement toJson(Object value) {
        if (value == null) {
            return JsonNull.INSTANCE;
        }
        if (value instanceof Map<?, ?> map) {
            JsonObject obj = new JsonObject();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                String key = String.valueOf(entry.getKey());
                obj.add(key, toJson(entry.getValue()));
            }
            return obj;
        }
        if (value instanceof List<?> list) {
            JsonArray array = new JsonArray();
            for (Object item : list) {
                array.add(toJson(item));
            }
            return array;
        }
        if (value instanceof Set<?> set) {
            JsonArray array = new JsonArray();
            for (Object item : set) {
                array.add(toJson(item));
            }
            return array;
        }
        if (value instanceof Boolean b) {
            return new JsonPrimitive(b);
        }
        if (value instanceof Number n) {
            return new JsonPrimitive(n);
        }
        if (value instanceof Character c) {
            return new JsonPrimitive(String.valueOf(c));
        }
        return new JsonPrimitive(String.valueOf(value));
    }

    // ------------------------------------------------------------------
    // Names and file names
    // ------------------------------------------------------------------

    /**
     * Check whether a file name is one of the reserved documentation or
     * sibling-artifact names that live in an agents directory but are not agents.
     *
     * <p>Exposed so the scanner applies the rule in exactly one place. The parser
     * itself does not consult it: this predicate is about a <em>file name</em>,
     * which the parser is deliberately not allowed to interpret, while parsing is
     * about a <em>block of metadata</em>.
     *
     * @param fileName the file name, extension included
     * @return true when the name is reserved and the file is not an agent
     */
    public static boolean isReservedNonAgentFilename(String fileName) {
        if (fileName == null) {
            return false;
        }
        return RESERVED_NON_AGENT_FILENAMES.contains(fileName.toLowerCase(Locale.ROOT));
    }

    private static String stemOf(Path file) {
        String name = file.getFileName() == null ? "" : file.getFileName().toString();
        return stemOfName(name);
    }

    /**
     * The file name without its extension, used as the name fallback.
     */
    private static String stemOfName(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return "";
        }
        int dot = fileName.lastIndexOf('.');
        String stem = dot > 0 ? fileName.substring(0, dot) : fileName;
        return stem.trim();
    }

    /**
     * A stream wrapper that enforces the read budget, counts what it hands out, and
     * offers a three-byte pushback.
     *
     * <p>The budget is the whole point. Once {@code limit} bytes have been pulled
     * from the delegate the wrapper reports EOF, so a caller that keeps reading
     * past the end of a frontmatter block is stopped by the stream rather than by
     * its own bookkeeping — there is no way to forget to check. That is what keeps
     * an unterminated block inside a 49 KB markdown body from becoming a full-file
     * scan.
     *
     * <p>The pushback exists only so a non-BOM first byte can be re-examined after
     * the {@code 0xEF 0xBB 0xBF} probe; three bytes is exactly what that probe
     * consumes, and a general rewind window would be a buffer nobody uses.
     */
    private static final class BoundedInputStream extends InputStream {

        private final InputStream delegate;
        private final int limit;

        private long count;
        private boolean truncated;

        /** Pushback slots, used only by {@link #unread(int)}. */
        private final int[] pushback = new int[3];
        private int pushbackSize;

        BoundedInputStream(InputStream delegate, int limit) {
            this.delegate = delegate;
            this.limit = limit;
        }

        /** Bytes actually pulled from the delegate. */
        long count() {
            return count;
        }

        /**
         * Whether the reader stopped because it ran out of budget rather than
         * because the file ended. The two mean very different things to a caller:
         * one is a file that is too large, the other is a complete file.
         */
        boolean limitReached() {
            return truncated;
        }

        @Override
        public int read() throws IOException {
            if (pushbackSize > 0) {
                return pushback[--pushbackSize];
            }
            if (count >= limit) {
                // Budget spent. Reporting EOF here rather than reading on is what
                // makes the bound structural.
                truncated = true;
                return -1;
            }
            int b = delegate.read();
            if (b != -1) {
                count++;
            }
            return b;
        }

        /**
         * Push one byte back, to be returned by the next read. Pushback does not
         * count against the budget because those bytes were already read.
         *
         * @param b the byte to return later
         */
        void unread(int b) {
            if (b == -1) {
                return;
            }
            if (pushbackSize == pushback.length) {
                throw new IllegalStateException("pushback buffer is only 3 bytes wide");
            }
            pushback[pushbackSize++] = b;
        }

        @Override
        public void close() throws IOException {
            delegate.close();
        }
    }
}
