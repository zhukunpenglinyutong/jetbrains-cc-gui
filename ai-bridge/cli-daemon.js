#!/usr/bin/env node

/**
 * Claude Code CLI Daemon Process
 *
 * Long-running Node.js process that handles CLI native commands via
 * stdin/stdout using NDJSON protocol.
 *
 * Protocol (stdin, one JSON per line):
 *   {"id":"1","method":"cli.execute","params":{"command":"/plan","args":[]}}
 *   {"id":"2","method":"heartbeat"}
 *
 * Protocol (stdout, one JSON per line):
 *   {"type":"daemon","event":"ready","pid":12345}           // daemon lifecycle
 *   {"id":"1","line":"[CLI OUTPUT]"}                       // command output
 *   {"id":"1","done":true,"success":true}                   // command complete
 *   {"id":"2","type":"heartbeat","ts":1234567890}           // heartbeat response
 */

import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { injectNetworkEnvVars } from './config/api-config.js';

// =============================================================================
// Constants
// =============================================================================

const DAEMON_VERSION = '1.0.0';

// =============================================================================
// State
// =============================================================================

let activeRequestId = null;
let isDaemonMode = true;
let cliPreloaded = false;
let activeCliProcess = null;

// Get CLI path from environment or use default
const CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';

// =============================================================================
// Output Interception
// =============================================================================

const _originalStdoutWrite = process.stdout.write.bind(process.stdout);
const _originalStderrWrite = process.stderr.write.bind(process.stderr);
const _originalConsoleLog = console.log.bind(console);
const _originalConsoleError = console.error.bind(console);

/**
 * Write a raw NDJSON line to stdout.
 */
function writeRawLine(obj) {
  _originalStdoutWrite(JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * Send a daemon lifecycle event.
 */
function sendDaemonEvent(event, data = {}) {
  writeRawLine({ type: 'daemon', event, ...data });
}

/**
 * Override process.stdout.write to tag output with request ID.
 */
process.stdout.write = function (chunk, encoding, callback) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8');

  if (activeRequestId) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.length > 0) {
        writeRawLine({ id: activeRequestId, line });
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

/**
 * Override console.log to go through our tagged stdout.
 */
console.log = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stdout.write(text + '\n');
};

/**
 * Override console.error to tag stderr output.
 */
console.error = function (...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  if (activeRequestId) {
    writeRawLine({ id: activeRequestId, stderr: text });
  } else {
    _originalStderrWrite(text + '\n', 'utf8');
  }
};

// =============================================================================
// CLI Command Execution
// =============================================================================

/**
 * Execute a CLI command and stream output.
 */
async function executeCliCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    // Build CLI command arguments
    const cliArgs = [...args];

    // Spawn the CLI process
    activeCliProcess = spawn(CLI_PATH, cliArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    // Handle stdout
    activeCliProcess.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutChunks.push(text);
      // Stream each line
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.length > 0) {
          writeRawLine({ id: activeRequestId, line });
        }
      }
    });

    // Handle stderr
    activeCliProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderrChunks.push(text);
      // Stream stderr lines
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.length > 0) {
          writeRawLine({ id: activeRequestId, stderr: line });
        }
      }
    });

    // Handle process exit
    activeCliProcess.on('close', (code) => {
      activeCliProcess = null;
      if (code === 0) {
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        resolve({ stdout, stderr, exitCode: code });
      } else {
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        reject(new Error(`CLI process exited with code ${code}: ${stderr || stdout}`));
      }
    });

    // Handle process error
    activeCliProcess.on('error', (err) => {
      activeCliProcess = null;
      reject(new Error(`Failed to spawn CLI process: ${err.message}`));
    });
  });
}

/**
 * Abort the currently running CLI command.
 */
function abortActiveCommand() {
  if (activeCliProcess) {
    activeCliProcess.kill('SIGTERM');
    activeCliProcess = null;
    return true;
  }
  return false;
}

// =============================================================================
// Request Processing
// =============================================================================

/**
 * Process a single request from stdin.
 */
