import base64
import json
import os
import re
from urllib.parse import urljoin
from anime_parsers_ru import AnimegoParser
from flask import Flask, jsonify, redirect, request
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

parser = AnimegoParser()
KODIK_TOKEN = "447d179e875efe44217f20d1ee2146be"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


@app.route("/")
def index():
  return "KombokoWatch Backend is Running!"


@app.route("/api/status")
def status():
  return jsonify({"status": "ok"})


# =====================================================================
# АВТОРИЗАЦИЯ SHIKIMORI (БЕЗ ИЗМЕНЕНИЙ)
# =====================================================================
@app.route("/api/shikimori_auth", methods=["POST"])
def shikimori_auth():
  data = request.get_json() or {}
  code = data.get("code")
  redirect_uri = data.get("redirect_uri")

  if not code:
    return jsonify({"error": "No code provided"}), 400

  token_url = "https://shikimori.io/oauth/token"
  payload = {
      "grant_type": "authorization_code",
      "client_id": os.environ.get("SHIKI_CLIENT_ID"),
      "client_secret": os.environ.get("SHIKI_CLIENT_SECRET"),
      "code": code,
      "redirect_uri": redirect_uri,
  }
  headers = {"User-Agent": "KombokoWatchApp"}

  try:
    resp = requests.post(token_url, data=payload, headers=headers, timeout=12)
    if resp.status_code == 200:
      return jsonify(resp.json())
    return jsonify({"error": resp.text}), resp.status_code
  except Exception as e:
    return jsonify({"error": str(e)}), 500


# =====================================================================
# ПОЛУЧЕНИЕ СПИСКА ОЗВУЧЕК И СЕРИЙ KODIK (ЧТОБЫ РАБОТАЛО БЕЗ CORSPROXY)
# =====================================================================
@app.route("/api/kodik-search", methods=["GET"])
def kodik_search():
  shikimori_id = request.args.get("shikimori_id")
  if not shikimori_id:
    return jsonify({"error": "No shikimori_id"}), 400

  api_url = (
      f"https://kodikapi.com/search?token={KODIK_TOKEN}"
      f"&shikimori_id={shikimori_id}&with_episodes=true&with_material_data=true"
  )
  try:
    resp = requests.get(api_url, headers={"User-Agent": USER_AGENT}, timeout=10)
    return jsonify(resp.json()), resp.status_code
  except Exception as e:
    return jsonify({"error": str(e), "results": []}), 500


# =====================================================================
# УМНЫЙ ДЕКОДЕР ССЫЛОК KODIK (ПОДДЕРЖИВАЕТ ЛЮБОЙ СДВИГ ROT + BASE64)
# =====================================================================
def decode_kodik_link(encoded: str) -> str:
  if not encoded:
    return ""
  s = encoded.strip()
  if s.startswith("//"):
    return "https:" + s
  if s.startswith("http"):
    return s

  # Перебираем возможные сдвиги шифра Цезаря (включая классические 18 и 13)
  for shift in [18, 13] + [i for i in range(26) if i not in (18, 13)]:
    out = []
    for ch in s:
      if "a" <= ch <= "z":
        out.append(chr((ord(ch) - 97 + shift) % 26 + 97))
      elif "A" <= ch <= "Z":
        out.append(chr((ord(ch) - 65 + shift) % 26 + 65))
      else:
        out.append(ch)
    candidate = "".join(out)
    rem = len(candidate) % 4
    if rem:
      candidate += "=" * (4 - rem)
    try:
      raw = base64.b64decode(candidate).decode("utf-8", errors="ignore").strip()
      if ("//" in raw or "http" in raw) and (".m3u8" in raw or ".mp4" in raw):
        if raw.startswith("//"):
          return "https:" + raw
        return raw
    except Exception:
      continue
  return ""


