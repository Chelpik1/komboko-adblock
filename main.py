from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import anime_dl_core as ap

app = FastAPI()

# Разрешаем CORS для твоего сайта
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/extract")
def extract_stream(url: str):
    """
    Принимает любую embed-ссылку (Aniboom, CVH, Kodik, Animedia и т.д.),
    достает прямую ссылку на видео и заголовки через anime-dl-core.
    """
    try:
        result = ap.extract(url)
        if not result or not result.streams:
            raise HTTPException(status_code=404, detail="Потоки не найдены")
        
        # Берём лучшее качество (предпочтительно HLS или MP4)
        best_stream = result.best()
        
        return {
            "success": True,
            "player": result.player,
            "title": result.title,
            "translation": result.translation,
            "stream_url": best_stream.url,
            "headers": best_stream.headers,
            "qualities": result.qualities,
            "skip_segments": [{"start": s.start, "end": s.end, "kind": s.kind} for s in result.skip_segments]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/cvh-playlist")
def get_cvh_playlist(id: str, season: int = 1, episode: int = 1, studio: str = None):
    """
    Специфичный метод для CVH (CdnVideoHub), описанный в документации:
    позволяет получить плейлист серий и студий для тайтла.
    """
    try:
        with ap.CvhPlayer() as player:
            result = player.extract(id, season=season, episode=episode, studio=studio)
            best_stream = result.best()
            return {
                "success": True,
                "stream_url": best_stream.url,
                "headers": best_stream.headers,
                "qualities": result.qualities
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
