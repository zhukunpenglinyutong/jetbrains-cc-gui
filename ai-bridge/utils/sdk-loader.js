/**
 * SDK Loader - Dynamically loads optional AI SDKs
 *
 * Supports loading SDKs from the user directory ~/.codemoss/dependencies/
 * This allows users to install SDKs on demand rather than bundling them with the plugin
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { getCodemossDir } from './path-utils.js';
import { resolveCodexCli } from '../services/codex/codex-cli-resolver.js';

// Base path for dependencies directory - uses the shared path utility
const DEPS_BASE = join(getCodemossDir(), 'dependencies');

// SDK cache
const sdkCache = new Map();
// Promise cache for in-flight loads to prevent concurrent loading of the same SDK
const loadingPromises = new Map();

// SDK definitions (kept in sync with DependencyManager.SdkDefinition).
const SDK_DEFINITIONS = {
    CLAUDE: {
        id: 'claude-sdk',
        npmPackage: '@anthropic-ai/claude-agent-sdk'
    }
};

function getSdkRootDir(sdkId, depsBaseOverride) {
    return join(depsBaseOverride || DEPS_BASE, sdkId);
}

function getPackageDirFromRoot(sdkRootDir, pkgName) {
    // Resolve managed SDK packages without consulting the global Node resolver.
    // Logic kept consistent with DependencyManager.getPackageDir()
    const parts = pkgName.split('/');
    return join(sdkRootDir, 'node_modules', ...parts);
}

function pickExportTarget(exportsField, condition) {
    if (!exportsField) return null;
    if (typeof exportsField === 'string') return exportsField;

    // exports: { ".": {...} } or exports: { import: "...", require: "...", default: "..." }
    const root = exportsField['.'] ?? exportsField;
    if (typeof root === 'string') return root;

    if (root && typeof root === 'object') {
        if (typeof root[condition] === 'string') return root[condition];
        if (typeof root.default === 'string') return root.default;
    }

    return null;
}

function resolveEntryFileFromPackageDir(packageDir) {
    // Node ESM does not support importing a directory path directly.
    // We must resolve to a concrete file (e.g., sdk.mjs / index.js / export target).
    const pkgJsonPath = join(packageDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

            const exportTarget =
                pickExportTarget(pkg.exports, 'import') ??
                pickExportTarget(pkg.exports, 'default');

            const candidate =
                exportTarget ??
                (typeof pkg.module === 'string' ? pkg.module : null) ??
                (typeof pkg.main === 'string' ? pkg.main : null);

            if (candidate && typeof candidate === 'string') {
                return join(packageDir, candidate);
            }
        } catch {
            // ignore and fall through to heuristic
        }
    }

    // Heuristics (covers @anthropic-ai/claude-agent-sdk which has sdk.mjs)
    const heuristicCandidates = ['sdk.mjs', 'index.mjs', 'index.js', 'dist/index.js', 'dist/index.mjs'];
    for (const file of heuristicCandidates) {
        const full = join(packageDir, file);
        if (existsSync(full)) return full;
    }

    return null;
}

function resolveExternalPackageUrl(pkgName, sdkRootDir) {
    // Resolve from package directory (works for external node_modules without touching Node's default resolver)
    const packageDir = getPackageDirFromRoot(sdkRootDir, pkgName);
    const entry = resolveEntryFileFromPackageDir(packageDir);
    if (!entry) {
        throw new Error(`Unable to resolve entry file for ${pkgName} from ${packageDir}`);
    }
    return pathToFileURL(entry).href;
}

/**
 * Check whether the Claude Code SDK is available
 * Logic kept consistent with DependencyManager.isInstalled("claude")
 */
export function isClaudeSdkAvailable() {
    const sdkId = 'claude-sdk';
    const npmPackage = '@anthropic-ai/claude-agent-sdk';
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(sdkId), npmPackage);
    const exists = existsSync(sdkPath);
    console.error('[sdk-loader] isClaudeSdkAvailable:', {
        path: sdkPath,
        exists: exists,
        depsBase: DEPS_BASE
    });
    return exists;
}

