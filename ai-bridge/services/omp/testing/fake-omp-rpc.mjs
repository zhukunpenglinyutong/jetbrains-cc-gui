/**
 * Scripted stand-in for `omp --mode rpc`.
 *
 * FAKE_OMP_SCRIPT points at a JSON file:
 *   { "ready": true, "exitCode": 0, "on": { "<command type>": [step, ...] }, "onClose": [step, ...] }
 * Each command read from stdin plays the steps registered for its type:
 *   { "respond": data|null }   success response to the command
 *   { "fail": "message", "code": "..." }
 *   { "emit": frame }          unsolicited stdout frame
 *   { "waitFor": "<type>" }    pause until a stdin frame of that type arrives
 *   { "delay": ms }
 *   { "stderr": "text" }
 *   { "exit": code }
 * Every stdin frame is appended to FAKE_OMP_LOG (JSON lines) when it is set.
 * Closing stdin plays the "onClose" steps (work omp finishes after its input ended), then exits,
 * as the real CLI does.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const script = JSON.parse(readFileSync(process.env.FAKE_OMP_SCRIPT, 'utf8'));
const logFile = process.env.FAKE_OMP_LOG;
const waiters = [];

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function play(steps, command) {
  for (const step of steps) {
    if ('respond' in step) {
      write({
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        ...(step.respond === null ? {} : { data: step.respond }),
      });
    } else if ('fail' in step) {
      write({
        id: command.id,
        type: 'response',
        command: command.type,
        success: false,
        error: step.fail,
        ...(step.code ? { code: step.code } : {}),
      });
    } else if ('emit' in step) {
      write(step.emit);
    } else if ('waitFor' in step) {
      await new Promise((resolve) => waiters.push({ type: step.waitFor, resolve }));
    } else if ('delay' in step) {
      await new Promise((resolve) => setTimeout(resolve, step.delay));
    } else if ('stderr' in step) {
      process.stderr.write(step.stderr);
    } else if ('exit' in step) {
      process.exit(step.exit);
    }
  }
}

if (script.ready !== false) {
  write({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 });
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    if (logFile) appendFileSync(logFile, `${JSON.stringify(frame)}\n`);
    const waiting = waiters.findIndex((waiter) => waiter.type === frame.type);
    if (waiting >= 0) {
      waiters.splice(waiting, 1)[0].resolve(frame);
      return;
    }
    const steps = script.on?.[frame.type];
    if (steps) {
      void play(steps, frame);
    } else if (frame.id) {
      write({
        id: frame.id,
        type: 'response',
        command: frame.type,
        success: false,
        error: `Unknown command: ${frame.type}`,
      });
    }
  })
  .on('close', () => {
    // `respond` and `fail` answer a command; there is none to answer here.
    void play(script.onClose ?? [], {}).then(() => process.exit(script.exitCode ?? 0));
  });
