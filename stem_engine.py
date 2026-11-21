import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import soundfile as sf

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".webm", ".opus"}


def get_file_sha256(file_path: Path) -> str:
    hasher = hashlib.sha256()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def download_audio_from_url(url: str, downloads_dir: str = "downloads") -> Path:
    """Mengunduh file audio mentah dari URL menggunakan yt-dlp tanpa postprocessor eksternal."""
    out_folder = Path(downloads_dir)
    out_folder.mkdir(parents=True, exist_ok=True)

    out_template = str(out_folder / "%(id)s.%(ext)s")

    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "-f",
        "bestaudio/best",
        "-o",
        out_template,
        url,
    ]

    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Gagal mengunduh audio dari URL: {exc}") from exc

    candidates = sorted(
        [p for p in out_folder.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError("File audio hasil unduhan tidak ditemukan.")

    return candidates[0].resolve()


def trim_audio(
    input_audio: str,
    start_sec: float = 0.0,
    duration_sec: float = 25.0,
    trimmed_dir: str = "temp_clips",
) -> Path:
    """Memotong dan mengonversi audio menjadi WAV PCM 16-bit via imageio-ffmpeg."""
    src = Path(input_audio)
    if not src.exists():
        raise FileNotFoundError(f"File audio tidak ditemukan: {src}")

    out_folder = Path(trimmed_dir)
    out_folder.mkdir(parents=True, exist_ok=True)

    clip_name = f"{src.stem}_s{int(start_sec)}_d{int(duration_sec)}.wav"
    clip_path = out_folder / clip_name

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg_exe,
        "-y",
        "-ss",
        str(start_sec),
        "-t",
        str(duration_sec),
        "-i",
        str(src),
        "-vn",
        "-acodec",
        "pcm_s16le",
        str(clip_path),
    ]

    try:
        subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        return clip_path
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Gagal memotong/konversi audio via ffmpeg: {exc.stderr}") from exc


def separate_with_cache(
    audio_file: str,
    cache_dir: str = "stem_cache",
    model: str = "htdemucs",
    num_threads: int = 4,
) -> dict[str, Path]:
    audio_path = Path(audio_file)
    if not audio_path.exists():
        raise FileNotFoundError(f"File tidak ditemukan: {audio_path}")

    file_hash = get_file_sha256(audio_path)
    safe_model = model.replace("/", "_")
    cache_key = f"{file_hash[:16]}_{safe_model}"
    entry_dir = Path(cache_dir) / cache_key
    stems_dir = entry_dir / "stems"
    manifest_path = entry_dir / "manifest.json"

    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if all(Path(p).exists() for p in manifest.values()):
            return {k: Path(v).resolve() for k, v in manifest.items()}

    stems_dir.mkdir(parents=True, exist_ok=True)
    raw_demucs_dir = entry_dir / "_raw_demucs"
    raw_demucs_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["OMP_NUM_THREADS"] = str(num_threads)
    env["MKL_NUM_THREADS"] = str(num_threads)

    cmd = [
        sys.executable,
        "-m",
        "demucs",
        "-d",
        "cpu",
        "-n",
        model,
        "-o",
        str(raw_demucs_dir),
        str(audio_path),
    ]
    subprocess.run(cmd, env=env, check=True)

    produced_folder = raw_demucs_dir / model / audio_path.stem
    if not produced_folder.exists():
        raise RuntimeError(f"Folder output Demucs tidak ditemukan: {produced_folder}")

    stem_map: dict[str, Path] = {}
    for wav_file in sorted(produced_folder.glob("*.wav")):
        target_wav = stems_dir / wav_file.name
        wav_file.replace(target_wav)
        stem_map[wav_file.stem] = target_wav.resolve()

    manifest_path.write_text(
        json.dumps({k: str(v) for k, v in stem_map.items()}, indent=2),
        encoding="utf-8",
    )
    return stem_map


def load_stems_from_folder(folder_path: str) -> dict[str, Path]:
    folder = Path(folder_path)
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError(f"Folder stem tidak ditemukan: {folder}")

    stems: dict[str, Path] = {}
    for f in sorted(folder.iterdir()):
        if f.is_file() and f.suffix.lower() in AUDIO_EXTS:
            stems[f.stem] = f.resolve()

    if not stems:
        raise ValueError(f"Tidak ada file audio stem di folder: {folder}")
    return stems


def _apply_equal_power_pan(stereo_buf: np.ndarray, pan: float) -> np.ndarray:
    """pan: -1.0 (kiri) sampai +1.0 (kanan), 0.0 = tengah."""
    p = float(np.clip(pan, -1.0, 1.0))
    angle = (p + 1.0) * (np.pi / 4.0)
    left_gain = np.cos(angle)
    right_gain = np.sin(angle)

    out = stereo_buf.copy()
    out[:, 0] *= left_gain
    out[:, 1] *= right_gain
    return out


def render_mix_wav(
    stem_files: dict[str, Path],
    tracks_state: list[dict],
    master_volume: float = 1.0,
    out_path: str = "exports/mixed_output.wav",
) -> Path:
    """
    tracks_state item:
      {"name": str, "volume": float, "pan": float, "muted": bool, "solo": bool}
    """
    state_map = {item["name"]: item for item in tracks_state}
    any_solo = any(item.get("solo", False) for item in tracks_state)

    loaded: list[tuple[str, np.ndarray, int]] = []
    max_frames = 0
    sr_ref = None

    for name, path in stem_files.items():
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        if sr_ref is None:
            sr_ref = sr
        elif sr != sr_ref:
            raise ValueError(f"Sample rate berbeda pada '{name}': {sr} vs {sr_ref}")

        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        elif data.shape[1] > 2:
            data = data[:, :2]

        max_frames = max(max_frames, data.shape[0])
        loaded.append((name, data, sr))

    assert sr_ref is not None
    mix = np.zeros((max_frames, 2), dtype=np.float32)

    for name, data, _ in loaded:
        st = state_map.get(name, {"volume": 1.0, "pan": 0.0, "muted": False, "solo": False})
        if st.get("muted", False):
            continue
        if any_solo and not st.get("solo", False):
            continue

        vol = float(np.clip(st.get("volume", 1.0), 0.0, 2.0))
        pan = float(st.get("pan", 0.0))

        buf = np.zeros((max_frames, 2), dtype=np.float32)
        buf[: data.shape[0], :] = data
        buf = _apply_equal_power_pan(buf, pan) * vol
        mix += buf

    mix *= float(np.clip(master_volume, 0.0, 2.0))
    np.clip(mix, -1.0, 1.0, out=mix)

    out_file = Path(out_path)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_file), mix, sr_ref)
    return out_file.resolve()