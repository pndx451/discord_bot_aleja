const { SlashCommandBuilder } = require('discord.js');

const ERROR_REPLY = { ephemeral: true };
const VOICE_DEBUG = process.env.VOICE_DEBUG !== 'false';

function logVoiceDebug(message, extra) {
  if (!VOICE_DEBUG) return;

  if (extra === undefined) {
    console.log(`[VOICE] ${message}`);
    return;
  }

  console.log(`[VOICE] ${message}`, extra);
}

function getQueue(interaction, client) {
  return client.distube.getQueue(interaction.guildId);
}

function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isSpotifyUrl(value) {
  return isUrl(value) && value.includes('spotify.com');
}

function isSoundCloudUrl(value) {
  return isUrl(value) && value.includes('soundcloud.com');
}

function isYouTubeUrl(value) {
  return isUrl(value) && (value.includes('youtube.com') || value.includes('youtu.be'));
}

function getPlugin(client, name) {
  return client.distube.plugins.find(plugin => plugin?.constructor?.name === name);
}

async function searchSoundCloudTrack(query, interaction, client) {
  const soundCloudPlugin = getPlugin(client, 'SoundCloudPlugin');
  if (!soundCloudPlugin) {
    throw new Error('No se encontro SoundCloudPlugin en la configuracion del bot.');
  }

  logVoiceDebug('searching SoundCloud', {
    guildId: interaction.guildId,
    query,
  });

  const song = await soundCloudPlugin.searchSong(query, {
    member: interaction.member,
    metadata: { requestedBy: interaction.user.id },
  });

  if (!song) {
    throw new Error('No encontre resultados reproducibles en SoundCloud para esa busqueda.');
  }

  return song;
}

async function resolveSpotifyTracks(query, interaction, client) {
  const spotifyPlugin = getPlugin(client, 'SpotifyPlugin');
  if (!spotifyPlugin) {
    throw new Error(
      'Este bot no tiene Spotify configurado. Agrega SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET.'
    );
  }

  const resolved = await spotifyPlugin.resolve(query, {
    member: interaction.member,
    metadata: { requestedBy: interaction.user.id },
  });

  const sourceSongs = Array.isArray(resolved?.songs) ? resolved.songs : [resolved];
  const playableSongs = [];
  const maxTracks = 10;

  for (const song of sourceSongs.slice(0, maxTracks)) {
    try {
      const searchQuery = spotifyPlugin.createSearchQuery(song);
      const playableSong = await searchSoundCloudTrack(searchQuery, interaction, client);
      if (playableSong) playableSongs.push(playableSong);
    } catch (error) {
      logVoiceDebug('spotify song resolution failed', {
        guildId: interaction.guildId,
        song: song?.name,
        message: error.message,
      });
    }
  }

  return playableSongs;
}

async function resolvePlayableSongs(query, interaction, client) {
  if (isSpotifyUrl(query)) {
    return resolveSpotifyTracks(query, interaction, client);
  }

  if (isYouTubeUrl(query)) {
    throw new Error(
      'Los links de YouTube no son compatibles de forma estable en este deploy. Usa una busqueda normal o un link de SoundCloud.'
    );
  }

  if (isSoundCloudUrl(query)) {
    return [query];
  }

  return [await searchSoundCloudTrack(query, interaction, client)];
}

function getVoiceJoinError(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    return 'Debes estar en un canal de voz.';
  }

  const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has('ViewChannel')) {
    return `No tengo permiso para ver **${voiceChannel.name}**.`;
  }

  if (!permissions.has('Connect')) {
    return `No tengo permiso para conectarme a **${voiceChannel.name}**.`;
  }

  if (!permissions.has('Speak')) {
    return `No tengo permiso para hablar en **${voiceChannel.name}**.`;
  }

  if (voiceChannel.full && !permissions.has('MoveMembers')) {
    return `El canal **${voiceChannel.name}** esta lleno y no puedo entrar.`;
  }

  return null;
}

const play = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Reproduce musica desde SoundCloud o una busqueda normal')
    .addStringOption(option =>
      option.setName('query').setDescription('Nombre o URL').setRequired(true)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const query = interaction.options.getString('query', true);
    const voiceChannel = interaction.member?.voice?.channel;
    const joinError = getVoiceJoinError(interaction);

    logVoiceDebug('play command received', {
      guildId: interaction.guildId,
      channelId: voiceChannel?.id ?? null,
      channelName: voiceChannel?.name ?? null,
      query,
      joinError,
    });

    if (joinError) {
      await interaction.editReply(joinError);
      return;
    }

    try {
      const songs = await resolvePlayableSongs(query, interaction, client);
      if (!songs.length) {
        throw new Error('No pude encontrar una fuente reproducible para esa busqueda.');
      }

      const queue = getQueue(interaction, client);
      const [firstSong, ...restSongs] = songs;

      if (queue) {
        queue.addToQueue(songs);
        await interaction.editReply(
          songs.length === 1
            ? `Agregado a la cola: **${firstSong.name || query}**`
            : `Agregadas ${songs.length} canciones a la cola.`
        );
        return;
      }

      await client.distube.play(voiceChannel, firstSong, {
        member: interaction.member,
        textChannel: interaction.channel,
      });

      if (restSongs.length) {
        client.distube.getQueue(interaction.guildId)?.addToQueue(restSongs);
      }

      logVoiceDebug('play command queued successfully', {
        guildId: interaction.guildId,
        channelId: voiceChannel.id,
        songs: songs.length,
      });

      await interaction.editReply(
        songs.length === 1
          ? `Reproduciendo o encolando: **${firstSong.name || query}**`
          : `Reproduciendo y agregando ${songs.length} canciones a la cola.`
      );
    } catch (error) {
      console.error('Play error:', error);
      logVoiceDebug('play command failed', {
        guildId: interaction.guildId,
        channelId: voiceChannel?.id ?? null,
        message: error.message,
        stack: error.stack,
      });

      if (error.message.includes('Cannot connect to the voice channel after 30 seconds')) {
        await interaction.editReply(
          'No pude establecer la conexion de voz con Discord. Verifica permisos y el estado del canal.'
        );
        return;
      }

      if (
        error.message.includes('SOUNDCLOUD_PLUGIN_RATE_LIMITED') ||
        error.message.includes('Reached SoundCloud rate limits')
      ) {
        await interaction.editReply(
          'SoundCloud esta limitando las reproducciones desde este host. Si quieres mas estabilidad, configura SOUNDCLOUD_CLIENT_ID y opcionalmente SOUNDCLOUD_OAUTH_TOKEN en el deploy.'
        );
        return;
      }

      await interaction.editReply(`Error: ${error.message}`);
    }
  },
};