def resolve_real_episode_link(shikimori_id, episode, translation_id):
  """Находит прямую ссылку на серию через API Кодика, если пришла ссылка-заглушка"""
  api_url = (
      f"https://kodikapi.com/search?token={KODIK_TOKEN}"
      f"&shikimori_id={shikimori_id}&with_episodes=true"
  )
  resp = requests.get(api_url, headers={"User-Agent": USER_AGENT}, timeout=10)
  results = resp.json().get("results", [])
  if not results:
    return None

  chosen = results[0]
  if translation_id:
    for r in results:
      t_id = str(r.get("translation", {}).get("id", ""))
      if t_id == str(translation_id):
        chosen = r
        break

  ep_str = str(episode or 1)
  seasons = chosen.get("seasons", {})
  for s_obj in seasons.values():
    eps = s_obj.get("episodes", {})
    if ep_str in eps:
      ep_val = eps[ep_str]
      return ep_val if isinstance(ep_val, str) else ep_val.get("link")

  return chosen.get("link")


@app.route("/api/get-stream", methods=["GET"])
def get_stream():
  link = request.args.get("link", "").strip()
  shikimori_id = request.args.get("shikimori_id", "").strip()
  episode = request.args.get("episode", "1").strip()
  translation_id = request.args.get("translation_id", "").strip()

  try:
    # Если передана общая ссылка find-player или ссылка пустая — ищем точную ссылку серии
    if (
        not link
        or "find-player" in link
        or not re.search(r"/(?:seria|video|serial|movie)/\d+/", link)
    ):
      if shikimori_id:
        resolved = resolve_real_episode_link(
            shikimori_id, episode, translation_id
        )
        if resolved:
          link = resolved

    if not link:
      return (
          jsonify({"success": False, "error": "Ссылка на серию не найдена"}),
          404,
      )

    if link.startswith("//"):
      link = "https:" + link

    session = requests.Session()
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": "https://shikimori.io/",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    }

    page_resp = session.get(link, headers=headers, timeout=10)
    html = page_resp.text
    current_url = page_resp.url

    # Если страница — сериал-обёртка с вложенным iframe, переходим внутрь iframe
    if "videoInfo" not in html and "urlParams" not in html:
      iframe_m = re.search(
          r'<iframe[^>]+src=["\']([^"\']+(?:seria|video)[^"\']*)["\']', html
      )
      if iframe_m:
        sub_link = iframe_m.group(1)
        if sub_link.startswith("//"):
          sub_link = "https:" + sub_link
        elif sub_link.startswith("/"):
          sub_link = urljoin(current_url, sub_link)
        page_resp = session.get(
            sub_link,
            headers={"User-Agent": USER_AGENT, "Referer": current_url},
            timeout=10,
        )
        html = page_resp.text
        current_url = page_resp.url

    # 1. Достаём urlParams (JSON или отдельные переменные)
    url_params = {}
    up_match = re.search(r"var\s+urlParams\s*=\s*['\"](\{.*?\})['\"]", html)
    if up_match:
      try:
        url_params = json.loads(up_match.group(1))
      except Exception:
        pass

    def extract_var(name, default=""):
      m = re.search(r"var\s+" + name + r"\s*=\s*['\"]([^'\"]+)['\"]", html)
      return m.group(1) if m else default

    d = url_params.get("d") or extract_var("domain", "shikimori.io")
    d_sign = url_params.get("d_sign") or extract_var("d_sign")
    pd = url_params.get("pd") or extract_var("pd", "kodikplayer.com")
    pd_sign = url_params.get("pd_sign") or extract_var("pd_sign")
    ref = url_params.get("ref") or extract_var("ref", "")
    ref_sign = url_params.get("ref_sign") or extract_var("ref_sign")

    # 2. Достаём videoInfo (type, hash, id)
    v_type = (
        re.search(r"videoInfo\.type\s*=\s*['\"]([^'\"]+)['\"]", html)
        or re.search(r"var\s+type\s*=\s*['\"]([^'\"]+)['\"]", html)
    )
    v_hash = (
        re.search(r"videoInfo\.hash\s*=\s*['\"]([^'\"]+)['\"]", html)
        or re.search(r"var\s+hash\s*=\s*['\"]([^'\"]+)['\"]", html)
    )
    v_id = (
        re.search(r"videoInfo\.id\s*=\s*['\"]([^'\"]+)['\"]", html)
        or re.search(r"var\s+videoId\s*=\s*['\"]([^'\"]+)['\"]", html)
    )

    video_type = v_type.group(1) if v_type else "seria"
    video_hash = v_hash.group(1) if v_hash else ""
    video_id = v_id.group(1) if v_id else ""

    if not (video_id and video_hash):
      url_m = re.search(
          r"/(seria|video|movie)/(\d+)/([a-f0-9]+)", current_url
      )
      if url_m:
        video_type = url_m.group(1)
        video_id = url_m.group(2)
        video_hash = url_m.group(3)

    if not (video_id and video_hash):
      return (
          jsonify({
              "success": False,
              "error": "Не удалось извлечь ID и хэш серии со страницы Kodik",
          }),
          404,
      )

    post_data = {
        "d": d,
        "d_sign": d_sign,
        "pd": pd,
        "pd_sign": pd_sign,
        "ref": ref,
        "ref_sign": ref_sign,
        "type": video_type,
        "hash": video_hash,
        "id": video_id,
        "bad_user": "false",
        "cdn_is_working": "true",
        "info": "{}",
    }

    post_headers = {
        "User-Agent": USER_AGENT,
        "Referer": current_url,
        "Origin": f"https://{pd}",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
    }

    # Пробуем актуальные эндпоинты плеера Kodik (/ftor, /gvi, /kor)
    ftor_json = None
    for ep_path in ["/ftor", "/gvi", "/kor"]:
      try:
        r = session.post(
            f"https://{pd}{ep_path}",
            data=post_data,
            headers=post_headers,
            timeout=8,
        )
        if r.status_code == 200 and "links" in r.text:
          ftor_json = r.json()
          break
      except Exception:
        continue

    if not ftor_json or "links" not in ftor_json:
      return (
          jsonify(
              {"success": False, "error": "Kodik не отдал объект links"}
          ),
          404,
      )

    links_obj = ftor_json.get("links", {})
    streams = {}

    for q_key, arr in links_obj.items():
      if isinstance(arr, list) and len(arr) > 0:
        raw_src = arr[0].get("src", "")
        dec = decode_kodik_link(raw_src)
        if dec:
          label = f"{q_key}p" if not str(q_key).endswith("p") else str(q_key)
          streams[label] = dec

    best_stream = (
        streams.get("720p")
        or streams.get("1080p")
        or streams.get("480p")
        or streams.get("360p")
        or (list(streams.values())[0] if streams else "")
    )

    if not best_stream:
      return (
          jsonify(
              {"success": False, "error": "Не удалось расшифровать поток"}
          ),
          404,
      )

    return jsonify({
        "success": True,
        "stream": best_stream,
        "qualities": streams,
        "skip_button": ftor_json.get("skip_button"),
    })

  except Exception as e:
    return jsonify({"success": False, "error": str(e)}), 500


