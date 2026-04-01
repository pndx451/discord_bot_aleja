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

function getVoiceJoinError(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    return 'Debes estar en un canal de voz.';
  }

  const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has('Connect')) {
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
    .setDescription('Reproduce musica desde YouTube o Spotify')
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
      await client.distube.play(voiceChannel, query, {
        member: interaction.member,
        textChannel: interaction.channel,
      });

      logVoiceDebug('play command joined voice successfully', {
        guildId: interaction.guildId,
        channelId: voiceChannel.id,
      });

      await interaction.editReply(`Buscando: **${query}**`);
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
          'No pude establecer la conexion de voz con Discord. Si el bot esta en Railway, lo mas probable es que el deploy no tenga soporte de red suficiente para Discord Voice.'
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
    const voiceChannel = interaction.member?.voice?.channel;
    const joinError = getVoiceJoinError(interaction);

    logVoiceDebug('join command received', {
      guildId: interaction.guildId,
      channelId: voiceChannel?.id ?? null,
      channelName: voiceChannel?.name ?? null,
      joinError,
    });

    if (joinError) {
      await interaction.reply({ content: joinError, ...ERROR_REPLY });
      return;
    }

    try {
      await client.distube.voices.join(voiceChannel);
      logVoiceDebug('join command joined voice successfully', {
        guildId: interaction.guildId,
        channelId: voiceChannel.id,
      });
      await interaction.reply(`Conectado a ${voiceChannel.name}`);
    } catch (error) {
      console.error('Join error:', error);
      logVoiceDebug('join command failed', {
        guildId: interaction.guildId,
        channelId: voiceChannel?.id ?? null,
        message: error.message,
        stack: error.stack,
      });
      await interaction.reply({ content: `Error: ${error.message}`, ...ERROR_REPLY });
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
