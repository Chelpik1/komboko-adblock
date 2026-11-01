import express from 'express';
import dotenv from 'dotenv';
import { Readable } from 'stream';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Разрешаем CORS для komboko.fun и любых зеркал
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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// -------------------------------------------------------------
// 1. ДЕШИФРАТОР KODIK (Шифр Цезаря + Base64)
// -------------------------------------------------------------
function caesarShiftString(text, shift) {
  const normShift = ((shift % 26) + 26) % 26;
  let res = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      res += String.fromCharCode(((code - 65 - normShift + 26) % 26) + 65);
    } else if (code >= 97 && code <= 122) {
      res += String.fromCharCode(((code - 97 - normShift + 26) % 26) + 97);
    } else {
      res += text[i];
    }
  }
  return res;
}

function decodeKodikBase64(cipherText, knownShift = null) {
  if (!cipherText || typeof cipherText !== 'string') return null;

  if (cipherText.startsWith('//') || cipherText.startsWith('http://') || cipherText.startsWith('https://')) {
    return { url: cipherText.startsWith('//') ? `https:${cipherText}` : cipherText, shift: 0 };
  }

  const tryShift = (s) => {
    try {
      const shifted = caesarShiftString(cipherText, s);
      let normalized = shifted.replace(/-/g, '+').replace(/_/g, '/');
      while (normalized.length % 4 !== 0) {
        normalized += '=';
      }
      const decoded = Buffer.from(normalized, 'base64').toString('utf8');
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
// 2. KODIK ИЗВЛЕЧЕНИЕ ПОТОКА БЕЗ РЕКЛАМЫ
// -------------------------------------------------------------
app.get('/api/kodik/extract', async (req, res) => {
  const linkParam = req.query.link;
  if (!linkParam) {
    return res.status(400).json({ success: false, error: 'Параметр link обязателен' });
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
      return res.status(pageRes.status).json({ success: false, error: `Kodik вернул статус: ${pageRes.status}` });
    }

    const html = await pageRes.text();

    // 1. Извлечение urlParams
    let urlParams = {};
    const urlParamsMatch = html.match(/urlParams\s*=\s*(['"]?\{.+?\}['"]?);/s) || html.match(/urlParams\s*=\s*(\{.+?\})/s);
    if (urlParamsMatch) {
      try {
        let rawJson = urlParamsMatch[1];
        if ((rawJson.startsWith('"') && rawJson.endsWith('"')) || (rawJson.startsWith("'") && rawJson.endsWith("'"))) {
          rawJson = rawJson.slice(1, -1);
        }
        urlParams = JSON.parse(rawJson);
      } catch (_) {}
    }

    const dVal = urlParams.d || (html.match(/["']?d["']?\s*:\s*["']([^"']+)["']/)?.[1]) || 'shikimori.io';
    const dSignVal = urlParams.d_sign || (html.match(/["']?d_sign["']?\s*:\s*["']([^"']+)["']/)?.[1]) || '';
    const pdVal = urlParams.pd || (html.match(/["']?pd["']?\s*:\s*["']([^"']+)["']/)?.[1]) || domain;
    const pdSignVal = urlParams.pd_sign || (html.match(/["']?pd_sign["']?\s*:\s*["']([^"']+)["']/)?.[1]) || '';
    const rawRef = urlParams.ref || (html.match(/["']?ref["']?\s*:\s*["']([^"']+)["']/)?.[1]) || 'https://shikimori.io/';
    const refVal = decodeURIComponent(rawRef);
    const refSignVal = urlParams.ref_sign || (html.match(/["']?ref_sign["']?\s*:\s*["']([^"']+)["']/)?.[1]) || '';

    // 2. Номер серии
    const urlObj = new URL(cleanUrl);
    const epNum = urlObj.searchParams.get('episode') || req.query.episode || '1';

    // 3. Извлечение ID и HASH (поддержка /seria/, /video/ и /serial/)
    let videoType = 'seria';
    let videoHash = '';
    let videoId = '';

    // Формат А: Прямые ссылки на серии (/seria/id/hash или /video/id/hash)
    const seriaMatch = cleanUrl.match(/\/(seria|video)\/(\d+)\/([a-f0-9]+)/i);
    if (seriaMatch) {
      videoType = seriaMatch[1];
      const idInHtml = html.match(/var\s+videoId\s*=\s*["']?(\d+)["']?/);
      videoId = idInHtml ? idInHtml[1] : seriaMatch[2];
      videoHash = seriaMatch[3];
    }

    // Формат Б: Выпадающий список серий на страницах /serial/
    if (!videoId || !videoHash) {
      const allOptionTags = html.match(/<option[^>]+>/gi) || [];
      for (const opt of allOptionTags) {
        const valMatch = opt.match(/value=["']([^"']+)["']/i);
        if (valMatch && String(valMatch[1]) === String(epNum)) {
          const idM = opt.match(/data-id=["']([^"']+)["']/i);
          const hashM = opt.match(/data-hash=["']([^"']+)["']/i);
          if (idM && hashM) {
            videoId = idM[1];
            videoHash = hashM[1];
            videoType = 'seria';
            break;
          }
        }
      }
    }

    // Формат В: Выбранный <option selected>
    if (!videoId || !videoHash) {
      const allOptionTags = html.match(/<option[^>]+>/gi) || [];
      for (const opt of allOptionTags) {
        if (opt.toLowerCase().includes('selected')) {
          const idM = opt.match(/data-id=["']([^"']+)["']/i);
          const hashM = opt.match(/data-hash=["']([^"']+)["']/i);
          if (idM && hashM) {
            videoId = idM[1];
            videoHash = hashM[1];
            videoType = 'seria';
            break;
          }
        }
      }
    }

    // Формат Г: Мета-переменные в теле скрипта
    if (!videoId || !videoHash) {
      const vidInHtml = html.match(/var\s+videoId\s*=\s*["']?(\d+)["']?/);
      const hashInHtml = html.match(/var\s+videoHash\s*=\s*["']?([a-f0-9]+)["']?/);
      const serialId = html.match(/var\s+serialId\s*=\s*(?:Number\()?["']?(\d+)["']?\)?/);
      const serialHash = html.match(/var\s+serialHash\s*=\s*["']?([a-f0-9]+)["']?/);
      const typeMatch = html.match(/videoInfo\.type\s*=\s*["']([^"']+)["']/);

      if (vidInHtml && hashInHtml) {
        videoId = vidInHtml[1];
        videoHash = hashInHtml[1];
        videoType = 'seria';
      } else if (serialId && serialHash) {
        videoId = serialId[1];
        videoHash = serialHash[1];
        videoType = typeMatch ? typeMatch[1] : 'serial';
      } else {
        const serialUrlMatch = cleanUrl.match(/\/(serial)\/(\d+)\/([a-f0-9]+)/i);
        if (serialUrlMatch) {
          videoType = 'serial';
          videoId = serialUrlMatch[2];
          videoHash = serialUrlMatch[3];
        }
      }
    }

    if (!videoId || !videoHash) {
      return res.status(422).json({ success: false, error: 'Could not resolve episode ID and hash' });
    }

    // 4. Таймкоды пропуска опенинга и эндинга
    const skipSegments = [];
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

    // 5. Запрос к /ftor (или резервному /gvi)
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

    let ftorUrl = `https://${domain}/ftor`;
    let ftorRes = await fetch(ftorUrl, {
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

    if (ftorRes.status === 404) {
      ftorUrl = `https://${domain}/gvi`;
      ftorRes = await fetch(ftorUrl, {
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
    }

    if (!ftorRes.ok) {
      return res.status(ftorRes.status).json({ success: false, error: `/ftor ответил ошибкой: ${ftorRes.status}` });
    }

    const ftorJson = await ftorRes.json();
    if (!ftorJson || !ftorJson.links) {
      return res.status(422).json({ success: false, error: 'В ответе Kodik отсутствуют ссылки' });
    }

    // 6. Расшифровка потоков
    const decipheredQualities = {};
    let detectedShift = null;

    const rawLinks = ftorJson.links;
    for (const qKey of Object.keys(rawLinks)) {
      const arr = rawLinks[qKey];
      if (Array.isArray(arr) && arr.length > 0) {
        const cipherSrc = typeof arr[0] === 'string' ? arr[0] : (arr[0]?.src || '');
        if (cipherSrc) {
          const decoded = decodeKodikBase64(cipherSrc, detectedShift);
          if (decoded) {
            detectedShift = decoded.shift;
            const label = qKey.endsWith('p') ? qKey : `${qKey}p`;
            decipheredQualities[label] = decoded.url;
          }
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
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Ошибка дешифровки Kodik' });
  }
});

// -------------------------------------------------------------
// 3. ANIBOOM ИЗВЛЕЧЕНИЕ
// -------------------------------------------------------------
app.get('/api/aniboom/extract', async (req, res) => {
  const embedUrl = req.query.url;
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
      return res.status(pageRes.status).json({ success: false, error: `Aniboom error: ${pageRes.status}` });
    }

    const html = await pageRes.text();
    const paramMatch = html.match(/data-parameters=["']([^"']+)["']/);
    if (!paramMatch) {
      return res.status(422).json({ success: false, error: 'data-parameters не найдены' });
    }

    const unescaped = paramMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'");

    const params = JSON.parse(unescaped);
    const hlsUrl = params.hls;
    const dashUrl = params.dash;

    if (!hlsUrl) {
      return res.status(422).json({ success: false, error: 'HLS поток не найден' });
    }

    const qualities = {};
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
              if (line.includes('1920x1080') || line.includes('RESOLUTION=1920x1080')) qualities['1080p'] = streamFull;
              else if (line.includes('1280x720') || line.includes('RESOLUTION=1280x720')) qualities['720p'] = streamFull;
              else if (line.includes('854x480') || line.includes('RESOLUTION=854x480')) qualities['480p'] = streamFull;
              else if (line.includes('640x360') || line.includes('RESOLUTION=640x360')) qualities['360p'] = streamFull;
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
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Ошибка парсинга Aniboom' });
  }
});

// -------------------------------------------------------------
// 4. SIBNET ИЗВЛЕЧЕНИЕ
// -------------------------------------------------------------
app.get('/api/sibnet/extract', async (req, res) => {
  const urlOrId = req.query.url || req.query.id;
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
      return res.status(pageRes.status).json({ success: false, error: `Sibnet error: ${pageRes.status}` });
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
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Sibnet error' });
  }
});

// -------------------------------------------------------------
// 5. CDN HUB / KINOPOISK РЕЗОЛВЕР
// -------------------------------------------------------------
app.get('/api/cdnhub/embed', async (req, res) => {
  const shikimoriId = req.query.shikimori_id;
  const kpId = req.query.kp_id;
  const title = req.query.q || '';

  if (kpId) {
    return res.json({ success: true, kinopoisk_id: kpId, imdb_id: '', title });
  }

  if (!shikimoriId) {
    return res.status(400).json({ success: false, error: 'shikimori_id or kp_id is required' });
  }

  try {
    const token = '56a768d08f43091901c44b54fe970049';
    const kodikRes = await fetch(`https://kodik-api.com/search?token=${token}&shikimori_id=${encodeURIComponent(shikimoriId)}&limit=1`);
    if (kodikRes.ok) {
      const data = await kodikRes.json();
      const r = data.results && data.results[0];
      if (r) {
        return res.json({
          success: true,
          kinopoisk_id: r.kinopoisk_id ? String(r.kinopoisk_id) : '',
          imdb_id: r.imdb_id ? String(r.imdb_id) : '',
          title: title || r.title || ''
        });
      }
    }
    return res.json({ success: false, error: 'Not found in database' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Resolver error' });
  }
});

// -------------------------------------------------------------
// 6. УНИВЕРСАЛЬНЫЙ ПРОКСИ ПОТОКОВ (M3U8 & TS ЧАНКИ)
// -------------------------------------------------------------
app.get('/api/proxy/m3u8', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://kodikplayer.com/';

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
  } catch (err) {
    return res.status(500).send(err.message || 'M3U8 proxy error');
  }
});

app.get('/api/proxy/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://kodikplayer.com/';

  if (!targetUrl) {
    return res.status(400).send('url parameter is required');
  }

  try {
    const headers = {
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
      Readable.fromWeb(upstreamRes.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    return res.status(500).send(err.message || 'Stream proxy error');
  }
});

// -------------------------------------------------------------
// 7. SHIKIMORI OAUTH ПРОКСИ
// -------------------------------------------------------------
app.post('/api/shikimori_auth', async (req, res) => {
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
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Auth exchange failed' });
  }
});

// Health check для мониторинга и проверки работоспособности
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'komboko-api', uptime: process.uptime() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KombokoWatch API running on port ${PORT}`);
});
