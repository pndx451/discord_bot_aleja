const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const ytsr = require('@distube/ytsr');

const VOICE_DEBUG = process.env.VOICE_DEBUG !== 'false';

const COLOR = {
  GREEN:  0x1DB954,
  BLUE:   0x5865F2,
  YELLOW: 0xFEE75C,
  RED:    0xED4245,
  GRAY:   0x747F8D,
};

function logVoiceDebug(message, extra) {
  if (!VOICE_DEBUG) return;
  extra === undefined ? console.log(`[VOICE] ${message}`) : console.log(`[VOICE] ${message}`, extra);
}

function getQueue(interaction, client) {
  return client.distube.getQueue(interaction.guildId);
}

function isUrl(value) {
  try { new URL(value); return true; } catch { return false; }
}

function isSpotifyUrl(value) {
  return isUrl(value) && value.includes('spotify.com');
}

function sanitizeYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const list = parsed.searchParams.get('list') || '';
    const startRadio = parsed.searchParams.get('start_radio');
    const isMix = list.startsWith('RDGMEM') || list.startsWith('RD') || startRadio === '1';
    if (isMix && parsed.searchParams.has('v')) {
      return `https://www.youtube.com/watch?v=${parsed.searchParams.get('v')}`;
    }
  } catch {}
  return url;
}

function errorEmbed(description) {
  return new EmbedBuilder().setColor(COLOR.RED).setDescription(`❌ ${description}`);
}

function successEmbed(description) {
  return new EmbedBuilder().setColor(COLOR.GREEN).setDescription(description);
}

function infoEmbed(description) {
  return new EmbedBuilder().setColor(COLOR.BLUE).setDescription(description);
}

function getVoiceJoinError(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) return 'Debes estar en un canal de voz para usar este comando.';
  const perms = vc.permissionsFor(interaction.guild.members.me);
  if (!perms?.has('ViewChannel')) return `No tengo permiso para ver **${vc.name}**.`;
  if (!perms.has('Connect'))      return `No tengo permiso para conectarme a **${vc.name}**.`;
  if (!perms.has('Speak'))        return `No tengo permiso para hablar en **${vc.name}**.`;
  if (vc.full && !perms.has('MoveMembers')) return `El canal **${vc.name}** esta lleno.`;
  return null;
}

async function resolveQuery(query, interaction, client) {
  query = sanitizeYouTubeUrl(query);

  if (isSpotifyUrl(query)) {
    const spotifyPlugin = client.distube.plugins.find(p => p?.constructor?.name === 'SpotifyPlugin');
    if (!spotifyPlugin) throw new Error('Spotify no esta configurado en este bot.');

    const resolved = await spotifyPlugin.resolve(query, {
      member: interaction.member,
      metadata: { requestedBy: interaction.user.username },
    });

    async function trackToUrl(song) {
      const q = spotifyPlugin.createSearchQuery
        ? spotifyPlugin.createSearchQuery(song)
        : `${song.name} ${song.artists?.[0]?.name || ''}`.trim();
      const res = await ytsr(q, { limit: 1 });
      return res?.items?.find(i => i.type === 'video')?.url || null;
    }

    if (resolved && !resolved.songs) {
      const url = await trackToUrl(resolved);
      if (!url) throw new Error('No encontre esta cancion en YouTube.');
      return url;
    }

    if (resolved?.songs?.length) {
      const tracks = resolved.songs.slice(0, 50);
      const urls = [];
      for (let i = 0; i < tracks.length; i += 5) {
        const batch = tracks.slice(i, i + 5);
        const results = await Promise.all(batch.map(s => trackToUrl(s).catch(() => null)));
        urls.push(...results.filter(Boolean));
      }
      if (!urls.length) throw new Error('No encontre ninguna cancion de la playlist en YouTube.');
      return { urls, name: resolved.name, thumbnail: resolved.thumbnail };
    }

    throw new Error('No pude resolver este link de Spotify.');
  }

  if (!isUrl(query)) {
    const res = await ytsr(query, { limit: 1 });
    const video = res?.items?.find(i => i.type === 'video');
    if (!video) throw new Error(`Sin resultados para: **${query}**`);
    return video.url;
  }

  return query;
}

