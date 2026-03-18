/**
 * Claude Code CLI channel command handler.
 * Handles CLI native commands like /plan, /review, /commit, etc.
 */

/**
 * Execute a CLI native command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleCLICommand(command, args, stdinData) {
  switch (command) {
    case 'execute': {
      if (stdinData && stdinData.command !== undefined) {
        const { command: cliCommand, args: cliArgs = [] } = stdinData;
        await executeCLICommand(cliCommand, cliArgs);
      } else {
        // Legacy support for positional args
        const cliCommand = args[0];
        const cliArgs = args.slice(1);
        await executeCLICommand(cliCommand, cliArgs);
      }
      break;
    }

    default:
      throw new Error(`Unknown CLI command: ${command}`);
  }
}

/**
 * Execute a CLI command using the CLI daemon.
 * @param {string} command - The CLI command to execute (e.g., "/plan")
 * @param {string[]} args - Additional arguments for the command
 */
async function executeCLICommand(command, args = []) {
  // Import the daemon service for CLI command execution
  const { executeCliPersistent } = await import('../services/cli/cli-service.js');

  // Execute the command through the persistent CLI service
  await executeCliPersistent(command, args);
}

/**
 * Get the list of supported CLI commands.
 */
export function getCLICommandList() {
  return ['execute'];
}

/**
 * Check if a command string is a CLI native command.
 * @param {string} command - The command to check
 * @returns {boolean} - true if the command is a CLI native command
 */
export function isCLINativeCommand(command) {
  // CLI native commands start with '/' and are not plugin built-in commands
  if (!command.startsWith('/')) {
    return false;
  }

  // Known CLI native commands (this list should be kept in sync with Claude Code CLI)
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

  // Check if the command (without arguments) is a CLI native command
  const commandName = command.split(' ')[0];
  return cliNativeCommands.includes(commandName);
}

/**
 * Extract command and arguments from a user input string.
 * @param {string} input - User input (e.g., "/plan build a feature")
 * @returns {object} - { command: string, args: string[] }
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
