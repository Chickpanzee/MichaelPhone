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

const ABBREVIATIONS_COMMAND = {
  name: 'abbreviations',
  description: 'Manage your personal spoken abbreviations',
  type: 1,
  integration_types: [0],
  contexts: [1],
  options: [
    {
      type: 1,
      name: 'toggle',
      description: 'Turn your abbreviation replacements on or off',
    },
    {
      type: 1,
      name: 'add',
      description: 'Add or update an abbreviation replacement',
      options: [
        {
          type: 3,
          name: 'abbreviation',
          description: 'The text to replace',
          required: true,
          max_length: 32,
        },
        {
          type: 3,
          name: 'replacement',
          description: 'The text to say instead',
          required: true,
          max_length: 100,
        },
      ],
    },
    {
      type: 1,
      name: 'remove',
      description: 'Remove one of your abbreviation replacements',
      options: [
        {
          type: 3,
          name: 'abbreviation',
          description: 'The abbreviation to remove',
          required: true,
          max_length: 32,
        },
      ],
    },
    {
      type: 1,
      name: 'list',
      description: 'Show your abbreviation replacements and their status',
    },
  ],
};

const ALL_COMMANDS = [
  JOIN_COMMAND,
  DISCONNECT_COMMAND,
  CLEAR_COMMAND,
  ABBREVIATIONS_COMMAND,
];

await InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
