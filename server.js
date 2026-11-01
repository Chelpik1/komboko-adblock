import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const KODIK_TOKENS = [
  '56a768d08f43091901c44b54fe970049',
  '41dd95f84c21719b09d6c71182237a25',
  '77b567ec164db6ca9162d2f3dc4948c3',
  '447d179e875efe44217f20d1ee2146be'
];

const ANIMEGO_DOMAINS = [
  'https://animego.one',
  'https://animego.me',
  'https://animego.org'
];

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function caesarShift(text, shift) {
  let res = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      res += String.fromCharCode(((code - 65 - shift + 26) % 26) + 65);
    } else if (code >= 97 && code <= 122) {
      res += String.fromCharCode(((code - 97 - shift + 26) % 26) + 97);
    } else {
      res += text[i];
    }
  }
  return res;
}

function decodeCipher(cipher) {
  const cleanCipher = String(cipher || '').trim();
  for (let s = 0; s <= 25; s++) {
    try {
      const shifted = caesarShift(cleanCipher, s);
      const padded = shifted + '='.repeat((4 - (shifted.length % 4)) % 4);
      const decoded = Buffer.from(padded, 'base64').toString('utf8');
      if (decoded.startsWith('//') || decoded.startsWith('http')) {
        const fullUrl = decoded.startsWith('//') ? 'https:' + decoded : decoded;
        return { url: fullUrl, shift: s };
      }
    } catch (_) {}
  }
  return null;
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// =========================================================
// 1. ДЕШИФРОВКА ПРЯМЫХ ПОТОКОВ KODIK (/api/kodik/extract)
// =========================================================
app.get('/api/kodik/extract', async (req, res) => {
  const link = req.query.link;
  if (!link) return res.status(400).json({ success: false, error: 'link required' });

  try {
    const cleanUrl = link.startsWith('//') ? 'https:' + link : link;
    const urlObj = new URL(cleanUrl);
    const epNum = urlObj.searchParams.get('episode') || '1';

    const pageRes = await fetch(cleanUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://shikimori.io/'
      }
    });
    const html = await pageRes.text();

    if (html.includes('Error code:') || html.includes('запрещено к просмотру')) {
      return res.json({ success: false, error: 'Kodik geo-blocked server IP' });
    }

    const dSign = html.match(/var\s+d_sign\s*=\s*["']([^"']+)["']/)?.[1] || '';
    const pdSign = html.match(/var\s+pd_sign\s*=\s*["']([^"']+)["']/)?.[1] || '';
    const ref = html.match(/var\s+ref\s*=\s*["']([^"']+)["']/)?.[1] || 'https://shikimori.io/';
    const refSign = html.match(/var\s+ref_sign\s*=\s*["']([^"']+)["']/)?.[1] || '';

    const epRegex = new RegExp(`<option[^>]*value=["']${epNum}["'][^>]*data-id=["']([^"']+)["'][^>]*data-hash=["']([^"']+)["']`);
    const epMatch = html.match(epRegex);

    const epId = epMatch ? epMatch[1] : (html.match(/videoInfo\.id\s*=\s*["']([^"']+)["']/)?.[1] || '');
    const epHash = epMatch ? epMatch[2] : (html.match(/videoInfo\.hash\s*=\s*["']([^"']+)["']/)?.[1] || '');
    const epType = html.match(/videoInfo\.type\s*=\s*["']([^"']+)["']/)?.[1] || 'seria';

    if (!epId || !epHash) {
      return res.json({ success: false, error: 'Cannot parse episode credentials' });
    }

    const postData = new URLSearchParams({
      d: 'shikimori.io',
      d_sign: dSign,
      pd: urlObj.hostname || 'kodikplayer.com',
      pd_sign: pdSign,
      ref: ref,
      ref_sign: refSign,
      bad_user: 'false',
      cdn_is_working: 'true',
      type: epType,
      hash: epHash,
      id: epId
    });

    const ftorRes = await fetch(`https://${urlObj.hostname || 'kodikplayer.com'}/ftor`, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Origin': `https://${urlObj.hostname || 'kodikplayer.com'}`,
        'Referer': cleanUrl,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: postData.toString()
    });

    const ftorJson = await ftorRes.json();
    const qualities = {};
    for (const [q, arr] of Object.entries(ftorJson.links || {})) {
      if (Array.isArray(arr) && arr[0]?.src) {
        const dec = decodeCipher(arr[0].src);
        if (dec && dec.url) {
          const qKey = String(q).endsWith('p') ? String(q) : `${q}p`;
          qualities[qKey] = dec.url;
        }
      }
    }

    const bestStream = qualities['720p'] || qualities['480p'] || qualities['360p'] || Object.values(qualities)[0];
    if (!bestStream) {
      return res.json({ success: false, error: 'No streams returned by Kodik' });
    }

    return res.json({
      success: true,
      player: 'kodik',
      stream: bestStream,
      qualities: qualities,
      skip_segments: []
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 2. ПОИСК ПЛЕЕРОВ ANIMEGO: ANIBOOM, SIBNET, CVH (/api/animego/players)
// =========================================================
async function findAnimeGoId(baseDomain, searchCandidates) {
  for (const query of searchCandidates) {
    if (!query || query.trim().length < 2) continue;
    try {
      const searchUrl = `${baseDomain}/search/anime?q=${encodeURIComponent(query.trim())}`;
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': USER_AGENT, 'Referer': `${baseDomain}/` }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const match = html.match(/href=["'](?:https?:\/\/[^"']+)?\/anime\/([a-zA-Z0-9_-]+-(\d+))["']/);
      if (match && match[2]) {
        return { slug: match[1], id: match[2] };
      }
    } catch (_) {}
  }
  return null;
}

function parsePlayersFromHtml(html) {
  const players = [];
  const seen = new Set();
  const regex = /data-player=["']([^"']+)["']/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    let rawUrl = m[1].trim();
    if (!rawUrl) continue;
    if (rawUrl.startsWith('//')) rawUrl = 'https:' + rawUrl;
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);

    const low = rawUrl.toLowerCase();
    if (low.includes('aniboom')) {
      players.push({ name: 'Aniboom', embedUrl: rawUrl });
    } else if (low.includes('sibnet')) {
      players.push({ name: 'Sibnet', embedUrl: rawUrl });
    } else if (low.includes('cdnvideohub') || low.includes('cvh') || low.includes('vk.com')) {
      players.push({ name: 'CVH', embedUrl: rawUrl });
    }
  }
  return players;
}

app.get('/api/animego/players', async (req, res) => {
  const { q = '', orig = '', episode = '1' } = req.query;
  const epNum = String(episode || '1');

  const cleanRu = String(q).replace(/[^\w\sа-яА-ЯёЁ]/g, ' ').replace(/\s+/g, ' ').trim();
  const shortRu = cleanRu.split(' ').slice(0, 3).join(' ');
  const candidates = [q, orig, cleanRu, shortRu].filter(Boolean);

  for (const domain of ANIMEGO_DOMAINS) {
    try {
      const found = await findAnimeGoId(domain, candidates);
      if (!found) continue;

      const animeUrl = `${domain}/anime/${found.slug}`;
      const playerInitRes = await fetch(`${domain}/anime/${found.id}/player?_allow=true`, {
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': animeUrl,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        }
      });

      if (!playerInitRes.ok) continue;
      const initJson = await playerInitRes.json();
      const playerHtml = initJson?.content || '';
      if (!playerHtml) continue;

      // Проверяем, есть ли список серий (сериал) или плееры сразу на странице (фильм)
      const epIdRegex = new RegExp(`data-episode=["']${epNum}["'][^>]*data-id=["'](\\d+)["']|data-id=["'](\\d+)["'][^>]*data-episode=["']${epNum}["']`);
      const epMatch = playerHtml.match(epIdRegex);
      const episodeId = epMatch ? (epMatch[1] || epMatch[2]) : null;

      let finalHtml = playerHtml;
      if (episodeId) {
        const epRes = await fetch(`${domain}/anime/series?episode=${episodeId}&id=${episodeId}`, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': animeUrl,
            'X-Requested-With': 'XMLHttpRequest'
          }
        });
        if (epRes.ok) {
          const epJson = await epRes.json();
          if (epJson?.content) finalHtml = epJson.content;
        }
      }

      const players = parsePlayersFromHtml(finalHtml);
      if (players.length > 0) {
        return res.json({ success: true, anime_id: found.id, players });
      }
    } catch (_) {}
  }

  return res.json({ success: false, players: [] });
});

