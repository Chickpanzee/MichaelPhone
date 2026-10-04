import 'dotenv/config';
import { spawn } from 'node:child_process';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from 'discord-interactions';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
const voiceIdleTimeouts = new Map();
const voicePlayers = new Map();
const speechQueues = new Map();
const VOICE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const VOICE_PLAYBACK_TIMEOUT_MS = 10 * 60 * 1000;
const VOICE_DEBUG_ENABLED = process.env.VOICE_DEBUG === 'true';
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});
client.on('error', (error) => console.error('Discord client error:', error));
client.on('voiceStateUpdate', (oldState, newState) => {
  if (!VOICE_DEBUG_ENABLED || newState.id !== client.user?.id) return;
  console.debug(
    `[voice:${newState.guild.id}] Gateway voice state update: channel=${newState.channelId ?? 'none'}`,
  );
});
client.on('voiceServerUpdate', ({ guildId, endpoint }) => {
  if (!VOICE_DEBUG_ENABLED) return;
  console.debug(`[voice:${guildId}] Gateway voice server update: endpoint=${endpoint ?? 'none'}`);
});

function configureVoiceNetworking(connection, guildId) {
  const receivedStateUpdate = Boolean(connection?.packets.state);
  const receivedVoiceServerUpdate = Boolean(connection?.packets.server);
  const hasVoiceServerEndpoint = Boolean(connection?.packets.server?.endpoint);
  console.info(
    `[voice:${guildId}] Handshake packets: state=${receivedStateUpdate}, ` +
      `server=${receivedVoiceServerUpdate}, endpoint=${hasVoiceServerEndpoint}, ` +
      `status=${connection?.state.status ?? 'not created'}`,
  );

  if (
    connection?.state.status !== VoiceConnectionStatus.Signalling ||
    !receivedStateUpdate ||
    !hasVoiceServerEndpoint
  ) {
    return;
  }

  try {
    console.info(`[voice:${guildId}] Configuring networking from Gateway adapter.`);
    connection.configureNetworking();
    console.info(`[voice:${guildId}] Networking configuration result: ${connection.state.status}`);
  } catch (error) {
    console.error(`[voice:${guildId}] Failed to configure voice networking:`, error);
  }
}

