import os
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

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

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
