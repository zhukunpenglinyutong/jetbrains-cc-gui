#!/usr/bin/env node

/**
 * AI Bridge Daemon Process
 *
 * Long-running Node.js process that pre-loads the Claude SDK once and handles
 * multiple requests over stdin/stdout using NDJSON protocol.
 *
 * Protocol (stdin, one JSON per line):
 *   {"id":"1","method":"claude.send","params":{...}}
 *   {"id":"2","method":"heartbeat"}
 *
 * Protocol (stdout, one JSON per line):
 *   {"type":"daemon","event":"ready","pid":12345}
 *   {"id":"1","line":"[STREAM_START]"}
 *   {"id":"1","done":true,"success":true}
 *   {"id":"2","type":"heartbeat","ts":1234567890}
 */

import { createInterface } from 'readline';
import { handleClaudeCommand } from './channels/claude-channel.js';
import { handleCodexCommand } from './channels/codex-channel.js';
import { loadClaudeSdk, isClaudeSdkAvailable } from './utils/sdk-loader.js';
import {
  sendMessagePersistent,
  sendMessageWithAttachmentsPersistent,
  preconnectPersistent,
  shutdownPersistentRuntimes,
  abortCurrentTurn,
  resetRuntimePersistent,
  getContextUsagePersistent
} from './services/claude/persistent-query-service.js';
import { resetCodexThreadCache } from './services/codex/message-service.js';
import { injectNetworkEnvVars } from './config/api-config.js';
import { cleanupStaleTempImages } from './services/claude/attachment-service.js';

injectNetworkEnvVars();

const DAEMON_VERSION = '1.0.0';

let activeRequestId = null;
let isDaemonMode = true;
let sdkPreloaded = false;
let commandQueue = Promise.resolve();
let queuedRequestCount = 0;

const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
const _originalStderrWrite = process.stderr.write.bind(process.stderr);
const _originalExit = process.exit;

function writeRawLine(obj) {
  _originalStdoutWrite(JSON.stringify(obj) + '\n', 'utf8');
}

function sendDaemonEvent(event, data = {}) {
  writeRawLine({ type: 'daemon', event, ...data });
}

function sendQueueWaitingEvent(requestId, aheadCount) {
  sendDaemonEvent('queue_waiting', {
    requestId,
    aheadCount,
  });
}

function sendQueueStartedEvent(requestId) {
  sendDaemonEvent('queue_started', {
    requestId,
  });
}

function sendQueueClearedEvent(requestId) {
  sendDaemonEvent('queue_cleared', {
    requestId,
  });
}

function getCurrentRequestId() {
  return activeRequestId;
}

process.stdout.write = function (chunk, encoding, callback) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');
  const requestId = getCurrentRequestId();

  if (requestId) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.length > 0) {
        writeRawLine({ id: requestId, line });
      }
    }
    if (typeof callback === 'function') callback();
    return true;
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return _originalStdoutWrite(chunk, encoding, callback);
  }

  if (trimmed.length > 0) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim().length > 0) {
        writeRawLine({ type: 'daemon', event: 'log', message: line });
      }
    }
  }

  if (typeof callback === 'function') callback();
  return true;
};

console.log = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stdout.write(text + '\n');
};

console.error = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const requestId = getCurrentRequestId();
  if (requestId) {
    writeRawLine({ id: requestId, stderr: text });
  } else {
    _originalStderrWrite(text + '\n', 'utf8');
  }
};

process.exit = function (code) {
  if (isDaemonMode) {
    const capturedId = getCurrentRequestId();
    activeRequestId = null;

    if (capturedId) {
      if (code === 0) {
        writeRawLine({ id: capturedId, done: true, success: true });
      } else {
        writeRawLine({
          id: capturedId,
          done: true,
          success: false,
          error: `process.exit(${code}) intercepted by daemon`,
        });
      }
    }

    throw new Error(`[daemon] process.exit(${code}) intercepted`);
  }
  _originalExit(code);
};

