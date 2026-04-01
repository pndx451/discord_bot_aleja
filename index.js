const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { DisTube } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { SpotifyPlugin } = require('@distube/spotify');
const ffmpegStaticPath = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');
require('dotenv').config();

const ffmpegPath =
  process.env.FFMPEG_PATH ||
  ffmpegStaticPath;

process.env.FFMPEG_PATH = ffmpegPath;
const VOICE_DEBUG = process.env.VOICE_DEBUG !== 'false';

function logVoiceDebug(message, extra) {
  if (!VOICE_DEBUG) return;

  if (extra === undefined) {
    console.log(`[VOICE] ${message}`);
    return;
  }

  console.log(`[VOICE] ${message}`, extra);
}

if (!process.env.DISCORD_TOKEN) {
  console.error('Falta la variable de entorno DISCORD_TOKEN.');
  process.exit(1);
}

const distubePlugins = [
  new YtDlpPlugin({
    update: false, // Railway ya tiene yt-dlp instalado, no actualizar en cada inicio
  }),
];

if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  distubePlugins.unshift(
    new SpotifyPlugin({
      api: {
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      },
      // SpotifyPlugin buscará en YouTube automáticamente via yt-dlp
    })
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.distube = new DisTube(client, {
  emitNewSongOnly: true,
  joinNewVoiceChannel: true,
  ffmpeg: {
    path: ffmpegPath,
  },
  plugins: distubePlugins,
});

client.distube
  .on('initQueue', queue => {
    logVoiceDebug('initQueue', {
      guildId: queue.id,
      channelId: queue.voiceChannel?.id,
      textChannelId: queue.textChannel?.id,
    });

    queue.voice
      .on('debug', debug => {
        logVoiceDebug('queue.voice debug', {
          guildId: queue.id,
          debug,
        });
      })
      .on('disconnect', error => {
        logVoiceDebug('queue.voice disconnect', {
          guildId: queue.id,
          message: error?.message,
        });
      })
      .on('error', error => {
        logVoiceDebug('queue.voice error', {
          guildId: queue.id,
          message: error.message,
          stack: error.stack,
        });
      })
      .on('finish', () => {
        logVoiceDebug('queue.voice finish', {
          guildId: queue.id,
        });
      });
  })
  .on('playSong', (queue, song) => {
    logVoiceDebug('playSong', {
      guildId: queue.id,
      channelId: queue.voiceChannel?.id,
      song: song.name,
    });
    queue.textChannel?.send(`Reproduciendo: **${song.name}** \`[${song.formattedDuration}]\``);
  })
  .on('addSong', (queue, song) => {
    queue.textChannel?.send(`Agregado: **${song.name}** \`[${song.formattedDuration}]\``);
  })
  .on('addList', (queue, playlist) => {
    queue.textChannel?.send(`Playlist: **${playlist.name}** - ${playlist.songs.length} canciones`);
  })
  .on('finish', queue => {
    queue.textChannel?.send('Cola terminada.');
  })
  .on('ffmpegDebug', debug => {
    logVoiceDebug('ffmpegDebug', debug);
  })
  .on('debug', debug => {
    logVoiceDebug('distubeDebug', debug);
  })
  .on('error', (error, queue, song) => {
    logVoiceDebug('distube error', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      guildId: queue?.id,
      channelId: queue?.textChannel?.id,
      song: song?.name,
    });
    console.error('DisTube error:', error);

    if (queue?.textChannel?.send) {
      queue.textChannel.send(`Error: ${error.message}`);
    }
  });

const commands = require('./commands');
client.commands = new Collection();

for (const command of commands) {
  client.commands.set(command.data.name, command);
}

client.once('clientReady', async () => {
  console.log(`Bot listo como ${client.user.tag}`);
  logVoiceDebug('ready', { userId: client.user.id });

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map(command => command.data.toJSON()),
    });
    console.log('Slash commands registrados.');
  } catch (error) {
    console.error('Error registrando comandos:', error);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const botUserId = client.user?.id;
  const memberId = newState.id ?? oldState.id;

  if (memberId !== botUserId) return;

  logVoiceDebug('voiceStateUpdate', {
    guildId: newState.guild.id,
    oldChannelId: oldState.channelId,
    newChannelId: newState.channelId,
    sessionId: newState.sessionId,
    selfMute: newState.selfMute,
    selfDeaf: newState.selfDeaf,
  });
});

client.on('raw', packet => {
  const botUserId = client.user?.id;

  if (packet.t === 'VOICE_SERVER_UPDATE') {
    logVoiceDebug('VOICE_SERVER_UPDATE', {
      guildId: packet.d.guild_id,
      endpoint: packet.d.endpoint,
      tokenPreview: packet.d.token ? `${packet.d.token.slice(0, 8)}...` : null,
    });
  }

  if (packet.t === 'VOICE_STATE_UPDATE' && packet.d.user_id === botUserId) {
    logVoiceDebug('RAW VOICE_STATE_UPDATE', {
      guildId: packet.d.guild_id,
      channelId: packet.d.channel_id,
      sessionId: packet.d.session_id,
    });
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error('Command error:', error);

    if (error.code === 10062) {
      logVoiceDebug('interaction expired before response', {
        commandName: interaction.commandName,
        guildId: interaction.guildId,
      });
      return;
    }

    const response = {
      content: `Error: ${error.message}`,
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response);
      return;
    }

    await interaction.reply(response);
  }
});

client.on('error', error => {
  console.error('Client error:', error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
});

async function bootstrap() {
  await sodium.ready;
  logVoiceDebug('libsodium ready');
  logVoiceDebug('ffmpeg configured', { path: ffmpegPath });
  await client.login(process.env.DISCORD_TOKEN);
}

bootstrap().catch(error => {
  console.error('Fallo al iniciar el bot:', error);
  process.exit(1);
});
