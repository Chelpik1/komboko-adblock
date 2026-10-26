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
                return "Anime not found", 404

            # 2. Ищем аниме на AnimeGo через парсер
            search_results = parser.search(query=title)
            if not search_results:
                return "Not found on AnimeGo", 404
            
            anime_url = search_results[0].get('link')

            # 3. Получаем список озвучек и плееров для эпизода
            voices_data = parser.get_voices(anime_id=anime_url, episode=ep)
            voices = voices_data.get('voices', [])

            # 4. Ищем AniBoom среди доступных озвучек
            aniboom_voice = None
            for v in voices:
                player_name = str(v.get('player', '')).lower()
                embed_link = str(v.get('embed', '')).lower()
                if 'aniboom' in player_name or 'aniboom' in embed_link:
                    aniboom_voice = v
                    break
            
            # Если конкретного анибума нет, берем первую попавшуюся озвучку
            if not aniboom_voice and voices:
                aniboom_voice = voices[0]

            if aniboom_voice and aniboom_voice.get('embed'):
                embed_url = aniboom_voice.get('embed')
                if embed_url.startswith('//'):
                    embed_url = 'https:' + embed_url
                return redirect(embed_url)
            
            return "AniBoom stream not available", 404

        except Exception as e:
            return f"Error: {str(e)}", 500

    return "Source not supported", 400

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