// ── /play ────────────────────────────────────────────────────────────────────
const play = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Reproduce musica desde YouTube, Spotify o busqueda')
    .addStringOption(o =>
      o.setName('query').setDescription('Nombre, URL de YouTube o Spotify').setRequired(true)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();
    const query = interaction.options.getString('query', true);
    const voiceChannel = interaction.member?.voice?.channel;
    const joinError = getVoiceJoinError(interaction);

    logVoiceDebug('play command received', { guildId: interaction.guildId, query });

    if (joinError) return interaction.editReply({ embeds: [errorEmbed(joinError)] });

    try {
      const resolved = await resolveQuery(query, interaction, client);

      if (resolved && resolved.urls) {
        const { urls, name, thumbnail } = resolved;
        const [first, ...rest] = urls;

        await client.distube.play(voiceChannel, first, {
          member: interaction.member,
          textChannel: interaction.channel,
        });

        if (rest.length) {
          (async () => {
            let queue = null;
            for (let i = 0; i < 20; i++) {
              queue = client.distube.getQueue(interaction.guildId);
              if (queue) break;
              await new Promise(r => setTimeout(r, 300));
            }
            if (!queue) return;
            for (const url of rest) {
              try {
                await client.distube.play(voiceChannel, url, {
                  member: interaction.member,
                  textChannel: interaction.channel,
                });
              } catch {}
            }
          })();
        }

        const embed = new EmbedBuilder()
          .setColor(COLOR.GREEN)
          .setAuthor({ name: '📋  Playlist de Spotify encolada' })
          .setTitle(name)
          .setThumbnail(thumbnail || null)
          .addFields({ name: '🎵 Canciones', value: `${urls.length}`, inline: true })
          .setFooter({ text: `Pedido por ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

        return interaction.editReply({ embeds: [embed] });
      }

      await client.distube.play(voiceChannel, resolved, {
        member: interaction.member,
        textChannel: interaction.channel,
      });

      logVoiceDebug('play queued', { guildId: interaction.guildId });
      return interaction.editReply({ embeds: [infoEmbed(`🔍 Buscando **${query}**...`)] });

    } catch (error) {
      console.error('Play error:', error);
      logVoiceDebug('play failed', { message: error.message });

      if (error.errorCode === 'SPOTIFY_API_ERROR' ||
          (error.message || '').includes('private or unavailable') ||
          (error.message || '').includes('Resource not found')) {
        return interaction.editReply({ embeds: [errorEmbed(
          'Esta playlist de Spotify es **privada**.\n> Spotify → `...` → **Hacer publica** → volvé a intentarlo.'
        )] });
      }

      if ((error.message || '').includes('Cannot connect to the voice channel')) {
        return interaction.editReply({ embeds: [errorEmbed('No pude conectarme al canal de voz. Verifica los permisos.')] });
      }

      return interaction.editReply({ embeds: [errorEmbed(error.message || 'Error desconocido.')] });
    }
  },
};

// ── /skip ────────────────────────────────────────────────────────────────────
const skip = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Salta la cancion actual'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue) return interaction.reply({ embeds: [errorEmbed('No hay musica en reproduccion.')], ephemeral: true });

    try {
      const skipped = queue.songs[0];
      await queue.skip();
      return interaction.reply({ embeds: [successEmbed(`⏭ Saltada: **${skipped?.name || 'cancion'}**`)] });
    } catch (error) {
      return interaction.reply({ embeds: [errorEmbed(`No se pudo saltar: ${error.message}`)], ephemeral: true });
    }
  },
};

// ── /stop ────────────────────────────────────────────────────────────────────
const stop = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Detiene la musica y limpia la cola'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue) return interaction.reply({ embeds: [errorEmbed('No hay nada reproduciendose.')], ephemeral: true });

    await queue.stop();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLOR.RED).setDescription('⏹ Reproduccion detenida y cola limpiada.')] });
  },
};

// ── /pause ───────────────────────────────────────────────────────────────────
const pause = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pausa la reproduccion'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue) return interaction.reply({ embeds: [errorEmbed('No hay nada reproduciendose.')], ephemeral: true });
    if (queue.paused) return interaction.reply({ embeds: [infoEmbed('Ya esta pausado. Usa `/resume` para continuar.')], ephemeral: true });

    queue.pause();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLOR.YELLOW).setDescription(`⏸ Pausado: **${queue.songs[0]?.name || 'cancion'}**`)] });
  },
};

// ── /resume ──────────────────────────────────────────────────────────────────
const resume = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Reanuda la reproduccion'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue) return interaction.reply({ embeds: [errorEmbed('No hay nada en pausa.')], ephemeral: true });
    if (!queue.paused) return interaction.reply({ embeds: [infoEmbed('No esta pausado.')], ephemeral: true });

    queue.resume();
    return interaction.reply({ embeds: [successEmbed(`▶ Reanudado: **${queue.songs[0]?.name || 'cancion'}**`)] });
  },
};

// ── /queue ───────────────────────────────────────────────────────────────────
const queueCmd = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Muestra la cola actual')
    .addIntegerOption(o =>
      o.setName('pagina').setDescription('Numero de pagina').setMinValue(1)
    ),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue?.songs?.length) return interaction.reply({ embeds: [infoEmbed('La cola esta vacia.')], ephemeral: true });

    const PAGE_SIZE = 10;
    const page = Math.max(0, (interaction.options.getInteger('pagina') || 1) - 1);
    const [current, ...rest] = queue.songs;
    const totalPages = Math.max(1, Math.ceil(rest.length / PAGE_SIZE));
    const clampedPage = Math.min(page, totalPages - 1);
    const slice = rest.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);
    const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const totalDuration = queue.songs.reduce((acc, s) => acc + (s.duration || 0), 0);

    const embed = new EmbedBuilder()
      .setColor(COLOR.BLUE)
      .setAuthor({ name: `Cola de ${interaction.guild.name}`, iconURL: interaction.guild.iconURL() })
      .setThumbnail(current.thumbnail || null)
      .addFields({ name: '▶ Reproduciendo ahora', value: `[${current.name}](${current.url}) \`${current.formattedDuration}\`` });

    if (slice.length) {
      embed.addFields({
        name: `Proximas — Pagina ${clampedPage + 1}/${totalPages}`,
        value: slice.map((s, i) =>
          `\`${clampedPage * PAGE_SIZE + i + 1}.\` [${s.name}](${s.url}) \`${s.formattedDuration}\``
        ).join('\n'),
      });
    } else {
      embed.addFields({ name: 'Cola', value: 'No hay mas canciones.' });
    }

    embed.setFooter({ text: `${queue.songs.length} cancion(es) · Duracion total: ${fmt(totalDuration)}` });
    return interaction.reply({ embeds: [embed] });
  },
};

// ── /nowplaying ──────────────────────────────────────────────────────────────
const nowplaying = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Muestra la cancion actual con barra de progreso'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue?.songs?.length) return interaction.reply({ embeds: [infoEmbed('No hay nada reproduciendose.')], ephemeral: true });

    const song = queue.songs[0];
    const elapsed = queue.currentTime || 0;
    const total = song.duration || 0;
    const BAR = 20;
    const filled = total > 0 ? Math.round((elapsed / total) * BAR) : 0;
    const bar = '▓'.repeat(filled) + '░'.repeat(BAR - filled);
    const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const loopLabels = ['Off', 'Cancion', 'Cola'];

    const embed = new EmbedBuilder()
      .setColor(COLOR.GREEN)
      .setAuthor({ name: '▶  Reproduciendo ahora' })
      .setTitle(song.name)
      .setURL(song.url || null)
      .setThumbnail(song.thumbnail || null)
      .setDescription(`\`${fmt(elapsed)}\` ${bar} \`${fmt(total)}\``)
      .addFields(
        { name: '⏱ Duracion', value: song.formattedDuration || '?', inline: true },
        { name: '🔁 Loop', value: loopLabels[queue.repeatMode] || 'Off', inline: true },
        { name: '🔊 Volumen', value: `${queue.volume}%`, inline: true },
      );

    if (queue.songs.length > 1) {
      embed.addFields({ name: '⏭ Siguiente', value: queue.songs[1].name });
    }

    if (song.metadata?.requestedBy) {
      embed.setFooter({ text: `Pedido por ${song.metadata.requestedBy}` });
    }

    return interaction.reply({ embeds: [embed] });
  },
};

