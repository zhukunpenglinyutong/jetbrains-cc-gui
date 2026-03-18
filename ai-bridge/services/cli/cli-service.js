/**
 * Claude Code CLI Service
 * Handles CLI native command execution through the CLI daemon.
 */

// In daemon mode, commands are executed by the cli-daemon.js process.
// This service provides the interface for command execution.

/**
 * Execute a CLI native command in daemon mode.
 * This function is called from cli-daemon.js when handling cli.execute requests.
 *
 * @param {string} command - The CLI command to execute (e.g., "/plan")
 * @param {string[]} args - Additional arguments for the command
 */
export async function executeCliPersistent(command, args = []) {
  const CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';

  // Build the command with arguments
  const commandArgs = [command, ...args];

  // Import spawn from child_process
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    // Spawn the CLI process
    const cliProcess = spawn(CLI_PATH, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    // Handle stdout - stream each line
    cliProcess.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      // Output is automatically intercepted by the daemon's stdout override
      // Just write to console.log which will be tagged with request ID
      console.log(text);
    });

    // Handle stderr
    cliProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      // Stream stderr to console.error
      console.error(text);
    });

    // Handle process exit
    cliProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: code });
      } else {
        reject(new Error(`CLI process exited with code ${code}: ${stderr || stdout}`));
      }
    });

    // Handle process error
    cliProcess.on('error', (err) => {
      reject(new Error(`Failed to spawn CLI process: ${err.message}`));
    });
  });
}

/**
 * Check if a command is a CLI native command.
 * @param {string} command - The command to check
 * @returns {boolean} - true if the command is a CLI native command
 */
export function isCLINativeCommand(command) {
  if (!command || !command.startsWith('/')) {
    return false;
  }

  // Known CLI native commands
  const cliNativeCommands = [
    '/plan',
    '/review',
    '/commit',
    '/babysit',
    '/loop',
    '/help',
    '/skills',
    '/config',
    '/providers',
    '/mcp',
    '/mode',
    '/model',
    '/temperature',
    '/top-p',
    '/top-k',
    '/max-tokens'
  ];

  const commandName = command.split(' ')[0];
  return cliNativeCommands.includes(commandName);
}

/**
 * Parse a CLI command string into command and arguments.
 * @param {string} input - User input (e.g., "/plan build a feature")
 * @returns {object|null} - { command: string, args: string[] } or null
 */
export function parseCLICommand(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  return { command, args };
}