function redactVoiceDebug(message) {
  return message.replace(
    /("(?:token|secret_key|session_id)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[redacted]"',
  );
}

function resetVoiceIdleTimeout(guildId, connection) {
  const previousTimeout = voiceIdleTimeouts.get(guildId);
  if (previousTimeout) clearTimeout(previousTimeout.timer);

  const timer = setTimeout(() => {
    const currentTimeout = voiceIdleTimeouts.get(guildId);
    if (currentTimeout?.timer !== timer) return;

    connection.destroy();
    voiceIdleTimeouts.delete(guildId);
    const voicePlayer = voicePlayers.get(guildId);
    if (voicePlayer?.connection === connection) {
      voicePlayer.player.stop(true);
      voicePlayers.delete(guildId);
    }
  }, VOICE_IDLE_TIMEOUT_MS);
  timer.unref();
  voiceIdleTimeouts.set(guildId, { connection, timer, lastActivityAt: Date.now() });
}

function disconnectVoiceConnection(guildId) {
  const activeConnection = voiceIdleTimeouts.get(guildId);
  if (!activeConnection) return false;

  clearTimeout(activeConnection.timer);
  voiceIdleTimeouts.delete(guildId);

  const voicePlayer = voicePlayers.get(guildId);
  if (voicePlayer?.connection === activeConnection.connection) {
    voicePlayer.player.stop(true);
    voicePlayers.delete(guildId);
  }

  activeConnection.connection.destroy();
  return true;
}

function findJoinedVoiceConnection(userId) {
  return [...voiceIdleTimeouts.entries()]
    .map(([guildId, activeConnection]) => {
      const guild = client.guilds.cache.get(guildId);
      const voiceState = guild?.voiceStates.cache.get(userId);
      if (
        !guild ||
        voiceState?.channelId !== activeConnection.connection.joinConfig.channelId ||
        activeConnection.connection.state.status !== VoiceConnectionStatus.Ready
      ) {
        return undefined;
      }
      return { guildId, activeConnection };
    })
    .filter((match) => match !== undefined)
    .sort((a, b) => b.activeConnection.lastActivityAt - a.activeConnection.lastActivityAt)[0];
}

async function createSpeechFile(text) {
  if (process.platform !== 'win32') {
    throw new Error('Local speech synthesis is only configured for Windows.');
  }

  const filePath = join(tmpdir(), `discord-tts-${randomUUID()}.wav`);
  const encodedText = Buffer.from(text, 'utf8').toString('base64');
  const escapedPath = filePath.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  Add-Type -AssemblyName System.Speech',
    `  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))`,
    '  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `  $synth.SetOutputToWaveFile('${escapedPath}')`,
    '  $synth.Speak($text)',
    '  $synth.Dispose()',
    '} catch {',
    '  [Console]::Error.WriteLine($_)',
    '  exit 1',
    '}',
  ].join('\n');
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
        { windowsHide: true },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Windows speech synthesis failed: ${stderr || `exit code ${code}`}`));
        }
      });
    });
    return filePath;
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
}

function playAudioResource(player, resource) {
  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    timeout = setTimeout(() => {
      cleanup();
      player.stop(true);
      reject(new Error('Voice playback timed out.'));
    }, VOICE_PLAYBACK_TIMEOUT_MS);
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once('error', onError);
    try {
      player.play(resource);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function speakInVoiceChannel(guildId, connection, text) {
  const activeConnection = voiceIdleTimeouts.get(guildId);
  if (activeConnection?.connection !== connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    throw new Error('The bot is no longer connected to that voice channel.');
  }

  const filePath = await createSpeechFile(text);
  try {
    let voicePlayer = voicePlayers.get(guildId);
    if (voicePlayer?.connection !== connection) {
      voicePlayer?.player.stop(true);
      const player = createAudioPlayer();
      player.on('error', (error) => console.error('Voice audio player error:', error));
      connection.subscribe(player);
      voicePlayer = { connection, player };
      voicePlayers.set(guildId, voicePlayer);
    }

    const resource = createAudioResource(
      filePath,
      { inputType: StreamType.Arbitrary },
    );
    resetVoiceIdleTimeout(guildId, connection);
    await playAudioResource(voicePlayer.player, resource);
  } finally {
    await fs.rm(filePath, { force: true });
  }
}

function enqueueSpeech(guildId, connection, text) {
  const previousSpeech = speechQueues.get(guildId) ?? Promise.resolve();
  const currentSpeech = previousSpeech
    .catch((error) => console.error('Previous voice message failed:', error))
    .then(() => speakInVoiceChannel(guildId, connection, text));
  speechQueues.set(guildId, currentSpeech);

  return currentSpeech.finally(() => {
    if (speechQueues.get(guildId) === currentSpeech) {
      speechQueues.delete(guildId);
    }
  });
}

client.on('messageCreate', (message) => {
  if (message.author.bot || message.guildId || !message.content.trim()) return;

  const match = findJoinedVoiceConnection(message.author.id);
  if (!match) {
    void message.reply(
      'Join a voice channel that I have joined, then DM me the text you want me to read aloud.',
    ).catch((error) => console.error('Failed to reply to DM:', error));
    return;
  }

  resetVoiceIdleTimeout(match.guildId, match.activeConnection.connection);
  void enqueueSpeech(
    match.guildId,
    match.activeConnection.connection,
    message.content,
  ).catch(async (error) => {
    console.error('Failed to read DM aloud:', error);
    try {
      await message.reply(
        process.platform === 'win32'
          ? "I couldn't read that message aloud. Check that Windows speech synthesis and voice playback are available."
          : 'Local speech synthesis is only configured for Windows.',
      );
    } catch (replyError) {
      console.error('Failed to report DM speech error:', replyError);
    }
  });
});

async function editInteractionResponse(applicationId, token, content) {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to update interaction response (${response.status}): ${details}`);
  }
}