/**
 * Check whether the Codex runtime is available.
 *
 * The legacy export name is retained for system-status consumers. Availability
 * requires a CLI resolution; an SDK package or install marker is insufficient.
 * @param {string} [depsBaseOverride] test-only override of the dependencies root
 */
export function isCodexSdkAvailable(depsBaseOverride) {
    return getCodexCliStatus(depsBaseOverride).status === 'resolved';
}

/** Resolution involves synchronous PATH probes and can shell out; cache briefly. */
const CLI_STATUS_TTL_MS = 30_000;
const cliStatusCache = new Map();

/**
 * Resolve the installed Codex CLI with read-only compatibility for old dependencies.
 *
 * Results are cached briefly per dependencies root: the resolution chain is
 * synchronous daemon-loop work (PATH probes, and an interactive login shell
 * when nothing is installed), while per-request callers only need recent
 * truth.
 * @param {string} [depsBaseOverride] test-only override of the dependencies root
 * @returns {{status: string, source: string, kind?: string, command?: string[], version?: string|null, reason?: string}}
 */
export function getCodexCliStatus(depsBaseOverride) {
    const cacheKey = depsBaseOverride ?? '';
    const cached = cliStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CLI_STATUS_TTL_MS) {
        return cached.status;
    }
    const status = resolveCodexCli({
        depsRoot: join(getSdkRootDir('codex-sdk', depsBaseOverride), 'node_modules'),
        ...(depsBaseOverride ? { discoverCli: () => null, env: {} } : {}),
    });
    cliStatusCache.set(cacheKey, { status, at: Date.now() });
    return status;
}

/**
 * Dynamically load the Claude SDK
 * @returns {Promise<{query: Function, ...}>}
 * @throws {Error} If the SDK is not installed
 */
export async function loadClaudeSdk() {
    console.error('[DIAG-SDK] loadClaudeSdk() called');

    // Return the cached SDK if available
    if (sdkCache.has('claude')) {
        console.error('[DIAG-SDK] Returning cached SDK');
        return sdkCache.get('claude');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('claude')) {
        console.error('[DIAG-SDK] SDK loading in progress, returning existing promise');
        return loadingPromises.get('claude');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = getPackageDirFromRoot(sdkRootDir, '@anthropic-ai/claude-agent-sdk');
    console.error('[DIAG-SDK] SDK path:', sdkPath);
    console.error('[DIAG-SDK] SDK path exists:', existsSync(sdkPath));

    if (!existsSync(sdkPath)) {
        console.error('[DIAG-SDK] SDK not installed at path');
        throw new Error('SDK_NOT_INSTALLED:claude');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            console.error('[DIAG-SDK] SDK root dir:', sdkRootDir);

            // Node ESM does not support import(directory); must resolve to a concrete file (e.g. sdk.mjs)
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/claude-agent-sdk', sdkRootDir);
            console.error('[DIAG-SDK] Resolved URL:', resolvedUrl);

            console.error('[DIAG-SDK] Starting dynamic import...');
            const sdk = await import(resolvedUrl);
            console.error('[DIAG-SDK] SDK imported successfully, exports:', Object.keys(sdk));

            sdkCache.set('claude', sdk);
            return sdk;
        } catch (error) {
            console.error('[DIAG-SDK] SDK import failed:', error.message);
            const pkgDir = getPackageDirFromRoot(sdkRootDir, '@anthropic-ai/claude-agent-sdk');
            const hintFile = join(pkgDir, 'sdk.mjs');
            const hint = existsSync(hintFile) ? ` Did you mean to import ${hintFile}?` : '';
            throw new Error(`Failed to load Claude SDK: ${error.message}${hint}`);
        } finally {
            // Clear the promise cache once loading is complete
            loadingPromises.delete('claude');
        }
    })();

    loadingPromises.set('claude', loadPromise);
    return loadPromise;
}

/**
 * Load the base Anthropic SDK (used as an API fallback)
 * @returns {Promise<{Anthropic: Class}>}
 */
