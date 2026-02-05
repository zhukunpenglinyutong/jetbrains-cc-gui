/**
 * SDK Loader - 动态加载可选 AI SDK
 *
 * 支持从用户目录 ~/.codemoss/dependencies/ 加载 SDK
 * 这允许用户按需安装 SDK，而不是将其打包在插件中
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { getRealHomeDir, getCodemossDir } from './path-utils.js';

// 依赖目录基路径 - 使用统一的路径工具函数
const DEPS_BASE = join(getCodemossDir(), 'dependencies');

// SDK 缓存
const sdkCache = new Map();
// 🔧 加载中的 Promise 缓存，防止并发加载同一 SDK
const loadingPromises = new Map();

// SDK 定义（与 DependencyManager.SdkDefinition 保持一致）
const SDK_DEFINITIONS = {
    CLAUDE: {
        id: 'claude-sdk',
        npmPackage: '@anthropic-ai/claude-agent-sdk'
    },
    CODEX: {
        id: 'codex-sdk',
        npmPackage: '@openai/codex-sdk'
    }
};

function getSdkRootDir(sdkId) {
    return join(DEPS_BASE, sdkId);
}

function getPackageDirFromRoot(sdkRootDir, pkgName) {
    // pkgName like: "@anthropic-ai/claude-agent-sdk" or "@openai/codex-sdk"
    // 与 DependencyManager.getPackageDir() 保持一致的逻辑
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
 * 检查 Claude Code SDK 是否可用
 * 与 DependencyManager.isInstalled("claude") 保持一致的逻辑
 */
export function isClaudeSdkAvailable() {
    const sdkId = 'claude-sdk';
    const npmPackage = '@anthropic-ai/claude-agent-sdk';
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(sdkId), npmPackage);
    const exists = existsSync(sdkPath);
    console.log('[sdk-loader] isClaudeSdkAvailable:', {
        path: sdkPath,
        exists: exists,
        depsBase: DEPS_BASE
    });
    return exists;
}

/**
 * 检查 Codex SDK 是否可用
 * 与 DependencyManager.isInstalled("codex") 保持一致的逻辑
 */
export function isCodexSdkAvailable() {
    const sdkId = 'codex-sdk';
    const npmPackage = '@openai/codex-sdk';
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(sdkId), npmPackage);
    const exists = existsSync(sdkPath);
    console.log('[sdk-loader] isCodexSdkAvailable:', {
        path: sdkPath,
        exists: exists
    });
    return exists;
}

/**
 * 动态加载 Claude SDK
 * @returns {Promise<{query: Function, ...}>}
 * @throws {Error} 如果 SDK 未安装
 */
export async function loadClaudeSdk() {
    console.log('[DIAG-SDK] loadClaudeSdk() called');

    // 🔧 优先返回已缓存的 SDK
    if (sdkCache.has('claude')) {
        console.log('[DIAG-SDK] Returning cached SDK');
        return sdkCache.get('claude');
    }

    // 🔧 如果正在加载中，返回同一个 Promise，防止并发重复加载
    if (loadingPromises.has('claude')) {
        console.log('[DIAG-SDK] SDK loading in progress, returning existing promise');
        return loadingPromises.get('claude');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = getPackageDirFromRoot(sdkRootDir, '@anthropic-ai/claude-agent-sdk');
    console.log('[DIAG-SDK] SDK path:', sdkPath);
    console.log('[DIAG-SDK] SDK path exists:', existsSync(sdkPath));

    if (!existsSync(sdkPath)) {
        console.log('[DIAG-SDK] SDK not installed at path');
        throw new Error('SDK_NOT_INSTALLED:claude');
    }

    // 🔧 创建加载 Promise 并缓存
    const loadPromise = (async () => {
        try {
            console.log('[DIAG-SDK] SDK root dir:', sdkRootDir);

            // 🔧 Node ESM 不支持 import(目录)，必须解析到具体文件（如 sdk.mjs）
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/claude-agent-sdk', sdkRootDir);
            console.log('[DIAG-SDK] Resolved URL:', resolvedUrl);

            console.log('[DIAG-SDK] Starting dynamic import...');
            const sdk = await import(resolvedUrl);
            console.log('[DIAG-SDK] SDK imported successfully, exports:', Object.keys(sdk));

            sdkCache.set('claude', sdk);
            return sdk;
        } catch (error) {
            console.log('[DIAG-SDK] SDK import failed:', error.message);
            const pkgDir = getPackageDirFromRoot(sdkRootDir, '@anthropic-ai/claude-agent-sdk');
            const hintFile = join(pkgDir, 'sdk.mjs');
            const hint = existsSync(hintFile) ? ` Did you mean to import ${hintFile}?` : '';
            throw new Error(`Failed to load Claude SDK: ${error.message}${hint}`);
        } finally {
            // 🔧 加载完成后清除 Promise 缓存
            loadingPromises.delete('claude');
        }
    })();

    loadingPromises.set('claude', loadPromise);
    return loadPromise;
}

/**
 * 动态加载 Codex SDK
 * @returns {Promise<{Codex: Class, ...}>}
 * @throws {Error} 如果 SDK 未安装
 */
export async function loadCodexSdk() {
    // 🔧 优先返回已缓存的 SDK
    if (sdkCache.has('codex')) {
        return sdkCache.get('codex');
    }

    // 🔧 如果正在加载中，返回同一个 Promise，防止并发重复加载
    if (loadingPromises.has('codex')) {
        return loadingPromises.get('codex');
    }

    const sdkRootDir = getSdkRootDir('codex-sdk');
    const sdkPath = getPackageDirFromRoot(sdkRootDir, '@openai/codex-sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:codex');
    }

    // 🔧 创建加载 Promise 并缓存
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@openai/codex-sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('codex', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Codex SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('codex');
        }
    })();

    loadingPromises.set('codex', loadPromise);
    return loadPromise;
}