# =====================================================================
# ПРОКСИ ANIBOOM (СОХРАНЁН)
# =====================================================================
@app.route("/api/proxy_player")
def proxy_player():
  source = request.args.get("source")
  mal_id = request.args.get("mal_id")
  ep = int(request.args.get("ep", 1))

  if source == "aniboom":
    try:
      shiki_res = requests.get(
          f"https://shikimori.io/api/animes/{mal_id}",
          headers={"User-Agent": "KombokoWatchApp"},
      ).json()
      title = shiki_res.get("russian") or shiki_res.get("name")
      if not title:
        return "Anime not found", 404

      search_results = parser.search(query=title)
      if not search_results:
        return "Not found on AnimeGo", 404

      anime_url = search_results[0].get("link")
      voices_data = parser.get_voices(anime_id=anime_url, episode=ep)
      voices = voices_data.get("voices", [])

      aniboom_voice = None
      for v in voices:
        if "aniboom" in str(v.get("player", "")).lower() or "aniboom" in str(
            v.get("embed", "")
        ).lower():
          aniboom_voice = v
          break

      if not aniboom_voice and voices:
        aniboom_voice = voices[0]

      if aniboom_voice and aniboom_voice.get("embed"):
        embed_url = aniboom_voice.get("embed")
        if embed_url.startswith("//"):
          embed_url = "https:" + embed_url
        return redirect(embed_url)

      return "AniBoom stream not available", 404
    except Exception as e:
      return f"Error: {str(e)}", 500

  return "Source not supported", 400


if __name__ == "__main__":
  port = int(os.environ.get("PORT", 5000))
  app.run(host="0.0.0.0", port=port)
