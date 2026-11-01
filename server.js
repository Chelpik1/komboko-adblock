import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS for API routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// User Agents & Headers
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// -------------------------------------------------------------
// 1. KODIK CIPHER DECODER (Caesar Shift Base64 Decoder)
// As described in anime-dl-core and Habr 1079156
// -------------------------------------------------------------
function caesarShiftString(text: string, shift: number): string {
  const normShift = ((shift % 26) + 26) % 26;
  let res = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      // Uppercase A-Z
      res += String.fromCharCode(((code - 65 - normShift + 26) % 26) + 65);
    } else if (code >= 97 && code <= 122) {
      // Lowercase a-z
      res += String.fromCharCode(((code - 97 - normShift + 26) % 26) + 97);
    } else {
      res += text[i];
    }
  }
  return res;
}

function decodeKodikBase64(cipherText: string, knownShift: number | null = null): { url: string; shift: number } | null {
  if (!cipherText || typeof cipherText !== 'string') return null;

  const tryShift = (s: number): string | null => {
    try {
      const shifted = caesarShiftString(cipherText, s);
      const decoded = Buffer.from(shifted, 'base64').toString('utf8');
      if (
        (decoded.startsWith('//') || decoded.startsWith('http://') || decoded.startsWith('https://')) &&
        (decoded.includes('.m3u8') || decoded.includes('.mp4'))
      ) {
        return decoded.startsWith('//') ? `https:${decoded}` : decoded;
      }
    } catch (_) {}
    return null;
  };

  if (knownShift !== null) {
    const direct = tryShift(knownShift);
    if (direct) return { url: direct, shift: knownShift };
  }

  // Common Kodik shifts are usually 18, 13, 11, 7, etc.
  const commonShifts = [18, 13, 11, 14, 7, 5, 20];
  for (const s of commonShifts) {
    const found = tryShift(s);
    if (found) return { url: found, shift: s };
  }

  for (let s = 1; s <= 25; s++) {
    if (commonShifts.includes(s)) continue;
    const found = tryShift(s);
    if (found) return { url: found, shift: s };
  }

  return null;
}