// ── /volume ──────────────────────────────────────────────────────────────────
const volume = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Ajusta el volumen (0-100)')
    .addIntegerOption(o =>
      o.setName('nivel').setDescription('Nivel de volumen').setMinValue(0).setMaxValue(100).setRequired(true)
    ),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue) return interaction.reply({ embeds: [errorEmbed('No hay nada reproduciendose.')], ephemeral: true });

    const level = interaction.options.getInteger('nivel', true);
    queue.setVolume(level);
    const bars = Math.round(level / 10);
    const bar = '🟩'.repeat(bars) + '⬛'.repeat(10 - bars);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLOR.BLUE).setDescription(`${bar}\n**Volumen:** ${level}%`)] });
  },
};

// ── /loop ────────────────────────────────────────────────────────────────────
const loop = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Cambia el modo de repeticion')
    .addStringOption(o =>
      o.setName('modo').setDescription('Modo de loop').setRequired(true)
        .addChoices(
          { name: 'Off', value: '0' },
          { name: 'Cancion actual', value: '1' },
          { name: 'Toda la cola', value: '2' },
        )
    ),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue) return interaction.reply({ embeds: [errorEmbed('No hay nada reproduciendose.')], ephemeral: true });

    const mode = parseInt(interaction.options.getString('modo', true));
    queue.setRepeatMode(mode);
    const labels = ['🚫 Loop desactivado', '🔂 Repitiendo cancion actual', '🔁 Repitiendo toda la cola'];
    return interaction.reply({ embeds: [successEmbed(labels[mode])] });
  },
};

