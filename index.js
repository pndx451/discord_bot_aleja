const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { DisTube } = require('distube');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { SpotifyPlugin } = require('@distube/spotify');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config();

process.env.FFMPEG_PATH = ffmpegPath;

if (!process.env.DISCORD_TOKEN) {
  console.error('Falta la variable de entorno DISCORD_TOKEN.');
  process.exit(1);
}

const distubePlugins = [new YtDlpPlugin()];

if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  distubePlugins.unshift(
    new SpotifyPlugin({
      api: {
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      },
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
  .on('playSong', (queue, song) => {
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
  .on('error', (textChannel, error) => {
    console.error('DisTube error:', error);
    textChannel?.send(`Error: ${error.message}`);
  });

const commands = require('./commands');
client.commands = new Collection();

for (const command of commands) {
  client.commands.set(command.data.name, command);
}

client.once('ready', async () => {
  console.log(`Bot listo como ${client.user.tag}`);

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

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error('Command error:', error);

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

client.login(process.env.DISCORD_TOKEN);
