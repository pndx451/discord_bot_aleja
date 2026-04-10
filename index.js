// Monkey-patch child_process.spawn para filtrar --no-call-home antes de que llegue a yt-dlp
const { spawn: originalSpawn } = require('child_process');
require('child_process').spawn = function(cmd, args, opts) {
  if (Array.isArray(args)) {
    args = args.filter(a => a !== '--no-call-home');
  }
  return originalSpawn(cmd, args, opts);
};

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { DisTube } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { SpotifyPlugin } = require('@distube/spotify');
const ffmpegStaticPath = require('ffmpeg-static');
const sodium = require('libsodium-wrappers');
require('dotenv').config();

// En Linux usamos el ffmpeg del sistema (más estable en servidores).
// ffmpeg-static causa SIGSEGV en algunos entornos cloud.
const ffmpegPath =
  process.env.FFMPEG_PATH ||
  (process.platform === 'linux' ? 'ffmpeg' : ffmpegStaticPath);

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


// Si hay cookies configuradas, escribirlas a un archivo para yt-dlp
// Soporta tanto texto plano (YOUTUBE_COOKIES) como base64 (YOUTUBE_COOKIES_B64)
const cookiesFile = '/tmp/yt-dlp-cookies.txt';
const fs = require('fs');

let cookiesRaw = null;
if (process.env.YOUTUBE_COOKIES_B64) {
  cookiesRaw = Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64').toString('utf8');
  console.log('[YTDLP] Cookies decodificadas desde YOUTUBE_COOKIES_B64');
} else if (process.env.YOUTUBE_COOKIES) {
  cookiesRaw = process.env.YOUTUBE_COOKIES;
  console.log('[YTDLP] Cookies leidas desde YOUTUBE_COOKIES');
}

if (cookiesRaw) {
  fs.writeFileSync(cookiesFile, cookiesRaw);
  const lines = cookiesRaw.split('\n').filter(l => l && !l.startsWith('#')).length;
  console.log('[YTDLP] Cookies escritas en', cookiesFile, '(' + lines + ' entradas)');
}

const ytDlpArgs = [
  '--no-check-certificate',
  '--geo-bypass',
  '--extractor-retries', '3',
  ...(cookiesRaw ? ['--cookies', cookiesFile] : []),
];

// Debug: verificar cookies al arrancar
if (cookiesRaw) {
  try {
    const stat = fs.statSync(cookiesFile);
    console.log('[YTDLP] Cookies OK - archivo:', stat.size, 'bytes - args:', ytDlpArgs.join(' '));
  } catch (e) {
    console.error('[YTDLP] ERROR verificando cookies:', e.message);
  }
} else {
  console.warn('[YTDLP] SIN COOKIES - configura YOUTUBE_COOKIES o YOUTUBE_COOKIES_B64 en Railway');
}

const distubePlugins = [];

if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  // Spotify va ANTES de YtDlpPlugin (YtDlpPlugin debe ser el último)
  distubePlugins.push(
    new SpotifyPlugin({
      api: {
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      },
    })
  );
}

// YtDlpPlugin siempre debe ser el último plugin
distubePlugins.push(
  new YtDlpPlugin({
    update: false,
    ytdlpArgs: ytDlpArgs,
  })
);

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

    const { EmbedBuilder } = require('discord.js');
    const requestedBy = song.metadata?.requestedBy
      ? `<@${song.metadata.requestedBy}>`
      : null;

    const embed = new EmbedBuilder()
      .setColor(0x1DB954)
      .setAuthor({ name: '▶  Reproduciendo ahora' })
      .setTitle(song.name || 'Desconocido')
      .setURL(song.url || null)
      .setThumbnail(song.thumbnail || null)
      .addFields(
        { name: '⏱ Duración', value: song.formattedDuration || '?', inline: true },
        { name: '🔊 Canal', value: queue.voiceChannel?.name || '?', inline: true },
      );

    if (requestedBy) embed.addFields({ name: '👤 Pedido por', value: requestedBy, inline: true });
    if (queue.songs.length > 1) embed.setFooter({ text: `${queue.songs.length - 1} canción(es) en cola` });

    queue.textChannel?.send({ embeds: [embed] });
  })
  .on('addSong', (queue, song) => {
    const { EmbedBuilder } = require('discord.js');
    const position = queue.songs.length - 1;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setAuthor({ name: '➕  Agregado a la cola' })
      .setTitle(song.name || 'Desconocido')
      .setURL(song.url || null)
      .setThumbnail(song.thumbnail || null)
      .addFields(
        { name: '⏱ Duración', value: song.formattedDuration || '?', inline: true },
        { name: '📋 Posición', value: `#${position}`, inline: true },
      );

    queue.textChannel?.send({ embeds: [embed] });
  })
  .on('addList', (queue, playlist) => {
    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setAuthor({ name: '📋  Playlist agregada' })
      .setTitle(playlist.name || 'Playlist')
      .setThumbnail(playlist.thumbnail || playlist.songs[0]?.thumbnail || null)
      .addFields(
        { name: '🎵 Canciones', value: `${playlist.songs.length}`, inline: true },
      );

    queue.textChannel?.send({ embeds: [embed] });
  })
  .on('finish', queue => {
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setColor(0x747F8D)
      .setDescription('✅ Cola terminada. ¡Hasta la próxima!');
    queue.textChannel?.send({ embeds: [embed] });
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
