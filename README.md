# MichaelPhone Discord Bot

MichaelPhone is a Discord bot that can join a server voice channel and read your
direct messages aloud using Windows' built-in speech synthesis. It also retains
the original rock-paper-scissors example commands.

## Features

- `/join` connects the bot to the voice channel you're currently in.
- `/disconnect` makes the bot leave its voice channel in the current server.
- DM the bot while you share a voice channel with it, and it reads your message
  aloud. If you're in more than one server where the bot is connected, it uses
  the connection with the most recent activity.
- The bot disconnects after 30 minutes without a successful `/join` or spoken
  DM. Either activity restarts the idle timer.
- `/challenge` starts a rock-paper-scissors match, and `/test` is a basic test
  command.

Speech synthesis runs locally through Windows Speech; no cloud TTS service or
key is needed. The bot must run on Windows for speech playback.

## Requirements

- Node.js 18 or later
- A Discord application and bot
- A public HTTPS endpoint for Discord interactions (a tunnel such as ngrok is
  suitable for local development)
- Bot permissions for Send Messages, Connect, and Speak

The bot uses the `Guilds`, `Guild Voice States`, and `Direct Messages` Gateway
intents. Its voice connection uses `@discordjs/voice` with DAVE (Discord's
end-to-end voice encryption protocol) support.

## Configure

Install dependencies from the repository root:

```powershell
npm install
```

Create a `.env` file in the repository root with your Discord application's
credentials:

```dotenv
APP_ID=your_application_id
DISCORD_TOKEN=your_bot_token
PUBLIC_KEY=your_application_public_key
PORT=3000
```

Keep the bot token private and do not commit `.env`. `PORT` is optional; the
server defaults to port `3000`. For additional voice-library handshake logs,
you can also set:

```dotenv
VOICE_DEBUG=true
```

## Publish commands and run

Register the slash commands with your Discord application:

```powershell
npm run register
```

This publishes the command list defined in `commands.js` as global commands.
Registration errors are reported in the console. Start the bot with:

```powershell
npm start
```

For local development, expose the app's port using an HTTPS tunnel, then set
your Discord application's **Interactions Endpoint URL** to the tunnel URL
with `/interactions` appended (for example,
`https://your-tunnel.example/interactions`). Keep the bot process running while
using the app.

## Voice connection troubleshooting

The bot logs voice connection state changes and whether Discord's voice-state
and voice-server handshake updates were received. Set `VOICE_DEBUG=true` and
restart the bot to enable additional voice-library diagnostics.

If a join times out after both handshake updates were received, check the
following voice-network log lines for WebSocket close codes. Close code `4017`
means the voice channel requires DAVE end-to-end encryption support; make sure
the bot is running with the current `@discordjs/voice` dependency and restart
it after installing dependencies.