// =========================================================
// 3. ИЗВЛЕЧЕНИЕ ПРЯМОГО M3U8 ИЗ ANIBOOM (/api/aniboom/extract)
// =========================================================
app.get('/api/aniboom/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ success: false, error: 'Missing url' });

  try {
    const cleanUrl = url.startsWith('//') ? 'https:' + url : url;
    const response = await fetch(cleanUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://animego.one/'
      }
    });

    if (!response.ok) {
      return res.json({ success: false, error: `Aniboom HTTP ${response.status}` });
    }

    const html = await response.text();
    const paramMatch = html.match(/data-parameters=["']([^"']+)["']/);
    if (!paramMatch) {
      return res.json({ success: false, error: 'data-parameters not found' });
    }

    const rawParams = decodeHtmlEntities(paramMatch[1]);
    const paramsObj = JSON.parse(rawParams);

    let hlsUrl = null;
    if (paramsObj.hls) {
      const hlsObj = typeof paramsObj.hls === 'string' ? JSON.parse(paramsObj.hls) : paramsObj.hls;
      hlsUrl = hlsObj.src || hlsObj.url || null;
    }

    if (!hlsUrl) {
      return res.json({ success: false, error: 'HLS stream not found in Aniboom' });
    }

    return res.json({
      success: true,
      stream: hlsUrl,
      qualities: { '1080p': hlsUrl }
    });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

