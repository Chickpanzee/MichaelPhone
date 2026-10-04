import 'dotenv/config';
import { InstallGlobalCommands } from './utils.js';

const JOIN_COMMAND = {
  name: 'join',
  description: 'Join your current voice channel',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

const DISCONNECT_COMMAND = {
  name: 'disconnect',
  description: 'Disconnect from the current voice channel',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

const CLEAR_COMMAND = {
  name: 'clear',
  description: 'Remove the bot’s existing messages from this DM',
  type: 1,
  integration_types: [0],
  contexts: [1],
};

const ALL_COMMANDS = [JOIN_COMMAND, DISCONNECT_COMMAND, CLEAR_COMMAND];

await InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