// -------------------------------------------------------------
// 2. KODIK EXTRACTOR (Ad-Free Direct Streams)
// -------------------------------------------------------------
app.get('/api/kodik/extract', async (req: Request, res: Response) => {
  const linkParam = req.query.link as string;
  if (!linkParam) {
    return res.status(400).json({ success: false, error: 'Parameter link is required' });
  }

  try {
    let cleanUrl = linkParam.startsWith('//') ? `https:${linkParam}` : linkParam;
    cleanUrl = cleanUrl
      .replace('kodik.info', 'kodikplayer.com')
      .replace('kodikdb.com', 'kodikplayer.com')
      .replace('cloud.kodik-storage.com', 'kodikplayer.com');

    const domainMatch = cleanUrl.match(/https?:\/\/([^/]+)/);
    const domain = domainMatch ? domainMatch[1] : 'kodikplayer.com';

    const pageRes = await fetch(cleanUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://shikimori.io/',
      },
    });

    if (!pageRes.ok) {
      return res.status(pageRes.status).json({ success: false, error: `Failed to fetch Kodik page: ${pageRes.status}` });
    }

    const html = await pageRes.text();

    // 1. Extract urlParams or variables
    let urlParams: any = {};
    const urlParamsMatch = html.match(/urlParams\s*=\s*['"]?(\{[^']+\})['"]?/);
    if (urlParamsMatch) {
      try {
        urlParams = JSON.parse(urlParamsMatch[1]);
      } catch (_) {}
    }

    const dVal = urlParams.d || (html.match(/var\s+domain\s*=\s*["']([^"']+)["']/)?.[1]) || 'shikimori.io';
    const dSignVal = urlParams.d_sign || (html.match(/var\s+d_sign\s*=\s*["']([^"']+)["']/)?.[1]) || '';
    const pdVal = urlParams.pd || (html.match(/var\s+pd\s*=\s*["']([^"']+)["']/)?.[1]) || domain;
    const pdSignVal = urlParams.pd_sign || (html.match(/var\s+pd_sign\s*=\s*["']([^"']+)["']/)?.[1]) || '';
    const refVal = decodeURIComponent(urlParams.ref || (html.match(/var\s+ref\s*=\s*["']([^"']+)["']/)?.[1]) || 'https://shikimori.io/');
    const refSignVal = urlParams.ref_sign || (html.match(/var\s+ref_sign\s*=\s*["']([^"']+)["']/)?.[1]) || '';

    // 2. Extract requested episode number
    const urlObj = new URL(cleanUrl);
    const epNum = urlObj.searchParams.get('episode') || (req.query.episode as string) || '1';

    // 3. Extract videoType, videoHash, videoId
    let videoType = 'seria';
    let videoHash = '';
    let videoId = '';

    // For serials, Kodik provides a select element with options containing data-id and data-hash for each episode
    const epOptionRegex = new RegExp(`<option[^>]*value=["']${epNum}["'][^>]*data-id=["']([^"']+)["'][^>]*data-hash=["']([^"']+)["']`, 'i');
    const altEpOptionRegex = new RegExp(`<option[^>]*data-id=["']([^"']+)["'][^>]*data-hash=["']([^"']+)["'][^>]*value=["']${epNum}["']`, 'i');
    const epMatch = html.match(epOptionRegex) || html.match(altEpOptionRegex);

    if (epMatch) {
      videoId = epMatch[1];
      videoHash = epMatch[2];
      videoType = 'seria';
    } else {
      // Check selected option
      const selectedOptionMatch = html.match(/<option[^>]*selected[^>]*data-id=["']([^"']+)["'][^>]*data-hash=["']([^"']+)["']/i);
      if (selectedOptionMatch) {
        videoId = selectedOptionMatch[1];
        videoHash = selectedOptionMatch[2];
        videoType = 'seria';
      } else {
        const typeMatch = html.match(/videoInfo\.type\s*=\s*['"]([^'"]+)['"]/);
        const hashMatch = html.match(/videoInfo\.hash\s*=\s*['"]([^'"]+)['"]/);
        const idMatch = html.match(/videoInfo\.id\s*=\s*['"]([^'"]+)['"]/);
        if (typeMatch && hashMatch && idMatch) {
          videoType = typeMatch[1];
          videoHash = hashMatch[1];
          videoId = idMatch[1];
        } else {
          const pathParts = cleanUrl.split('/');
          videoType = pathParts[3] || 'seria';
          videoId = pathParts[4] || '';
          videoHash = pathParts[5] || '';
        }
      }
    }

    if (!videoId || !videoHash) {
      return res.status(422).json({ success: false, error: 'Could not resolve episode ID and hash' });
    }

    // 4. Extract skip segments (opening / ending) if present
    const skipSegments: Array<{ start: number; end: number; kind: string }> = [];
    const skipMatch = html.match(/skips\s*=\s*(\[[^\]]+\])/);
    if (skipMatch) {
      try {
        const rawSkips = JSON.parse(skipMatch[1]);
        if (Array.isArray(rawSkips)) {
          for (const s of rawSkips) {
            if (s && s.start != null && s.end != null) {
              skipSegments.push({
                start: Number(s.start),
                end: Number(s.end),
                kind: s.type || 'opening',
              });
            }
          }
        }
      } catch (_) {}
    }

    // 5. Send POST request to /ftor endpoint
    const postData = new URLSearchParams();
    postData.append('d', dVal);
    postData.append('d_sign', dSignVal);
    postData.append('pd', pdVal);
    postData.append('pd_sign', pdSignVal);
    postData.append('ref', refVal);
    postData.append('ref_sign', refSignVal);
    postData.append('bad_user', 'false');
    postData.append('type', videoType);
    postData.append('hash', videoHash);
    postData.append('id', String(videoId));

    const ftorUrl = `https://${domain}/ftor`;
    const ftorRes = await fetch(ftorUrl, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': cleanUrl,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      body: postData.toString(),
    });

    if (!ftorRes.ok) {
      return res.status(ftorRes.status).json({ success: false, error: `/ftor responded with status ${ftorRes.status}` });
    }

    const ftorJson: any = await ftorRes.json();
    if (!ftorJson || !ftorJson.links) {
      return res.status(422).json({ success: false, error: 'No links in Kodik /ftor response' });
    }

    // 5. Decipher links with Caesar shift
    const decipheredQualities: Record<string, string> = {};
    let detectedShift: number | null = null;

    const rawLinks = ftorJson.links;
    for (const qKey of Object.keys(rawLinks)) {
      const arr = rawLinks[qKey];
      if (Array.isArray(arr) && arr.length > 0) {
        const cipherSrc = arr[0].src;
        const decoded = decodeKodikBase64(cipherSrc, detectedShift);
        if (decoded) {
          detectedShift = decoded.shift;
          decipheredQualities[`${qKey}p`] = decoded.url;
        }
      }
    }

    const bestStream = decipheredQualities['720p'] || decipheredQualities['480p'] || decipheredQualities['360p'] || Object.values(decipheredQualities)[0];

    return res.json({
      success: true,
      player: 'kodik',
      stream: bestStream,
      qualities: decipheredQualities,
      skip_segments: skipSegments,
      headers: {
        Referer: `https://${domain}/`,
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Kodik extraction error' });
  }
});