// =========================================================
// 4. ИЗВЛЕЧЕНИЕ ПРЯМОГО MP4 ИЗ SIBNET (/api/sibnet/extract)
// =========================================================
app.get('/api/sibnet/extract', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ success: false, error: 'Missing url' });

  try {
    const cleanUrl = url.startsWith('//') ? 'https:' + url : url;
    const response = await fetch(cleanUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://video.sibnet.ru/'
      }
    });

    if (!response.ok) {
      return res.json({ success: false, error: `Sibnet HTTP ${response.status}` });
    }

    const html = await response.text();
    const srcMatch = html.match(/src\s*:\s*["'](\/v\/[^"']+\.mp4[^"']*)["']/i);
    if (!srcMatch) {
      return res.json({ success: false, error: 'MP4 path not found in Sibnet shell' });
    }

    const streamUrl = `https://video.sibnet.ru${srcMatch[1]}`;
    return res.json({
      success: true,
      stream: streamUrl
    });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

// =========================================================
// 5. CDN HUB ПО KINOPOISK ID (/api/cdnhub/embed)
// =========================================================
app.get('/api/cdnhub/embed', async (req, res) => {
  const { shikimori_id, kp_id, q } = req.query;
  let kinopoiskId = kp_id || null;
  let imdbId = null;

  if (!kinopoiskId && shikimori_id) {
    for (const token of KODIK_TOKENS) {
      try {
        const apiRes = await fetch(
          `https://kodik-api.com/search?token=${token}&shikimori_id=${encodeURIComponent(shikimori_id)}&with_material_data=true&limit=5`
        );
        if (apiRes.ok) {
          const data = await apiRes.json();
          const match = (data.results || []).find(r => r.kinopoisk_id || r.imdb_id);
          if (match) {
            kinopoiskId = match.kinopoisk_id ? String(match.kinopoisk_id) : null;
            imdbId = match.imdb_id ? String(match.imdb_id) : null;
            break;
          }
        }
      } catch (_) {}
    }
  }

  if (!kinopoiskId && !imdbId) {
    return res.json({ success: false, error: 'Kinopoisk ID not found' });
  }

  return res.json({
    success: true,
    kinopoisk_id: kinopoiskId,
    imdb_id: imdbId,
    title: q || ''
  });
});

// =========================================================
// 6. ПРОКСИ ДЛЯ M3U8 И MP4 ПОТОКОВ (/api/proxy/m3u8 и /api/proxy/stream)
// =========================================================
app.get('/api/proxy/m3u8', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://kodikplayer.com/';
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    const cleanUrl = targetUrl.startsWith('//') ? 'https:' + targetUrl : targetUrl;
    const basePath = cleanUrl.substring(0, cleanUrl.lastIndexOf('/') + 1);

    const response = await fetch(cleanUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer
      }
    });

    if (!response.ok) return res.status(response.status).send('Upstream error');
    const text = await response.text();

    // Переписываем относительные ссылки на сегменты и вложенные плейлисты
    const rewritten = text
      .replace(/^\.\/([^\r\n]+)/gm, `${basePath}$1`)
      .replace(/^(?!https?:\/\/|#|\/)([^\r\n]+\.(?:ts|mp4|m4s|m3u8)[^\r\n]*)/gm, (match) => {
        const fullSegUrl = `${basePath}${match.trim()}`;
        if (fullSegUrl.includes('.m3u8')) {
          return `/api/proxy/m3u8?url=${encodeURIComponent(fullSegUrl)}&referer=${encodeURIComponent(referer)}`;
        }
        return fullSegUrl;
      });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(rewritten);
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

app.get('/api/proxy/stream', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://video.sibnet.ru/';
  if (!targetUrl) return res.status(400).send('Missing url');

  try {
    const cleanUrl = targetUrl.startsWith('//') ? 'https:' + targetUrl : targetUrl;
    const headers = {
      'User-Agent': USER_AGENT,
      'Referer': referer
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstream = await fetch(cleanUrl, {
      headers,
      redirect: 'follow'
    });

    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
