from flask import Flask, request, redirect, jsonify
from anime_parsers_ru import AnimegoParser

app = Flask(__name__)
parser = AnimegoParser()

@app.route('/api/proxy_player')
def proxy_player():
    source = request.args.get('source')
    mal_id = request.args.get('mal_id')
    ep = int(request.args.get('ep', 1))
    
    if source == 'aniboom':
        try:
            # 1. Получаем информацию об аниме с Shikimori, чтобы узнать русское/оригинальное название для поиска на AnimeGo
            import requests
            shiki_res = requests.get(f"https://shikimori.io/api/animes/{mal_id}").json()
            title = shiki_res.get('russian') or shiki_res.get('name')
            
            if not title:
                return "Anime not found", 404

            # 2. Ищем аниме на AnimeGo через парсер
            search_results = parser.search(query=title)
            if not search_results:
                return "Not found on AnimeGo", 404
            
            anime_url = search_results[0].get('link')

            # 3. Получаем список озвучек и доступных эпизодов для первой серии
            voices_data = parser.get_voices(anime_id=anime_url, episode=ep)
            voices = voices_data.get('voices', [])

            # 4. Ищем озвучку AniBoom среди доступных
            aniboom_voice = None
            for v in voices:
                if 'aniboom' in str(v.get('player', '')).lower() or 'aniboom' in str(v.get('embed', '')).lower():
                    aniboom_voice = v
                    break
            
            # Если конкретного aniboom нет, берем первую попавшуюся рабочую озвучку
            if not aniboom_voice and voices:
                aniboom_voice = voices[0]

            if aniboom_voice and aniboom_voice.get('embed'):
                embed_url = aniboom_voice.get('embed')
                # Если ссылка относительная, приводим к абсолютному виду
                if embed_url.startswith('//'):
                    embed_url = 'https:' + embed_url
                return redirect(embed_url)
            
            return "AniBoom stream not available", 404

        except Exception as e:
            return f"Error: {str(e)}", 500

    # Стандартный код для остальных источников (Mega, English и т.д.)
    return "Source not supported", 400

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
