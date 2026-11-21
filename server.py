import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from stem_engine import (
    download_audio_from_url,
    load_stems_from_folder,
    render_mix_wav,
    separate_with_cache,
    trim_audio,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
EXPORT_DIR = BASE_DIR / "exports"

app = FastAPI(title="Stem Mixer Studio")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

ACTIVE_SESSION: dict[str, object] = {
    "title": "Belum ada lagu dimuat",
    "stems": {},
}


class LoadSourceRequest(BaseModel):
    mode: str = Field(..., pattern="^(separate|folder)$")
    path: str
    model: str = "htdemucs"
    num_threads: int = Field(default=4, ge=1, le=32)
    use_trim: bool = True
    start_sec: float = Field(default=0.0, ge=0.0)
    duration_sec: float = Field(default=25.0, gt=1.0, le=3600.0)


class TrackState(BaseModel):
    name: str
    volume: float = 1.0
    pan: float = 0.0
    muted: bool = False
    solo: bool = False


class ExportMixRequest(BaseModel):
    tracks: list[TrackState]
    master_volume: float = 1.0


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.post("/api/load-source")
def load_source(req: LoadSourceRequest) -> dict:
    try:
        if req.mode == "folder":
            stems = load_stems_from_folder(req.path)
            title = Path(req.path).name
        else:
            raw_input = req.path.strip()
            if raw_input.startswith(("http://", "https://")):
                src_path = download_audio_from_url(raw_input)
            else:
                src_path = Path(raw_input)
                if not src_path.exists():
                    raise FileNotFoundError(f"File tidak ditemukan: {src_path}")

            target_audio = src_path
            if req.use_trim:
                target_audio = trim_audio(
                    str(src_path),
                    start_sec=req.start_sec,
                    duration_sec=req.duration_sec,
                )

            stems = separate_with_cache(
                str(target_audio),
                model=req.model,
                num_threads=req.num_threads,
            )
            title = target_audio.stem

        ACTIVE_SESSION["title"] = title
        ACTIVE_SESSION["stems"] = stems

        return {
            "title": title,
            "stems": [
                {
                    "name": name,
                    "url": f"/api/stems/{name}",
                }
                for name in stems.keys()
            ],
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/stems/{stem_name}")
def get_stem_audio(stem_name: str) -> FileResponse:
    stems: dict[str, Path] = ACTIVE_SESSION.get("stems", {})  # type: ignore[assignment]
    path = stems.get(stem_name)
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail="Stem tidak ditemukan")
    return FileResponse(path=str(path), media_type="audio/wav", filename=path.name)


@app.post("/api/export")
def export_mix(req: ExportMixRequest) -> FileResponse:
    stems: dict[str, Path] = ACTIVE_SESSION.get("stems", {})  # type: ignore[assignment]
    if not stems:
        raise HTTPException(status_code=400, detail="Belum ada stem aktif untuk di-export")

    out_name = f"mix_{uuid.uuid4().hex[:8]}.wav"
    out_file = render_mix_wav(
        stem_files=stems,
        tracks_state=[t.model_dump() for t in req.tracks],
        master_volume=req.master_volume,
        out_path=str(EXPORT_DIR / out_name),
    )
    return FileResponse(path=str(out_file), media_type="audio/wav", filename="custom_mix.wav")