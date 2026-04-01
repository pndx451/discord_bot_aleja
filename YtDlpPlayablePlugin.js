const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  PlayableExtractorPlugin,
  DisTubeError,
  Song,
  Playlist,
} = require('distube');

const ytDlpMainPath = require.resolve('@distube/yt-dlp');
const ytDlpPackageDir = path.resolve(path.dirname(ytDlpMainPath), '..');
const ytDlpDir = process.env.YTDLP_DIR || path.join(ytDlpPackageDir, 'bin');
const ytDlpFilename =
  process.env.YTDLP_FILENAME ||
  (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux');
const ytDlpPath = path.join(ytDlpDir, ytDlpFilename);
const cookiesPath = path.join(os.tmpdir(), 'yt-dlp-youtube-cookies.txt');
const ytExtractorArgs =
  process.env.YTDLP_EXTRACTOR_ARGS ||
  'youtube:player_client=tv_downgraded,web_safari,android_vr;formats=missing_pot,incomplete';

function parseYouTubeCookies(rawCookies) {
  if (!rawCookies) return undefined;

  try {
    const parsed = JSON.parse(rawCookies);
    if (!Array.isArray(parsed)) return undefined;

    return parsed
      .filter(cookie => cookie?.name && cookie?.value)
      .map(cookie => ({
        domain: cookie.domain,
        path: cookie.path ?? '/',
        secure: Boolean(cookie.secure),
        expires:
          typeof cookie.expires === 'number'
            ? cookie.expires
            : typeof cookie.expirationDate === 'number'
              ? cookie.expirationDate
              : 0,
        name: cookie.name,
        value: cookie.value,
      }));
  } catch {
    return undefined;
  }
}

function getCookiesFile() {
  const cookies = parseYouTubeCookies(process.env.YOUTUBE_COOKIES);
  if (!cookies?.length) return undefined;

  const lines = [
    '# Netscape HTTP Cookie File',
    ...cookies.map(cookie => {
      const includeSubdomains = cookie.domain?.startsWith('.') ? 'TRUE' : 'FALSE';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expires = Number.isFinite(cookie.expires) ? Math.floor(cookie.expires) : 0;
      return [
        cookie.domain,
        includeSubdomains,
        cookie.path,
        secure,
        expires,
        cookie.name,
        cookie.value,
      ].join('\t');
    }),
    '',
  ];

  fs.writeFileSync(cookiesPath, lines.join('\n'), 'utf8');
  return cookiesPath;
}

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
    const cookiesFile = getCookiesFile();
    const processHandle = spawn(
      ytDlpPath,
      buildArgs(input, {
        dumpSingleJson: true,
        noWarnings: true,
        preferFreeFormats: true,
        flatPlaylist: true,
        skipDownload: true,
        simulate: true,
        quiet: true,
        cookies: cookiesFile,
        extractorArgs: ytExtractorArgs,
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

function toPlayableUrl(info) {
  if (typeof info?.webpage_url === 'string' && info.webpage_url) return info.webpage_url;
  if (typeof info?.original_url === 'string' && info.original_url) return info.original_url;
  if (typeof info?.url === 'string' && /^https?:\/\//.test(info.url)) return info.url;

  const extractorKey = String(info?.extractor_key || info?.ie_key || info?.extractor || '').toLowerCase();
  if (info?.id && extractorKey.includes('youtube')) {
    return `https://www.youtube.com/watch?v=${info.id}`;
  }

  return undefined;
}

function selectPlayableFormat(info) {
  if (!Array.isArray(info?.formats)) return null;

  const withAudio = info.formats.filter(format => format?.url && format.acodec && format.acodec !== 'none');
  if (!withAudio.length) return null;

  const audioOnly = withAudio
    .filter(format => !format.vcodec || format.vcodec === 'none')
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

  if (audioOnly.length) return audioOnly[0];

  return withAudio.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
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
    const sourceUrl = song.url || (song.id ? `https://www.youtube.com/watch?v=${song.id}` : undefined);

    if (!sourceUrl) {
      throw new DisTubeError('YTDLP_PLUGIN_INVALID_SONG', 'Cannot get stream URL from invalid song.');
    }

    const info = await runYtDlpJson(sourceUrl, {
      flatPlaylist: false,
    }).catch(error => {
      throw new DisTubeError('YTDLP_ERROR', String(error.message || error));
    });

    if (isPlaylist(info)) {
      throw new DisTubeError('YTDLP_ERROR', 'Cannot get stream URL of a playlist');
    }

    const selectedFormat = selectPlayableFormat(info);
    if (selectedFormat?.url) {
      return selectedFormat.url;
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
        url: toPlayableUrl(info),
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