// -------------------------------------------------------------
// 3. ANIBOOM EXTRACTOR (Ad-Free HLS Stream & Qualities)
// -------------------------------------------------------------
app.get('/api/aniboom/extract', async (req: Request, res: Response) => {
  const embedUrl = req.query.url as string;
  if (!embedUrl) {
    return res.status(400).json({ success: false, error: 'url parameter is required' });
  }

  try {
    const pageRes = await fetch(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://animego.me/',
      },
    });

    if (!pageRes.ok) {
      return res.status(pageRes.status).json({ success: false, error: `Aniboom page failed: ${pageRes.status}` });
    }

    const html = await pageRes.text();

    // In Aniboom HTML: <video ... data-parameters="&quot;hls&quot;:&quot;...&quot;" ...>
    const paramMatch = html.match(/data-parameters=["']([^"']+)["']/);
    if (!paramMatch) {
      return res.status(422).json({ success: false, error: 'data-parameters not found in Aniboom page' });
    }

    const unescaped = paramMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'");

    const params = JSON.parse(unescaped);
    const hlsUrl = params.hls;
    const dashUrl = params.dash;

    if (!hlsUrl) {
      return res.status(422).json({ success: false, error: 'No HLS stream found in Aniboom parameters' });
    }

    // Resolve qualities by reading master.m3u8
    const qualities: Record<string, string> = {};
    try {
      const m3u8Res = await fetch(hlsUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': 'https://aniboom.one/',
        },
      });

      if (m3u8Res.ok) {
        const m3u8Text = await m3u8Res.text();
        const lines = m3u8Text.split('\n');
        const baseUrl = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#EXT-X-STREAM-INF')) {
            const nextLine = lines[i + 1]?.trim();
            if (nextLine && !nextLine.startsWith('#')) {
              const streamFull = nextLine.startsWith('http') ? nextLine : `${baseUrl}${nextLine}`;
              if (line.includes('1920x1080') || line.includes('RESOLUTION=1920x1080')) {
                qualities['1080p'] = streamFull;
              } else if (line.includes('1280x720') || line.includes('RESOLUTION=1280x720')) {
                qualities['720p'] = streamFull;
              } else if (line.includes('854x480') || line.includes('RESOLUTION=854x480')) {
                qualities['480p'] = streamFull;
              } else if (line.includes('640x360') || line.includes('RESOLUTION=640x360')) {
                qualities['360p'] = streamFull;
              }
            }
          }
        }
      }
    } catch (_) {}

    const bestStream = qualities['1080p'] || qualities['720p'] || qualities['480p'] || hlsUrl;

    return res.json({
      success: true,
      player: 'aniboom',
      stream: bestStream,
      master: hlsUrl,
      dash: dashUrl,
      qualities: Object.keys(qualities).length > 0 ? qualities : { '1080p': hlsUrl },
      headers: {
        'Referer': 'https://aniboom.one/',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Aniboom extraction error' });
  }
});