const skip = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Salta la cancion actual'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (!queue) {
      await interaction.reply({ content: 'No hay musica en reproduccion.', ...ERROR_REPLY });
      return;
    }

    try {
      await queue.skip();
      await interaction.reply('Cancion saltada.');
    } catch (error) {
      await interaction.reply({ content: `No se pudo saltar: ${error.message}`, ...ERROR_REPLY });
    }
  },
};

const stop = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Detiene la musica'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (!queue) {
      await interaction.reply({ content: 'Nada reproduciendose.', ...ERROR_REPLY });
      return;
    }

    await queue.stop();
    await interaction.reply('Reproduccion detenida.');
  },
};

const pause = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pausa la reproduccion'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (!queue) {
      await interaction.reply({ content: 'Nada reproduciendose.', ...ERROR_REPLY });
      return;
    }

    queue.pause();
    await interaction.reply('Pausado.');
  },
};

const resume = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Reanuda la reproduccion'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (!queue) {
      await interaction.reply({ content: 'No hay musica en pausa.', ...ERROR_REPLY });
      return;
    }

    queue.resume();
    await interaction.reply('Reanudado.');
  },
};

const queueCmd = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Muestra la cola actual'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (!queue || !queue.songs.length) {
      await interaction.reply({ content: 'La cola esta vacia.', ...ERROR_REPLY });
      return;
    }

    const [currentSong, ...nextSongs] = queue.songs;
    let message = `**Ahora:** ${currentSong.name} \`[${currentSong.formattedDuration}]\`\n\n`;

    if (nextSongs.length) {
      message += nextSongs
        .slice(0, 10)
        .map((song, index) => `\`${index + 1}.\` ${song.name}`)
        .join('\n');
    } else {
      message += 'No hay mas canciones en cola.';
    }

    await interaction.reply(message);
  },
};

const volume = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Ajusta el volumen')
    .addIntegerOption(option =>
      option
        .setName('nivel')
        .setDescription('Nivel entre 0 y 100')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true)
    ),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (!queue) {
      await interaction.reply({ content: 'Nada reproduciendose.', ...ERROR_REPLY });
      return;
    }

    const level = interaction.options.getInteger('nivel', true);
    queue.setVolume(level);

    await interaction.reply(`Volumen: ${level}%`);
  },
};

const loop = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Activa o desactiva el bucle de la cola'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (!queue) {
      await interaction.reply({ content: 'Nada reproduciendose.', ...ERROR_REPLY });
      return;
    }

    const nextMode = queue.repeatMode ? 0 : 2;
    queue.setRepeatMode(nextMode);

    await interaction.reply(
      nextMode === 2 ? 'Bucle activado para toda la cola.' : 'Bucle desactivado.'
    );
  },
};

const join = {
  data: new SlashCommandBuilder().setName('join').setDescription('Conecta el bot al canal actual'),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: true });

    const voiceChannel = interaction.member?.voice?.channel;
    const joinError = getVoiceJoinError(interaction);

    logVoiceDebug('join command received', {
      guildId: interaction.guildId,
      channelId: voiceChannel?.id ?? null,
      channelName: voiceChannel?.name ?? null,
      joinError,
    });

    if (joinError) {
      await interaction.editReply({ content: joinError });
      return;
    }

    try {
      await client.distube.voices.join(voiceChannel);
      logVoiceDebug('join command joined voice successfully', {
        guildId: interaction.guildId,
        channelId: voiceChannel.id,
      });
      await interaction.editReply(`Conectado a ${voiceChannel.name}`);
    } catch (error) {
      console.error('Join error:', error);
      logVoiceDebug('join command failed', {
        guildId: interaction.guildId,
        channelId: voiceChannel?.id ?? null,
        message: error.message,
        stack: error.stack,
      });
      await interaction.editReply({ content: `Error: ${error.message}` });
    }
  },
};

const leave = {
  data: new SlashCommandBuilder().setName('leave').setDescription('Desconecta el bot del canal'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);

    if (queue) {
      await queue.stop();
    }

    client.distube.voices.get(interaction.guildId)?.leave();
    await interaction.reply('Desconectado.');
  },
};

module.exports = [
  play,
  skip,
  stop,
  pause,
  resume,
  queueCmd,
  volume,
  loop,
  join,
  leave,
];