async function processRequest(request) {
  const { id, method, params = {} } = request;

  // --- Heartbeat ---
  if (method === 'heartbeat') {
    writeRawLine({
      id: id || '0',
      type: 'heartbeat',
      ts: Date.now(),
      cliPreloaded,
      memoryUsage: process.memoryUsage().heapUsed,
    });
    return;
  }

  // --- Status query ---
  if (method === 'status') {
    writeRawLine({
      id,
      type: 'status',
      version: DAEMON_VERSION,
      pid: process.pid,
      uptime: process.uptime(),
      cliPreloaded,
      cliPath: CLI_PATH,
      memoryUsage: process.memoryUsage(),
    });
    return;
  }

  // --- Graceful shutdown ---
  if (method === 'shutdown') {
    abortActiveCommand();
    sendDaemonEvent('shutdown', { reason: 'requested' });
    writeRawLine({ id: id || '0', done: true, success: true });
    isDaemonMode = false;
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // --- Abort command ---
  if (method === 'abort') {
    const aborted = abortActiveCommand();
    writeRawLine({ id: id || '0', done: true, success: true, aborted });
    return;
  }

  // --- Command execution ---
  if (!id) {
    _originalStderrWrite(
      `[cli-daemon] Ignoring request without id: ${method}\n`,
      'utf8'
    );
    return;
  }

  activeRequestId = id;

  try {
    if (method === 'cli.execute') {
      const { command, args = [] } = params;
      if (!command) {
        throw new Error('Missing required parameter: command');
      }
      await executeCliCommand(command, args);
      writeRawLine({ id, done: true, success: true });
    } else {
      throw new Error(`Unknown method: ${method}`);
    }
  } catch (error) {
    if (activeRequestId !== null) {
      writeRawLine({
        id,
        done: true,
        success: false,
        error: error.message || String(error),
      });
    }
  } finally {
    activeRequestId = null;
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

(async () => {
  // Inject network environment variables
  injectNetworkEnvVars();

  // --- Error Handlers ---
  process.on('uncaughtException', (error) => {
    _originalStderrWrite(
      `[cli-daemon] Uncaught exception: ${error.message}\n${error.stack}\n`,
      'utf8'
    );
    if (activeRequestId) {
      writeRawLine({
        id: activeRequestId,
        done: true,
        success: false,
        error: `Uncaught exception: ${error.message}`,
      });
      activeRequestId = null;
    }
  });

  process.on('unhandledRejection', (reason) => {
    _originalStderrWrite(
      `[cli-daemon] Unhandled rejection: ${reason}\n`,
      'utf8'
    );
    if (activeRequestId) {
      writeRawLine({
        id: activeRequestId,
        done: true,
        success: false,
        error: `Unhandled rejection: ${String(reason)}`,
      });
      activeRequestId = null;
    }
  });

  // --- Startup ---
  sendDaemonEvent('starting', {
    pid: process.pid,
    version: DAEMON_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    cliPath: CLI_PATH,
  });

  // Verify CLI is available
  try {
    const verifyProcess = spawn(CLI_PATH, ['--version'], {
      stdio: 'pipe',
      timeout: 5000
    });

    await new Promise((resolve, reject) => {
      const outputChunks = [];
      verifyProcess.stdout.on('data', (data) => {
        outputChunks.push(data.toString());
      });
      verifyProcess.on('close', (code) => {
        const output = outputChunks.join('');
        if (code === 0) {
          cliPreloaded = true;
          sendDaemonEvent('cli_loaded', {
            version: output.trim(),
            path: CLI_PATH
          });
          resolve();
        } else {
          sendDaemonEvent('cli_load_error', {
            error: `CLI verification failed with exit code ${code}`
          });
          resolve();
        }
      });
      verifyProcess.on('error', (err) => {
        sendDaemonEvent('cli_load_error', {
          error: `Failed to spawn CLI: ${err.message}`
        });
        resolve();
      });
    });
  } catch (e) {
    sendDaemonEvent('cli_load_error', {
      error: e.message
    });
  }

  // Signal ready
  sendDaemonEvent('ready', {
    pid: process.pid,
    cliPreloaded,
  });

  // --- Listen for requests on stdin ---
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Command requests must be serialized
  let commandQueue = Promise.resolve();

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      _originalStderrWrite(
        `[cli-daemon] Invalid JSON input: ${line.substring(0, 200)}\n`,
        'utf8'
      );
      return;
    }

    // Heartbeats and status queries are safe to run immediately
    if (request.method === 'heartbeat' || request.method === 'status') {
      processRequest(request);
      return;
    }

    // Abort bypasses the command queue
    if (request.method === 'abort') {
      abortActiveCommand();
      writeRawLine({ id: request.id || '0', done: true, success: true });
      return;
    }

    // Command requests are serialized
    commandQueue = commandQueue
      .then(() => processRequest(request))
      .catch((e) => {
        _originalStderrWrite(
          `[cli-daemon] Request queue error: ${e.message}\n`,
          'utf8'
        );
      });
  });

  rl.on('close', () => {
    abortActiveCommand();
    sendDaemonEvent('shutdown', { reason: 'stdin_closed' });
    isDaemonMode = false;
    process.exit(0);
  });

  // --- Parent process monitoring ---
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
        `[cli-daemon] Parent process (ppid=${initialPpid}) is gone, exiting\n`,
        'utf8'
      );
      isDaemonMode = false;
      process.exit(0);
    }
  }, 10000);
  ppidMonitor.unref();
})();
