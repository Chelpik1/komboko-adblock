from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import urllib.request
import urllib.parse
import re
import json
import base64

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def caesar_shift(text: str, shift: int) -> str:
    res = []
    for c in text:
        if 'a' <= c <= 'z':
            res.append(chr((ord(c) - 97 - shift + 26) % 26 + 97))
        elif 'A' <= c <= 'Z':
            res.append(chr((ord(c) - 65 - shift + 26) % 26 + 65))
        else:
            res.append(c)
    return ''.join(res)

def decode_cipher(cipher: str):
    for s in range(1, 26):
        try:
            shifted = caesar_shift(cipher, s)
            decoded = base64.b64decode(shifted).decode('utf-8', errors='ignore')
            if decoded.startswith('//') or decoded.startswith('http'):
                return (decoded if not decoded.startswith('//') else 'https:' + decoded), s
        except Exception:
            pass
    return None, None

@app.get("/api/kodik/extract")
def extract_kodik(link: str = Query(...)):
    try:
        clean_url = link if not link.startswith('//') else 'https:' + link
        url_obj = urllib.parse.urlparse(clean_url)
        params = urllib.parse.parse_qs(url_obj.query)
        ep_num = params.get('episode', ['1'])[0]

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://shikimori.io/'
        }
        req = urllib.request.Request(clean_url, headers=headers)
        html = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', errors='ignore')

        # Достаем подписи и домены
        d_sign_m = re.search(r'var\s+d_sign\s*=\s*["\']([^"\']+)["\']', html)
        d_sign = d_sign_m.group(1) if d_sign_m else ''

        pd_sign_m = re.search(r'var\s+pd_sign\s*=\s*["\']([^"\']+)["\']', html)
        pd_sign = pd_sign_m.group(1) if pd_sign_m else ''

        ref_m = re.search(r'var\s+ref\s*=\s*["\']([^"\']+)["\']', html)
        ref = ref_m.group(1) if ref_m else 'https://shikimori.io/'

        ref_sign_m = re.search(r'var\s+ref_sign\s*=\s*["\']([^"\']+)["\']', html)
        ref_sign = ref_sign_m.group(1) if ref_sign_m else ''

        # Находим реальный id и hash выбранной серии из выпадающего списка
        ep_option = re.search(rf'<option[^>]*value=["\']{ep_num}["\'][^>]*data-id=["\']([^"\']+)["\'][^>]*data-hash=["\']([^"\']+)["\']', html)
        if ep_option:
            ep_id = ep_option.group(1)
            ep_hash = ep_option.group(2)
        else:
            ep_id_m = re.search(r'videoInfo\.id\s*=\s*["\']([^"\']+)["\']', html)
            ep_hash_m = re.search(r'videoInfo\.hash\s*=\s*["\']([^"\']+)["\']', html)
            ep_id = ep_id_m.group(1) if ep_id_m else ''
            ep_hash = ep_hash_m.group(1) if ep_hash_m else ''

        if not ep_id or not ep_hash:
            return {"success": False, "error": "Could not parse episode credentials"}

        # Пост-запрос к /ftor
        post_data = urllib.parse.urlencode({
            'd': 'shikimori.io', 'd_sign': d_sign,
            'pd': 'kodikplayer.com', 'pd_sign': pd_sign,
            'ref': ref, 'ref_sign': ref_sign,
            'bad_user': 'false', 'type': 'seria',
            'hash': ep_hash, 'id': ep_id
        }).encode('utf-8')

        ftor_req = urllib.request.Request(
            'https://kodikplayer.com/ftor',
            data=post_data,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': clean_url,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
            }
        )
        ftor_res = urllib.request.urlopen(ftor_req, timeout=10).read().decode('utf-8')
        ftor_data = json.loads(ftor_res)

        qualities = {}
        for q, arr in ftor_data.get('links', {}).items():
            if arr and isinstance(arr, list):
                url, _ = decode_cipher(arr[0]['src'])
                if url:
                    qualities[f'{q}p'] = url

        best_stream = qualities.get('720p') or qualities.get('480p') or qualities.get('360p')
        return {
            "success": True,
            "player": "kodik",
            "stream": best_stream,
            "qualities": qualities,
            "skip_segments": []
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/aniboom/extract")
def extract_aniboom(url: str = Query(...)):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://animego.me/'})
        html = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', errors='ignore')
        param_match = re.search(r'data-parameters=["\']([^"\']+)["\']', html)
        if not param_match:
            return {"success": False, "error": "No data-parameters found"}
        unescaped = param_match.group(1).replace('&quot;', '"')
        data = json.loads(unescaped)
        hls_url = data.get('hls')
        return {
            "success": True,
            "player": "aniboom",
            "stream": hls_url,
            "qualities": {"1080p": hls_url}
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
