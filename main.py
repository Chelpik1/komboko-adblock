import anime_dl_core as ap
from fastapi import FastAPI, Response, Request
from fastapi.middleware.cors import CORSMiddleware
import httpx

app = FastAPI()

# Разрешаем запросы с вашего сайта komboko.fun
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://komboko.fun", "https://www.komboko.fun", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

@app.get("/api/kodik/extract")
def extract_kodik(link: str):
    try:
        res = ap.extract(link)
        qualities = {f"{s.quality}p": s.url for s in res.streams if s.quality}
        best = res.best(kind="hls") or res.best()
        skips = [{"start": seg.start, "end": seg.end, "kind": seg.kind} for seg in (res.skip_segments or [])]
        return {
            "success": True,
            "player": "kodik",
            "stream": best.url if best else None,
            "qualities": qualities,
            "skip_segments": skips
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/aniboom/extract")
def extract_aniboom(url: str):
    try:
        res = ap.extract(url)
        qualities = {f"{s.quality}p": s.url for s in res.streams if s.quality}
        best = res.best(kind="hls") or res.best()
        return {
            "success": True,
            "player": "aniboom",
            "stream": best.url if best else None,
            "qualities": qualities
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/sibnet/extract")
def extract_sibnet(url: str):
    try:
        res = ap.extract(url, resolve=False)
        stream = res.best()
        return {
            "success": True,
            "player": "sibnet",
            "stream": stream.url if stream else None,
            "qualities": {"720p": stream.url} if stream else {}
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/proxy/m3u8")
async def proxy_m3u8(url: str, referer: str = "https://kodikplayer.com/"):
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, headers={"Referer": referer, "User-Agent": USER_AGENT})
        lines = resp.text.split("\n")
        base_url = url[:url.rfind("/") + 1]
        rewritten = []
        for line in lines:
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#"):
                rewritten.append(line)
            else:
                chunk = trimmed if trimmed.startswith("http") else f"{base_url}{trimmed}"
                rewritten.append(f"/api/proxy/stream?url={httpx.URL(chunk)}&referer={referer}")
        return Response(content="\n".join(rewritten), media_type="application/vnd.apple.mpegurl")

@app.get("/api/proxy/stream")
async def proxy_stream(request: Request, url: str, referer: str = "https://kodikplayer.com/"):
    headers = {"Referer": referer, "User-Agent": USER_AGENT}
    if "range" in request.headers:
        headers["Range"] = request.headers["range"]
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(url, headers=headers)
        return Response(
            content=r.content,
            status_code=r.status_code,
            headers={k: v for k, v in r.headers.items() if k.lower() in ["content-type", "content-length", "content-range", "accept-ranges"]}
        )
