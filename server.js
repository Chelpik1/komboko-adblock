import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

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
  for (let s = 1; s <= 25; s++) {
    try {
      const shifted = caesarShift(cipher, s);
      const decoded = Buffer.from(shifted, 'base64').toString('utf8');
      if (decoded.startsWith('//') || decoded.startsWith('http')) {
        return { url: decoded.startsWith('//') ? 'https:' + decoded : decoded, shift: s };
      }
    } catch (_) {}
  }
  return null;
}

app.get('/api/kodik/extract', async (req, res) => {
  const link = req.query.link;
  if (!link) return res.status(400).json({ success: false, error: 'link required' });

  try {
    const cleanUrl = link.startsWith('//') ? 'https:' + link : link;
    const urlObj = new URL(cleanUrl);
    const epNum = urlObj.searchParams.get('episode') || '1';

    const pageRes = await fetch(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://shikimori.io/'
      }
    });
    const html = await pageRes.text();

    const dSign = html.match(/var\s+d_sign\s*=\s*"([^"]+)"/)?.[1] || '';
    const pdSign = html.match(/var\s+pd_sign\s*=\s*"([^"]+)"/)?.[1] || '';
    const ref = html.match(/var\s+ref\s*=\s*"([^"]+)"/)?.[1] || 'https://shikimori.io/';
    const refSign = html.match(/var\s+ref_sign\s*=\s*"([^"]+)"/)?.[1] || '';

    const epMatch = html.match(new RegExp(`<option[^>]*value=["']${epNum}["'][^>]*data-id=["']([^"']+)["'][^>]*data-hash=["']([^"']+)["']`));
    const epId = epMatch ? epMatch[1] : (html.match(/videoInfo\.id\s*=\s*"([^"]+)"/)?.[1] || '');
    const epHash = epMatch ? epMatch[2] : (html.match(/videoInfo\.hash\s*=\s*"([^"]+)"/)?.[1] || '');

    if (!epId || !epHash) {
      return res.json({ success: false, error: 'Cannot parse episode credentials' });
    }

    const postData = new URLSearchParams({
      d: 'shikimori.io', d_sign: dSign,
      pd: 'kodikplayer.com', pd_sign: pdSign,
      ref: ref, ref_sign: refSign,
      bad_user: 'false', type: 'seria',
      hash: epHash, id: epId
    });

    const ftorRes = await fetch('https://kodikplayer.com/ftor', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
        if (dec) qualities[`${q}p`] = dec.url;
      }
    }

    const bestStream = qualities['720p'] || qualities['480p'] || Object.values(qualities)[0];
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
