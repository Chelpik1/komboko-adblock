import requests
from flask import Flask, jsonify, request, Response

# (Твой существующий код инициализации Flask app ...)

@app.route('/api/proxy_player', methods=['GET'])
def proxy_player():
    mal_id = request.args.get('mal_id')
    episode = request.args.get('ep', '1')
    
    if not mal_id:
        return "mal_id is required", 400

    target_url = f"https://megaplay.buzz/stream/mal/{mal_id}/{episode}/dub"
    
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://megaplay.buzz/'
        }
        resp = requests.get(target_url, headers=headers, timeout=10)
        html_content = resp.text
        
        # Скрипт защиты: глушит попытки открыть рекламу через window.open и жестко пресекает увод вкладки
        anti_ad_script = """
        <script>
            window.open = function() { console.log("Ad popup blocked"); return null; };
            try {
                Object.defineProperty(window, 'top', {
                    get: function() { return window; },
                    set: function(v) { return v; }
                });
            } catch(e) {}
        </script>
        """
        
        # Внедряем защиту сразу после тега <head>
        if '<head>' in html_content:
            html_content = html_content.replace('<head>', '<head>' + anti_ad_script, 1)
        else:
            html_content = anti_ad_script + html_content

        return Response(html_content, content_type='text/html; charset=utf-8')
    except Exception as e:
        return f"Proxy error: {str(e)}", 500