try {
  const exitCodeDescriptor = Object.getOwnPropertyDescriptor(process, 'exitCode');
  if (exitCodeDescriptor?.configurable) {
    let _exitCode = process.exitCode || 0;
    Object.defineProperty(process, 'exitCode', {
      set(code) {
        if (!isDaemonMode) {
          _exitCode = code;
        }
      },
      get() {
        return _exitCode;
      },
      configurable: true,
    });
  }
} catch (error) {
  _originalStderrWrite(`[daemon] Unable to patch process.exitCode: ${error.message}\n`, 'utf8');
}

async function preloadSdks() {
  try {
    if (isClaudeSdkAvailable()) {
      sendDaemonEvent('sdk_loading', { provider: 'claude' });
      await loadClaudeSdk();
      sdkPreloaded = true;
      sendDaemonEvent('sdk_loaded', { provider: 'claude' });
    } else {
      sendDaemonEvent('sdk_unavailable', { provider: 'claude' });
    }
  } catch (e) {
    sendDaemonEvent('sdk_load_error', {
      provider: 'claude',
      error: e.message,
    });
  }
}

async function dispatchProviderCommand(method, params) {
  const dotIndex = method.indexOf('.');
  if (dotIndex < 0) {
    throw new Error(`Invalid method format: ${method}. Expected "provider.command"`);
  }

  const provider = method.substring(0, dotIndex);
  const command = method.substring(dotIndex + 1);
  const stdinData = { ...params };
  delete stdinData.env;

  if (provider === 'claude' && command === 'send') {
    await sendMessagePersistent(stdinData);
    return;
  }
  if (provider === 'claude' && command === 'sendWithAttachments') {
    await sendMessageWithAttachmentsPersistent(stdinData);
    return;
  }
  if (provider === 'claude' && command === 'preconnect') {
    await preconnectPersistent(stdinData);
    return;
  }
  if (provider === 'claude' && command === 'resetRuntime') {
    await resetRuntimePersistent(stdinData);
    return;
  }
  if (provider === 'claude' && command === 'getContextUsage') {
    await getContextUsagePersistent(stdinData);
    return;
  }

  switch (provider) {
    case 'claude':
      await handleClaudeCommand(command, [], stdinData);
      return;
    case 'codex':
      await handleCodexCommand(command, [], stdinData);
      return;
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function processRequest(request) {
  const { id, method, params = {} } = request;

  if (method === 'heartbeat') {
    writeRawLine({
      id: id || '0',
      type: 'heartbeat',
      ts: Date.now(),
      sdkPreloaded,
      memoryUsage: process.memoryUsage().heapUsed,
    });
    return;
  }

  if (method === 'status') {
    writeRawLine({
      id,
      type: 'status',
      version: DAEMON_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      sdkPreloaded,
      memoryUsage: process.memoryUsage(),
    });
    return;
  }

  if (method === 'shutdown') {
    await shutdownPersistentRuntimes();
    resetCodexThreadCache();
    sendDaemonEvent('shutdown', { reason: 'requested' });
    writeRawLine({ id: id || '0', done: true, success: true });
    isDaemonMode = false;
    setTimeout(() => _originalExit(0), 100);
    return;
  }

  if (!id) {
    _originalStderrWrite(`[daemon] Ignoring request without id: ${method}\n`, 'utf8');
    return;
  }

  sendQueueStartedEvent(id);
  activeRequestId = id;
  const savedEnv = {};

  try {
    if (params.env && typeof params.env === 'object') {
      for (const [key, value] of Object.entries(params.env)) {
        if (value !== undefined && value !== null) {
          savedEnv[key] = process.env[key];
          process.env[key] = String(value);
        }
      }
    }

    await dispatchProviderCommand(method, params);
    writeRawLine({ id, done: true, success: true });
  } catch (error) {
    if (activeRequestId !== null) {
      writeRawLine({
        id,
        done: true,
        success: false,
        error: error.message || String(error),
        code: error.code,
      });
    }
  } finally {
    sendQueueClearedEvent(id);
    activeRequestId = null;
    for (const [key, originalValue] of Object.entries(savedEnv)) {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  }
}

(async () => {
  process.on('uncaughtException', (error) => {
    _originalStderrWrite(
      `[daemon] Uncaught exception: ${error.message}\n${error.stack}\n`,
      'utf8'
    );
    const requestId = getCurrentRequestId();
    if (requestId) {
      writeRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Uncaught exception: ${error.message}`,
      });
      activeRequestId = null;
    }
  });

  process.on('unhandledRejection', (reason) => {
    _originalStderrWrite(
      `[daemon] Unhandled rejection: ${reason}\n`,
      'utf8'
    );
    const requestId = getCurrentRequestId();
    if (requestId) {
      writeRawLine({
        id: requestId,
        done: true,
        success: false,
        error: `Unhandled rejection: ${String(reason)}`,
      });
      activeRequestId = null;
    }
  });

  sendDaemonEvent('starting', {
    pid: process.pid,
    version: DAEMON_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
  });

  await preloadSdks();
  cleanupStaleTempImages().catch(() => {});

  sendDaemonEvent('ready', {
    pid: process.pid,
    sdkPreloaded,
  });

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      _originalStderrWrite(
        `[daemon] Invalid JSON input: ${line.substring(0, 200)}\n`,
        'utf8'
      );
      return;
    }

    if (request.method === 'heartbeat' || request.method === 'status') {
      processRequest(request);
      return;
    }

    if (request.method === 'abort') {
      _originalStderrWrite(
        `[daemon] Abort requested, active request: ${activeRequestId || 'none'}\n`,
        'utf8'
      );
      abortCurrentTurn().catch((e) => {
        _originalStderrWrite(
          `[daemon] Abort error: ${e.message}\n`,
          'utf8'
        );
      });
      writeRawLine({ id: request.id || '0', done: true, success: true });
      return;
    }

    queuedRequestCount += 1;
    const aheadCount = activeRequestId ? queuedRequestCount - 1 : queuedRequestCount;
    if (aheadCount > 0) {
      sendQueueWaitingEvent(request.id, aheadCount);
    }

    commandQueue = commandQueue
      .then(() => processRequest(request))
      .catch((e) => {
        _originalStderrWrite(
          `[daemon] Request queue error: ${e.message}\n`,
          'utf8'
        );
      })
      .finally(() => {
        queuedRequestCount = Math.max(0, queuedRequestCount - 1);
      });
  });

  rl.on('close', async () => {
    const forceExitTimer = setTimeout(() => {
      _originalStderrWrite('[daemon] Shutdown timeout (5s), forcing exit\n', 'utf8');
      _originalExit(0);
    }, 5000);
    forceExitTimer.unref();

    try {
      await shutdownPersistentRuntimes();
    } catch (e) {
      _originalStderrWrite(`[daemon] Failed to shutdown persistent runtimes: ${e.message}\n`, 'utf8');
    }
    resetCodexThreadCache();
    clearTimeout(forceExitTimer);
    sendDaemonEvent('shutdown', { reason: 'stdin_closed' });
    isDaemonMode = false;
    _originalExit(0);
  });

  const initialPpid = process.ppid;
  const ppidMonitor = setInterval(() => {
    const currentPpid = process.ppid;
    const reparented = currentPpid !== initialPpid && currentPpid === 1;
    let parentGone = false;

    if (!reparented && currentPpid !== 1) {
      try {
        process.kill(currentPpid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') {
          parentGone = true;
        }
      }
    }

    if (reparented || parentGone) {
      _originalStderrWrite(
        `[daemon] Parent process (ppid=${initialPpid}) is gone (current ppid=${currentPpid}), exiting\n`,
        'utf8'
      );
      isDaemonMode = false;
      _originalExit(0);
    }
  }, 10000);
  ppidMonitor.unref();
})();