// -------------------------------------------------------------
// 4. SIBNET EXTRACTOR (Direct MP4 Stream)
// -------------------------------------------------------------
app.get('/api/sibnet/extract', async (req: Request, res: Response) => {
  const urlOrId = (req.query.url || req.query.id) as string;
  if (!urlOrId) {
    return res.status(400).json({ success: false, error: 'url or id parameter is required' });
  }

  try {
    const videoId = urlOrId.includes('videoid=')
      ? urlOrId.split('videoid=')[1].split('&')[0]
      : urlOrId.replace(/[^0-9]/g, '');

    const targetUrl = `https://video.sibnet.ru/shell.php?videoid=${videoId}`;
    const pageRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://animego.me/',
      },
    });

    if (!pageRes.ok) {
      return res.status(pageRes.status).json({ success: false, error: `Sibnet page error: ${pageRes.status}` });
    }

    const html = await pageRes.text();
    const srcMatch = html.match(/player\.src\(\s*\[\s*\{\s*src\s*:\s*["']([^"']+)["']/);

    if (!srcMatch) {
      return res.status(422).json({ success: false, error: 'Sibnet mp4 src not found' });
    }

    const rawPath = srcMatch[1];
    const directMp4 = rawPath.startsWith('http') ? rawPath : `https://video.sibnet.ru${rawPath}`;

    return res.json({
      success: true,
      player: 'sibnet',
      stream: directMp4,
      qualities: { '720p': directMp4 },
      headers: {
        'Referer': 'https://video.sibnet.ru/',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Sibnet extraction error' });
  }
});

// -------------------------------------------------------------
// 5. ANIMEGO PARSER (Discover Aniboom, CVH, Kodik, Sibnet players)
// -------------------------------------------------------------
app.get('/api/animego/players', async (req: Request, res: Response) => {
  const query = req.query.q as string;
  const episode = Number(req.query.episode) || 1;

  if (!query) {
    return res.status(400).json({ success: false, error: 'q (anime title) parameter is required' });
  }

  try {
    // 1. Search anime on AnimeGo
    const searchUrl = `https://animego.me/search/anime?q=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!searchRes.ok) {
      return res.status(searchRes.status).json({ success: false, error: 'AnimeGo search request failed' });
    }

    const searchHtml = await searchRes.text();

    // Extract first search result link (/anime/title-id)
    const linkMatch = searchHtml.match(/href=["'](\/anime\/[^"']+)["']/);
    if (!linkMatch) {
      return res.status(404).json({ success: false, error: 'Anime not found on AnimeGo' });
    }

    const animePath = linkMatch[1];
    const animePageUrl = `https://animego.me${animePath}`;

    // 2. Fetch anime page
    const pageRes = await fetch(animePageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': searchUrl,
      },
    });

    if (!pageRes.ok) {
      return res.status(pageRes.status).json({ success: false, error: 'Failed to fetch AnimeGo anime page' });
    }

    const pageHtml = await pageRes.text();

    // 3. Extract player links (Aniboom, CVH, Kodik, Sibnet)
    const foundPlayers: Array<{ name: string; embedUrl: string; studio?: string }> = [];

    // Check for Aniboom embed
    const aniboomMatches = [...pageHtml.matchAll(/https:\/\/aniboom\.one\/embed\/[a-zA-Z0-9_-]+/g)];
    for (const m of aniboomMatches) {
      const base = m[0];
      const withEp = `${base}?episode=${episode}`;
      if (!foundPlayers.some(p => p.embedUrl === withEp)) {
        foundPlayers.push({ name: 'Aniboom', embedUrl: withEp });
      }
    }

    // Check for CVH (cdn-iframe)
    const cvhMatches = [...pageHtml.matchAll(/\/cdn-iframe\/[^\s"']+/g)];
    for (const m of cvhMatches) {
      const full = `https://animego.me${m[0]}`;
      foundPlayers.push({ name: 'CVH', embedUrl: full });
    }

    // Check for Sibnet
    const sibnetMatches = [...pageHtml.matchAll(/https:\/\/video\.sibnet\.ru\/shell\.php\?videoid=\d+/g)];
    for (const m of sibnetMatches) {
      foundPlayers.push({ name: 'Sibnet', embedUrl: m[0] });
    }

    return res.json({
      success: true,
      title: query,
      episode,
      players: foundPlayers,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'AnimeGo query error' });
  }
});

// -------------------------------------------------------------
// 6. UNIVERSAL STREAM PROXY & M3U8 REWRITER
// Enables zero-CORS, ad-free streaming of Kodik, Aniboom & Sibnet
// -------------------------------------------------------------
app.get('/api/proxy/m3u8', async (req: Request, res: Response) => {
  const targetUrl = req.query.url as string;
  const referer = (req.query.referer as string) || 'https://kodikplayer.com/';

  if (!targetUrl) {
    return res.status(400).send('url parameter is required');
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer,
      },
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send(`Upstream M3U8 failed: ${upstreamRes.status}`);
    }

    const playlistText = await upstreamRes.text();
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

    // Rewrite relative URLs to route through /api/proxy/stream
    const lines = playlistText.split('\n');
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      const fullChunkUrl = trimmed.startsWith('http')
        ? trimmed
        : trimmed.startsWith('//')
        ? `https:${trimmed}`
        : `${baseUrl}${trimmed}`;

      return `/api/proxy/stream?url=${encodeURIComponent(fullChunkUrl)}&referer=${encodeURIComponent(referer)}`;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.send(rewritten);
  } catch (err: any) {
    return res.status(500).send(err.message || 'M3U8 proxy error');
  }
});

app.get('/api/proxy/stream', async (req: Request, res: Response) => {
  const targetUrl = req.query.url as string;
  const referer = (req.query.referer as string) || 'https://kodikplayer.com/';

  if (!targetUrl) {
    return res.status(400).send('url parameter is required');
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Referer': referer,
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstreamRes = await fetch(targetUrl, { headers });

    res.status(upstreamRes.status);
    const contentType = upstreamRes.headers.get('content-type') || (targetUrl.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
    res.setHeader('Content-Type', contentType);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const acceptRanges = upstreamRes.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

    if (upstreamRes.body) {
      // Pipe web stream to express response
      const reader = upstreamRes.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (_) {
          res.end();
        }
      };
      pump();
    } else {
      res.end();
    }
  } catch (err: any) {
    return res.status(500).send(err.message || 'Stream proxy error');
  }
});

// -------------------------------------------------------------
// 7. SHIKIMORI AUTH PROXY
// -------------------------------------------------------------
app.post('/api/shikimori_auth', async (req: Request, res: Response) => {
  const { code, redirect_uri } = req.body;
  const SHIKI_CLIENT_ID = '2gnAwexNcV7ENj62zeIAvBI9q7c63O9z5mWSR6k5oRo';

  try {
    const tokenRes = await fetch('https://shikimori.io/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'KombokoWatchApp',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: SHIKI_CLIENT_ID,
        client_secret: '',
        code,
        redirect_uri,
      }),
    });

    const tokenData = await tokenRes.json();
    return res.json(tokenData);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Auth exchange failed' });
  }
});

// -------------------------------------------------------------
// 8. VITE MIDDLEWARE OR STATIC SERVING
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KombokoWatch server running on http://0.0.0.0:${PORT}`);
  });
}