/**
 * 加载 Anthropic 基础 SDK（用于 API 回退）
 * @returns {Promise<{Anthropic: Class}>}
 */
export async function loadAnthropicSdk() {
    // 🔧 优先返回已缓存的 SDK
    if (sdkCache.has('anthropic')) {
        return sdkCache.get('anthropic');
    }

    // 🔧 如果正在加载中，返回同一个 Promise，防止并发重复加载
    if (loadingPromises.has('anthropic')) {
        return loadingPromises.get('anthropic');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:anthropic');
    }

    // 🔧 创建加载 Promise 并缓存
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
 * 加载 Bedrock SDK
 * @returns {Promise<{AnthropicBedrock: Class}>}
 */
export async function loadBedrockSdk() {
    // 🔧 优先返回已缓存的 SDK
    if (sdkCache.has('bedrock')) {
        return sdkCache.get('bedrock');
    }

    // 🔧 如果正在加载中，返回同一个 Promise，防止并发重复加载
    if (loadingPromises.has('bedrock')) {
        return loadingPromises.get('bedrock');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'bedrock-sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:bedrock');
    }

    // 🔧 创建加载 Promise 并缓存
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
 * 获取所有 SDK 的状态
 */
export function getSdkStatus() {
    // 使用与 DependencyManager 相同的路径计算逻辑
    const claudeInstalled = isClaudeSdkAvailable();
    const codexInstalled = isCodexSdkAvailable();

    return {
        claude: {
            installed: claudeInstalled,
            path: getPackageDirFromRoot(getSdkRootDir('claude-sdk'), '@anthropic-ai/claude-agent-sdk')
        },
        codex: {
            installed: codexInstalled,
            path: getPackageDirFromRoot(getSdkRootDir('codex-sdk'), '@openai/codex-sdk')
        }
    };
}

/**
 * 清除 SDK 缓存
 * 在 SDK 重新安装后调用
 */
export function clearSdkCache() {
    sdkCache.clear();
}

/**
 * 检查 SDK 是否安装并抛出友好错误
 * @param {string} provider - 'claude' 或 'codex'
 * @throws {Error} 如果 SDK 未安装
 */
export function requireSdk(provider) {
    if (provider === 'claude' && !isClaudeSdkAvailable()) {
        const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
        error.code = 'SDK_NOT_INSTALLED';
        error.provider = 'claude';
        throw error;
    }

    if (provider === 'codex' && !isCodexSdkAvailable()) {
        const error = new Error('Codex SDK not installed. Please install via Settings > Dependencies.');
        error.code = 'SDK_NOT_INSTALLED';
        error.provider = 'codex';
        throw error;
    }
}
