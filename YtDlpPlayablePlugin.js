const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  PlayableExtractorPlugin,
  DisTubeError,
  Song,
  Playlist,
} = require('distube');

const ytDlpPackageDir = path.dirname(require.resolve('@distube/yt-dlp/package.json'));
const ytDlpDir = process.env.YTDLP_DIR || path.join(ytDlpPackageDir, 'bin');
const ytDlpFilename =
  process.env.YTDLP_FILENAME ||
  (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux');
const ytDlpPath = path.join(ytDlpDir, ytDlpFilename);

function buildArgs(input, flags = {}) {
  const args = [input];

  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === false) continue;

    const flag = `--${key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}`;
    if (value === true) {
      args.push(flag);
      continue;
    }

    args.push(flag, String(value));
  }

  return args;
}

function runYtDlpJson(input, flags = {}) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(
      ytDlpPath,
      buildArgs(input, {
        dumpSingleJson: true,
        noWarnings: true,
        noCallHome: true,
        preferFreeFormats: true,
        skipDownload: true,
        simulate: true,
        quiet: true,
        ...flags,
      }),
      {
        env: process.env,
      }
    );

    let stdout = '';
    let stderr = '';

    processHandle.stdout?.on('data', chunk => {
      stdout += chunk;
    });

    processHandle.stderr?.on('data', chunk => {
      stderr += chunk;
    });

    processHandle.on('error', reject);
    processHandle.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `yt-dlp exited with code ${code}`));
        return;
      }

      const output = stdout.trim();
      const jsonLine =
        output
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .find(line => line.startsWith('{') || line.startsWith('[')) || output;

      try {
        resolve(JSON.parse(jsonLine));
      } catch (error) {
        reject(new Error(`Invalid yt-dlp JSON output: ${jsonLine.slice(0, 200)}`));
      }
    });
  });
}

function isPlaylist(info) {
  return Array.isArray(info?.entries);
}

class YtDlpPlugin extends PlayableExtractorPlugin {
  async validate() {
    return true;
  }

  async resolve(input, options = {}) {
    const info = await runYtDlpJson(input).catch(error => {
      throw new DisTubeError('YTDLP_ERROR', String(error.message || error));
    });

    if (isPlaylist(info)) {
      const songs = info.entries
        .filter(Boolean)
        .map(entry => new YtDlpSong(this, entry, options));

      if (!songs.length) {
        throw new DisTubeError('YTDLP_ERROR', 'The playlist is empty');
      }

      return new Playlist(
        {
          source: info.extractor || 'youtube',
          songs,
          id: String(info.id),
          name: info.title,
          url: info.webpage_url,
          thumbnail: info.thumbnails?.[0]?.url,
        },
        options
      );
    }

    return new YtDlpSong(this, info, options);
  }

  async getStreamURL(song) {
    if (!song.url) {
      throw new DisTubeError('YTDLP_PLUGIN_INVALID_SONG', 'Cannot get stream URL from invalid song.');
    }

    const info = await runYtDlpJson(song.url, {
      format: 'ba/ba*',
    }).catch(error => {
      throw new DisTubeError('YTDLP_ERROR', String(error.message || error));
    });

    if (isPlaylist(info)) {
      throw new DisTubeError('YTDLP_ERROR', 'Cannot get stream URL of a playlist');
    }

    if (!info.url) {
      throw new DisTubeError('YTDLP_ERROR', 'Failed to find any playable formats');
    }

    return info.url;
  }

  getRelatedSongs() {
    return [];
  }
}

class YtDlpSong extends Song {
  constructor(plugin, info, options = {}) {
    super(
      {
        plugin,
        source: info.extractor || 'youtube',
        playFromSource: true,
        id: String(info.id),
        name: info.title || info.fulltitle,
        url: info.webpage_url || info.original_url,
        isLive: Boolean(info.is_live),
        thumbnail: info.thumbnail || info.thumbnails?.[0]?.url,
        duration: info.is_live ? 0 : info.duration,
        uploader: {
          name: info.uploader,
          url: info.uploader_url,
        },
        views: info.view_count,
        likes: info.like_count,
        dislikes: info.dislike_count,
        reposts: info.repost_count,
        ageRestricted: Boolean(info.age_limit) && info.age_limit >= 18,
      },
      options
    );
  }
}

module.exports = { YtDlpPlugin, ytDlpPath };
