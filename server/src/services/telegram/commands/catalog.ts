/**
 * Bot command catalog.
 *
 * `BOT_COMMANDS` is the single source of truth used by `setMyCommands`, `/help`
 * and the documentation. Keep descriptions short (Telegram limit: 256 chars)
 * and in sync with the actual command handlers.
 */

export interface BotCommandDescription {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommandDescription[] = [
  { command: 'start', description: 'Start the bot and check your access' },
  { command: 'help', description: 'Show the available commands' },
  { command: 'status', description: 'Show the monitor status overview' },
  { command: 'info', description: 'Show details for one monitor' },
  { command: 'add', description: 'Add a monitor (wizard or one line)' },
  { command: 'edit', description: 'Change a monitor target' },
  { command: 'remove', description: 'Delete a monitor (asks to confirm)' },
  { command: 'mute', description: 'Mute notifications for a monitor or all' },
  { command: 'unmute', description: 'Remove a monitor mute (or all mutes)' },
  { command: 'pause', description: 'Pause checks for a monitor' },
  { command: 'resume', description: 'Resume checks for a monitor' },
  { command: 'restart', description: 'Run checks now (one monitor or all)' },
  { command: 'ping', description: 'Run a one-off check without saving it' },
  { command: 'allow', description: 'Allow a Telegram user by ID' },
  { command: 'deny', description: 'Deny a Telegram user' },
  { command: 'users', description: 'List Telegram users' },
  { command: 'groups', description: 'List monitor groups' },
  { command: 'whoami', description: 'Show your Telegram identity' },
  { command: 'app', description: 'Open the web app (Mini App)' },
  { command: 'cancel', description: 'Cancel the pending action' },
];