export async function loadAnthropicSdk() {
    // Return the cached SDK if available
    if (sdkCache.has('anthropic')) {
        return sdkCache.get('anthropic');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('anthropic')) {
        return loadingPromises.get('anthropic');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:anthropic');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('anthropic', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Anthropic SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('anthropic');
        }
    })();

    loadingPromises.set('anthropic', loadPromise);
    return loadPromise;
}

/**
 * Load the Bedrock SDK
 * @returns {Promise<{AnthropicBedrock: Class}>}
 */
export async function loadBedrockSdk() {
    // Return the cached SDK if available
    if (sdkCache.has('bedrock')) {
        return sdkCache.get('bedrock');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('bedrock')) {
        return loadingPromises.get('bedrock');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'bedrock-sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:bedrock');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/bedrock-sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('bedrock', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Bedrock SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('bedrock');
        }
    })();

    loadingPromises.set('bedrock', loadPromise);
    return loadPromise;
}

/**
 * Get the installation status of all SDKs
 */
export function getSdkStatus() {
    // Uses the same path resolution logic as DependencyManager
    const claudeInstalled = isClaudeSdkAvailable();
    const codexCli = getCodexCliStatus();

    return {
        claude: {
            installed: claudeInstalled,
            runtimeKind: 'sdk',
            path: getPackageDirFromRoot(getSdkRootDir('claude-sdk'), '@anthropic-ai/claude-agent-sdk')
        },
        codex: {
            installed: codexCli.status === 'resolved',
            runtimeKind: 'cli',
            transport: 'app-server',
            path: codexCli.command?.[0] ?? null,
            cli: {
                status: codexCli.status,
                source: codexCli.source,
                kind: codexCli.kind ?? null,
                version: codexCli.version ?? null
            }
        }
    };
}

/**
 * Read the installed version of an SDK package without importing it.
 * Codex is discovered as a CLI and has no managed SDK version.
 * @param {string} sdkId
 * @returns {string|null}
 */
export function getInstalledSdkVersion(sdkId) {
    const definition = Object.values(SDK_DEFINITIONS).find((entry) => entry.id === sdkId);
    if (!definition) {
        return null;
    }

    const packages = [definition.npmPackage, ...(definition.legacyNpmPackages || [])];
    const sdkRootDir = getSdkRootDir(sdkId);
    for (const npmPackage of packages) {
        const packageDir = getPackageDirFromRoot(sdkRootDir, npmPackage);
        const packageJsonPath = join(packageDir, 'package.json');
        if (!existsSync(packageJsonPath)) {
            continue;
        }
        try {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
            if (typeof packageJson.version === 'string') {
                return packageJson.version;
            }
        } catch {
            // fall through to the next candidate
        }
        // The legacy SDK package exists; its bundled CLI version is authoritative.
        const nestedCliPath = join(packageDir, 'node_modules', definition.npmPackage, 'package.json');
        if (npmPackage !== definition.npmPackage && existsSync(nestedCliPath)) {
            try {
                const nested = JSON.parse(readFileSync(nestedCliPath, 'utf8'));
                if (typeof nested.version === 'string') {
                    return nested.version;
                }
            } catch {
                // fall through
            }
        }
    }
    return null;
}

/**
 * Clear the SDK cache
 * Should be called after an SDK is reinstalled
 */
export function clearSdkCache() {
    sdkCache.clear();
}

/**
 * Verify that the SDK is installed, throwing a user-friendly error if not
 * @param {string} provider - 'claude' or 'codex'
 * @throws {Error} If the SDK is not installed
 */
export function requireSdk(provider) {
    if (provider === 'claude' && !isClaudeSdkAvailable()) {
        const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
        error.code = 'SDK_NOT_INSTALLED';
        error.provider = 'claude';
        throw error;
    }

    if (provider === 'codex' && getCodexCliStatus().status !== 'resolved') {
        const error = new Error('Codex CLI not found. Check Provider Management > CLI and install the official CLI.');
        error.code = 'CODEX_CLI_UNRESOLVED';
        error.provider = 'codex';
        throw error;
    }
}
