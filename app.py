import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

# (Твой существующий код инициализации Flask app ...)

@app.route('/api/english_player', methods=['GET'])
def get_english_player():
    mal_id = request.args.get('mal_id')
    episode = request.args.get('ep', '1')
    
    if not mal_id:
        return jsonify({'error': 'mal_id is required'}), 400

    try:
        # Используем стабильный открытый прокси-агрегатор для англоязычного контента (например, VidSrc/2Embed экосистему)
        # Этот URL отдает чистый плеер без агрессивных редиректов на рекламу
        embed_url = f"https://vidsrc.me/embed/anime?mal={mal_id}&ep={episode}"
        
        # Альтернативный вариант через Anify / Consumet эндпоинты, если потребуется точечный поиск
        return jsonify({
            'success': True,
            'url': embed_url
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
