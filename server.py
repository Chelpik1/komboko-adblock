import base64
import os
import re
from anime_parsers_ru import AnimegoParser
from flask import Flask, jsonify, redirect, request
from flask_cors import CORS
import requests

app = Flask(__name__)
# Разрешаем запросы с любого источника (включая komboko.fun)
CORS(app, resources={r"/api/*": {"origins": "*"}})

parser = AnimegoParser()


# =====================================================================
# 1. СТАНДАРТНЫЕ СТАТУСЫ И ХЕЛСЧЕК
# =====================================================================
@app.route("/")
def index():
  return "KombokoWatch Backend is Running!"


@app.route("/api/status")
def status():
  return jsonify({"status": "ok"})


# =====================================================================
# 2. АВТОРИЗАЦИЯ SHIKIMORI (ТВОЯ РОДНАЯ, БЕЗ ИЗМЕНЕНИЙ)
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
    resp = requests.post(token_url, data=payload, headers=headers)
    if resp.status_code == 200:
      return jsonify(resp.json())
    else:
      return jsonify({"error": resp.text}), resp.status_code
  except Exception as e:
    return jsonify({"error": str(e)}), 500


# =====================================================================
# 3. KODIK STREAM EXTRACTOR (ИЗВЛЕЧЕНИЕ ЧИСТОГО ПОТОКА БЕЗ РЕКЛАМЫ)
# =====================================================================
def decode_kodik_src(src: str) -> str:
  """Обратный сдвиг ROT-18 + Base64"""
  if src.startswith("//") or src.startswith("http"):
    return f"https:{src}" if src.startswith("//") else src

  decoded_chars = []
  for c in src:
    if "a" <= c <= "z":
      v = ord(c) + 18
      decoded_chars.append(chr(v if v <= 122 else v - 26))
    elif "A" <= c <= "Z":
      v = ord(c) + 18
      decoded_chars.append(chr(v if v <= 90 else v - 26))
    else:
      decoded_chars.append(c)

  transformed = "".join(decoded_chars)
  rem = len(transformed) % 4
  if rem > 0:
    transformed += "=" * (4 - rem)

  try:
    raw_url = base64.b64decode(transformed).decode("utf-8").strip()
    return f"https:{raw_url}" if raw_url.startswith("//") else raw_url
  except Exception:
    return ""


@app.route("/api/get-stream", methods=["GET"])
def get_stream():
  link = request.args.get("link")
  if not link:
    return jsonify({"error": "No link provided"}), 400

  if link.startswith("//"):
    link = f"https:{link}"

  headers = {
      "User-Agent": (
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML,"
          " like Gecko) Chrome/124.0.0.0 Safari/537.36"
      ),
      "Referer": "https://shikimori.io/",
  }

  try:
    session = requests.Session()
    page_resp = session.get(link, headers=headers, timeout=8)
    html = page_resp.text

    def extract_var(name):
      m = re.search(r'var\s+' + name + r'\s*=\s*["\']([^"\']+)["\']', html)
      return m.group(1) if m else ""

    domain = extract_var("domain") or "shikimori.io"
    d_sign = extract_var("d_sign")
    pd = extract_var("pd") or "kodikplayer.com"
    pd_sign = extract_var("pd_sign")
    ref = extract_var("ref") or "https://shikimori.io/"
    ref_sign = extract_var("ref_sign")
    type_val = extract_var("type") or "seria"
    video_id = extract_var("videoId")

    hash_match = re.search(r"/(?:seria|video|serial)/\d+/([a-f0-9]+)", link)
    video_hash = hash_match.group(1) if hash_match else ""

    if not (d_sign and pd_sign and video_id and video_hash):
      return (
          jsonify({
              "success": False,
              "error": "Failed to parse stream params",
              "raw_link": link,
          }),
          404,
      )

    ftor_url = f"https://{pd}/ftor"
    data = {
        "d": domain,
        "d_sign": d_sign,
        "pd": pd,
        "pd_sign": pd_sign,
        "ref": ref,
        "ref_sign": ref_sign,
        "type": type_val,
        "hash": video_hash,
        "id": video_id,
        "bad_user": "false",
        "cdn_is_working": "true",
    }
    ftor_headers = {
        "User-Agent": headers["User-Agent"],
        "Referer": link,
        "Origin": f"https://{pd}",
        "X-Requested-With": "XMLHttpRequest",
    }

    ftor_resp = session.post(
        ftor_url, data=data, headers=ftor_headers, timeout=8
    )
    ftor_json = ftor_resp.json()

    links_obj = ftor_json.get("links", {})
    streams = {}

    for quality in ["1080", "720", "480", "360"]:
      arr = links_obj.get(quality, [])
      if arr and len(arr) > 0:
        raw_src = arr[0].get("src", "")
        dec = decode_kodik_src(raw_src)
        if dec:
          streams[f"{quality}p"] = dec

    best_stream = (
        streams.get("720p")
        or streams.get("480p")
        or streams.get("1080p")
        or streams.get("360p")
        or ""
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
# 4. ПРОКСИ ANIBOOM (ДЛЯ ANIMEGO)
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
        player_name = str(v.get("player", "")).lower()
        embed_link = str(v.get("embed", "")).lower()
        if "aniboom" in player_name or "aniboom" in embed_link:
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