async function getInteractionResponse(applicationId, token) {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to fetch interaction response (${response.status}): ${details}`);
  }

  return response.json();
}

async function clearBotMessages(channel, responseMessageId) {
  let deletedCount = 0;
  let before;

  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    const oldestMessage = messages.last();
    for (const message of messages.values()) {
      if (message.author.id !== client.user.id || message.id === responseMessageId) continue;
      await message.delete();
      deletedCount += 1;
    }

    if (messages.size < 100) break;
    before = oldestMessage.id;
  }

  return deletedCount;
}

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    if (name === 'clear') {
      const channelId = req.body.channel_id;
      if (req.body.guild_id || !channelId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Use this command in a direct message with the bot.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL },
      });

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.DM) {
          throw new Error(`Interaction channel ${channelId} is not a direct message with the bot.`);
        }

        const originalResponse = await getInteractionResponse(process.env.APP_ID, req.body.token);
        const deletedCount = await clearBotMessages(channel, originalResponse.id);
        console.info(`[clear:${channelId}] Deleted ${deletedCount} bot-authored DM messages.`);
        await editInteractionResponse(
          process.env.APP_ID,
          req.body.token,
          `Deleted ${deletedCount} of my messages from this DM. Your messages can't be deleted by the bot.`,
        );
      } catch (error) {
        console.error(`[clear:${channelId}] Failed to clear bot messages from DM:`, error);
        try {
          await editInteractionResponse(
            process.env.APP_ID,
            req.body.token,
            "I couldn't finish clearing my messages from this DM. Check the bot logs for details.",
          );
        } catch (responseError) {
          console.error(`[clear:${channelId}] Failed to report the clear error:`, responseError);
        }
      }
      return;
    }

    if (name === 'disconnect') {
      const guildId = req.body.guild_id;
      if (!guildId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'This command can only be used in a server.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const disconnected = disconnectVoiceConnection(guildId);
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: disconnected
            ? 'Disconnected from the voice channel.'
            : "I'm not connected to a voice channel in this server.",
          flags: InteractionResponseFlags.EPHEMERAL,
        },
      });
    }

    if (name === 'join') {
      const guildId = req.body.guild_id;
      const userId = req.body.member?.user?.id ?? req.body.user?.id;

      if (!guildId || !userId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'This command can only be used in a server.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL },
      });

      const guild = client.guilds.cache.get(guildId);
      const voiceState = guild?.voiceStates.cache.get(userId);
      const channel = voiceState?.channelId
        ? guild.channels.cache.get(voiceState.channelId)
        : undefined;

      if (!guild || !channel) {
        const message = guild
          ? 'Join a voice channel first, then try again.'
          : "I can't access this server right now. Make sure I'm in the server.";
        try {
          await editInteractionResponse(
            process.env.APP_ID,
            req.body.token,
            message,
          );
        } catch (error) {
          console.error('Failed to respond to /join interaction:', error);
        }
        return;
      }

      let connection;
      try {
        await guild.members.fetchMe();
        connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: (methods) => guild.voiceAdapterCreator({
            ...methods,
            onVoiceStateUpdate: (packet) => {
              console.info(`[voice:${guild.id}] Adapter received bot voice-state update.`);
              methods.onVoiceStateUpdate(packet);
              configureVoiceNetworking(connection, guild.id);
            },
            onVoiceServerUpdate: (packet) => {
              console.info(
                `[voice:${guild.id}] Adapter received voice-server update (endpoint: ${packet.endpoint ? 'present' : 'missing'}).`,
              );
              methods.onVoiceServerUpdate(packet);
              configureVoiceNetworking(connection, guild.id);
            },
          }),
          debug: VOICE_DEBUG_ENABLED,
        });
        connection.on('error', (error) => {
          console.error(`[voice:${guild.id}] Voice connection error:`, error);
        });
        const observedNetworkings = new WeakSet();
        connection.on('stateChange', (oldState, newState) => {
          console.info(`[voice:${guild.id}] ${oldState.status} -> ${newState.status}`);
          const networking = newState.networking;
          if (!networking || observedNetworkings.has(networking)) return;

          observedNetworkings.add(networking);
          networking.on('stateChange', (oldNetworkingState, newNetworkingState) => {
            console.info(
              `[voice:${guild.id}] Voice network state: ${oldNetworkingState.code} -> ${newNetworkingState.code}`,
            );
          });
          networking.on('close', (code) => {
            console.error(`[voice:${guild.id}] Voice network WebSocket closed with code ${code}.`);
          });
        });
        if (VOICE_DEBUG_ENABLED) {
          connection.on('debug', (message) => {
            console.debug(`[voice:${guild.id}] ${redactVoiceDebug(message)}`);
          });
        }
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        resetVoiceIdleTimeout(guild.id, connection);
      } catch (error) {
        const connectionStatus = connection?.state.status ?? 'not created';
        const receivedStateUpdate = Boolean(connection?.packets.state);
        const receivedVoiceServerUpdate = Boolean(connection?.packets.server);
        connection?.destroy();
        console.error(
          `Failed to join voice channel ${channel.id} in guild ${guild.id} ` +
            `(state: ${connectionStatus}, voice state update: ${receivedStateUpdate}, ` +
            `voice server update: ${receivedVoiceServerUpdate}):`,
          error,
        );
        const message = error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR'
          ? `Discord's voice connection timed out while in the ${connectionStatus} state ` +
            `(voice state update: ${receivedStateUpdate ? 'received' : 'missing'}, ` +
            `voice server update: ${receivedVoiceServerUpdate ? 'received' : 'missing'}). Check the bot logs for connection details.`
          : 'The Discord voice connection failed. Check the bot logs for details.';
        try {
          await editInteractionResponse(
            process.env.APP_ID,
            req.body.token,
            message,
          );
        } catch (responseError) {
          console.error('Failed to respond to /join interaction:', responseError);
        }
        return;
      }

      try {
        await editInteractionResponse(
          process.env.APP_ID,
          req.body.token,
          `Joined <#${channel.id}>.`,
        );
      } catch (error) {
        console.error('Failed to respond to /join interaction:', error);
      }
      return;
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

await client.login(process.env.DISCORD_TOKEN);
if (!client.isReady()) {
  await new Promise((resolve) => client.once('clientReady', resolve));
}

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
