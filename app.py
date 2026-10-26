@app.route('/api/english_stream', methods=['GET'])
def get_english_stream():
    mal_id = request.args.get('mal_id')
    episode = request.args.get('ep', '1')
    
    if not mal_id:
        return jsonify({'success': False, 'error': 'mal_id is required'}), 400

    try:
        # Здесь твой бэкенд может обращаться к открытым API стриминга (например, Consumet/Anify) 
        # или возвращать валидный прямой HLS поток (.m3u8)
        # Пример заглушки-прокси для потока:
        stream_url = f"https://example-stream-source.com/anime/{mal_id}/{episode}/master.m3u8"
        
        return jsonify({
            'success': True,
            'stream_url': stream_url
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