// ── /shuffle ─────────────────────────────────────────────────────────────────
const shuffle = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Mezcla las canciones en la cola'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (!queue || queue.songs.length < 2) {
      return interaction.reply({ embeds: [errorEmbed('No hay suficientes canciones en la cola para mezclar.')], ephemeral: true });
    }
    await queue.shuffle();
    return interaction.reply({ embeds: [successEmbed(`🔀 Cola mezclada · **${queue.songs.length - 1}** canciones reordenadas.`)] });
  },
};

// ── /join ────────────────────────────────────────────────────────────────────
const join = {
  data: new SlashCommandBuilder().setName('join').setDescription('Conecta el bot a tu canal de voz'),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: true });
    const voiceChannel = interaction.member?.voice?.channel;
    const joinError = getVoiceJoinError(interaction);
    if (joinError) return interaction.editReply({ embeds: [errorEmbed(joinError)] });

    try {
      await client.distube.voices.join(voiceChannel);
      return interaction.editReply({ embeds: [successEmbed(`Conectado a **${voiceChannel.name}**`)] });
    } catch (error) {
      return interaction.editReply({ embeds: [errorEmbed(error.message)] });
    }
  },
};

// ── /leave ───────────────────────────────────────────────────────────────────
const leave = {
  data: new SlashCommandBuilder().setName('leave').setDescription('Desconecta el bot del canal de voz'),

  async execute(interaction, client) {
    const queue = getQueue(interaction, client);
    if (queue) await queue.stop();
    client.distube.voices.get(interaction.guildId)?.leave();
    return interaction.reply({ embeds: [infoEmbed('👋 Desconectado del canal de voz.')] });
  },
};

module.exports = [
  play, skip, stop, pause, resume,
  queueCmd, nowplaying, volume, loop, shuffle,
  join, leave,
];
