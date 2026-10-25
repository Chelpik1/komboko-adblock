import os
from flask import Flask, request, jsonify
from flask_cors import CORS
from anime_parsers_ru import KodikParser

app = Flask(__name__)
CORS(app)

parser = KodikParser()

@app.route("/")
def index():
    return "Kodik Parser Backend is Running!"

@app.route("/api/status")
def status():
    return jsonify({
        "status": "ok",
        "token": parser.token
    })

@app.route("/api/direct_link")
def direct_link():
    link = request.args.get("link", "")
    shikimori_id = request.args.get("shikimori_id", "")
    seria_num = int(request.args.get("seria_num", 1))
    translation_id = request.args.get("translation_id", "0")

    try:
        if shikimori_id:
            base_url, max_quality = parser.get_link(
                id=shikimori_id,
                id_type="shikimori",
                seria_num=seria_num,
                translation_id=str(translation_id)
            )
        else:
            base_url, max_quality = parser.get_m3u8_link(link)

        if base_url.startswith("//"):
            base_url = "https:" + base_url

        return jsonify({
            "base_url": base_url,
            "max_quality": max_quality
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
