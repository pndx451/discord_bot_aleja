const { SlashCommandBuilder } = require('discord.js');

const ERROR_REPLY = { ephemeral: true };

function getQueue(interaction, client) {
  return client.distube.getQueue(interaction.guildId);
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

    if (!voiceChannel) {
      await interaction.editReply('Debes estar en un canal de voz.');
      return;
    }

    try {
      await client.distube.play(voiceChannel, query, {
        member: interaction.member,
        textChannel: interaction.channel,
      });

      await interaction.editReply(`Buscando: **${query}**`);
    } catch (error) {
      console.error('Play error:', error);
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

    if (!voiceChannel) {
      await interaction.reply({ content: 'Debes estar en un canal de voz.', ...ERROR_REPLY });
      return;
    }

    try {
      await client.distube.voices.join(voiceChannel);
      await interaction.reply(`Conectado a ${voiceChannel.name}`);
    } catch (error) {
      console.error('Join error:', error);
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
