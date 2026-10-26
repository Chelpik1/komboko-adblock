import os
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
import requests
from anime_parsers_ru import AnimegoParser

app = Flask(__name__)
CORS(app)
parser = AnimegoParser()

@app.route("/")
def index():
    return "KombokoWatch Backend is Running!"

@app.route("/api/status")
def status():
    return jsonify({"status": "ok"})

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
        "redirect_uri": redirect_uri
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

@app.route("/api/proxy_player")
def proxy_player():
    source = request.args.get('source')
    mal_id = request.args.get('mal_id')
    ep = int(request.args.get('ep', 1))
    
    if source == 'aniboom':
        try:
            # 1. Получаем название аниме с Shikimori по ID
            shiki_res = requests.get(f"https://shikimori.io/api/animes/{mal_id}", headers={"User-Agent": "KombokoWatchApp"}).json()
            title = shiki_res.get('russian') or shiki_res.get('name')
            
            if not title:
                return jsonify({"error": "Anime not found"}), 404

            # 2. Ищем аниме на AnimeGo через парсер
            search_results = parser.search(query=title)
            if not search_results:
                return jsonify({"error": "Not found on AnimeGo"}), 404
            
            anime_url = search_results[0].get('link')

            # 3. Получаем список озвучек для эпизода
            voices_data = parser.get_voices(anime_id=anime_url, episode=ep)
            voices = voices_data.get('voices', [])

            # 4. Ищем Aniboom среди озвучек
            target_voice = None
            for v in voices:
                player_name = str(v.get('player', '')).lower()
                embed_link = str(v.get('embed', '')).lower()
                if 'aniboom' in player_name or 'aniboom' in embed_link:
                    target_voice = v
                    break
            
            if not target_voice and voices:
                target_voice = voices[0]

            if not target_voice:
                return jsonify({"error": "Voice not found"}), 404

            translation_id = target_voice.get('translation_id') or target_voice.get('id')

            # 5. Получаем прямой поток Aniboom (HLS) по инструкции из библиотеки
            stream_data = parser.aniboom_get_stream(anime_id=anime_url, episode=ep, translation_id=translation_id)
            
            if stream_data and stream_data.get('url'):
                return jsonify({"url": stream_data.get('url'), "kind": "HLS"})
            
            return jsonify({"error": "Stream URL not found"}), 404

        except Exception as e:
            return jsonify({"error": str(e)}), 500

    return jsonify({"error": "Source not supported"}), 400

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
