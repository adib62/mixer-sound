const sourceForm = document.getElementById("sourceForm");
const modeSelect = document.getElementById("modeSelect");
const modelSelect = document.getElementById("modelSelect");
const pathInput = document.getElementById("pathInput");
const startInput = document.getElementById("startInput");
const durationInput = document.getElementById("durationInput");
const loadBtn = document.getElementById("loadBtn");

const songTitleEl = document.getElementById("songTitle");
const statusBarEl = document.getElementById("statusBar");
const tracksContainer = document.getElementById("tracksContainer");

const playPauseBtn = document.getElementById("playPauseBtn");
const playIcon = document.getElementById("playIcon");
const seekBar = document.getElementById("seekBar");
const currentTimeEl = document.getElementById("currentTime");
const totalTimeEl = document.getElementById("totalTime");

const loopBtn = document.getElementById("loopBtn");
const abLoopBtn = document.getElementById("abLoopBtn");
const resetMixBtn = document.getElementById("resetMixBtn");
const exportBtn = document.getElementById("exportBtn");

const masterFader = document.getElementById("masterFader");
const masterReadout = document.getElementById("masterReadout");
const masterMuteBtn = document.getElementById("masterMuteBtn");
const clearSoloBtn = document.getElementById("clearSoloBtn");

let audioCtx = null;
let masterGainNode = null;
let tracks = [];

let isPlaying = false;
let duration = 0;
let playStartCtxTime = 0;
let playStartOffset = 0;
let rafId = null;

let loopEnabled = false;
let abLoopEnabled = false;
let loopStart = 0;
let loopEnd = 10;
let masterMuted = false;

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function setStatus(msg, isError = false) {
  statusBarEl.textContent = msg;
  statusBarEl.style.color = isError ? "#ff7b7b" : "#8be9fd";
}

function syncModeUI() {
  const isFolder = modeSelect.value === "folder";
  modelSelect.style.display = isFolder ? "none" : "";
  startInput.style.display = isFolder ? "none" : "";
  durationInput.style.display = isFolder ? "none" : "";
  pathInput.placeholder = isFolder
    ? "Path folder berisi file stems (.wav/.mp3)..."
    : "Path file lagu atau URL YouTube...";
}

function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    masterGainNode = audioCtx.createGain();
    masterGainNode.gain.value = masterMuted ? 0 : Number(masterFader.value);
    masterGainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function getCurrentPosition() {
  if (!isPlaying || !audioCtx) {
    return playStartOffset;
  }
  const elapsed = audioCtx.currentTime - playStartCtxTime;
  let pos = playStartOffset + elapsed;

  if (abLoopEnabled && pos >= loopEnd) {
    pos = loopStart;
    restartPlaybackAt(loopStart);
  } else if (loopEnabled && duration > 0 && pos >= duration) {
    pos = 0;
    restartPlaybackAt(0);
  } else if (duration > 0 && pos >= duration) {
    pos = duration;
    stopPlayback(false);
  }
  return Math.max(0, Math.min(pos, duration || pos));
}

function applyEqualPowerPan(stereoPanner, panValue) {
  if (!stereoPanner) return;
  stereoPanner.pan.value = Math.max(-1, Math.min(1, Number(panValue) || 0));
}

function recomputeTrackGains() {
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    const active = !t.muted && (!anySolo || t.solo);
    const targetGain = active ? t.volume : 0;
    if (t.gainNode && audioCtx) {
      t.gainNode.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.015);
    }
    if (t.muteBtn) {
      t.muteBtn.classList.toggle("active", t.muted);
    }
    if (t.soloBtn) {
      t.soloBtn.classList.toggle("active", t.solo);
    }
  }
}

function stopSourcesOnly() {
  for (const t of tracks) {
    if (t.sourceNode) {
      try {
        t.sourceNode.stop();
      } catch (_) {}
      try {
        t.sourceNode.disconnect();
      } catch (_) {}
      t.sourceNode = null;
    }
  }
}

function startPlaybackAt(offsetSec) {
  if (!tracks.length || duration <= 0) return;
  ensureAudioContext();
  stopSourcesOnly();

  const clampedOffset = Math.max(0, Math.min(offsetSec, Math.max(0, duration - 0.05)));
  playStartOffset = clampedOffset;
  playStartCtxTime = audioCtx.currentTime;
  isPlaying = true;
  playIcon.innerHTML = "&#10074;&#10074;";

  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    const src = audioCtx.createBufferSource();
    src.buffer = t.buffer;

    const panner = audioCtx.createStereoPanner();
    applyEqualPowerPan(panner, t.pan);

    const gain = audioCtx.createGain();
    const active = !t.muted && (!anySolo || t.solo);
    gain.gain.value = active ? t.volume : 0;

    src.connect(panner);
    panner.connect(gain);
    gain.connect(masterGainNode);

    src.start(0, clampedOffset);
    t.sourceNode = src;
    t.pannerNode = panner;
    t.gainNode = gain;
  }

  tickUI();
}

function restartPlaybackAt(offsetSec) {
  startPlaybackAt(offsetSec);
}

function stopPlayback(resetToZero = false) {
  stopSourcesOnly();
  isPlaying = false;
  playIcon.innerHTML = "&#9654;";
  if (resetToZero) {
    playStartOffset = 0;
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  updateTimeDisplay(getCurrentPosition());
}

function updateTimeDisplay(pos) {
  currentTimeEl.textContent = formatTime(pos);
  totalTimeEl.textContent = formatTime(duration);
  if (duration > 0) {
    seekBar.value = String(Math.round((pos / duration) * 1000));
  } else {
    seekBar.value = "0";
  }
}

function tickUI() {
  if (!isPlaying) return;
  const pos = getCurrentPosition();
  updateTimeDisplay(pos);
  rafId = requestAnimationFrame(tickUI);
}

function renderTrackStrips() {
  tracksContainer.innerHTML = "";

  for (const t of tracks) {
    const strip = document.createElement("div");
    strip.className = "track-strip";

    const nameEl = document.createElement("div");
    nameEl.className = "track-name";
    nameEl.textContent = t.name.toUpperCase();

    const panLabel = document.createElement("div");
    panLabel.className = "pan-readout";
    panLabel.textContent = formatPan(t.pan);

    const panSlider = document.createElement("input");
    panSlider.type = "range";
    panSlider.min = "-1";
    panSlider.max = "1";
    panSlider.step = "0.05";
    panSlider.value = String(t.pan);
    panSlider.className = "pan-slider";
    panSlider.addEventListener("input", () => {
      t.pan = Number(panSlider.value);
      panLabel.textContent = formatPan(t.pan);
      if (t.pannerNode && audioCtx) {
        t.pannerNode.pan.setTargetAtTime(t.pan, audioCtx.currentTime, 0.015);
      }
    });

    const faderWrap = document.createElement("div");
    faderWrap.className = "fader-wrap";

    const volSlider = document.createElement("input");
    volSlider.type = "range";
    volSlider.min = "0";
    volSlider.max = "1.5";
    volSlider.step = "0.01";
    volSlider.value = String(t.volume);
    volSlider.className = "vertical-fader";
    volSlider.addEventListener("input", () => {
      t.volume = Number(volSlider.value);
      recomputeTrackGains();
    });

    faderWrap.appendChild(volSlider);

    const btnRow = document.createElement("div");
    btnRow.className = "track-btns";

    const muteBtn = document.createElement("button");
    muteBtn.type = "button";
    muteBtn.textContent = "M";
    muteBtn.className = "mini-btn";
    muteBtn.addEventListener("click", () => {
      t.muted = !t.muted;
      recomputeTrackGains();
    });

    const soloBtn = document.createElement("button");
    soloBtn.type = "button";
    soloBtn.textContent = "S";
    soloBtn.className = "mini-btn";
    soloBtn.addEventListener("click", () => {
      t.solo = !t.solo;
      recomputeTrackGains();
    });

    t.volSlider = volSlider;
    t.panSlider = panSlider;
    t.panLabel = panLabel;
    t.muteBtn = muteBtn;
    t.soloBtn = soloBtn;

    btnRow.appendChild(muteBtn);
    btnRow.appendChild(soloBtn);

    strip.appendChild(nameEl);
    strip.appendChild(panLabel);
    strip.appendChild(panSlider);
    strip.appendChild(faderWrap);
    strip.appendChild(btnRow);

    tracksContainer.appendChild(strip);
  }
}

function formatPan(val) {
  const v = Number(val) || 0;
  if (Math.abs(v) < 0.03) return "PAN: C";
  if (v < 0) return `PAN: L${Math.round(Math.abs(v) * 100)}`;
  return `PAN: R${Math.round(v * 100)}`;
}

async function loadStemBuffers(stemItems) {
  ensureAudioContext();
  stopPlayback(true);
  tracks = [];
  duration = 0;

  for (const item of stemItems) {
    const resp = await fetch(item.url);
    if (!resp.ok) {
      throw new Error(`Gagal mengambil audio stem '${item.name}'`);
    }
    const arrayBuf = await resp.arrayBuffer();
    const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
    duration = Math.max(duration, audioBuf.duration);

    tracks.push({
      name: item.name,
      url: item.url,
      buffer: audioBuf,
      volume: 1.0,
      pan: 0.0,
      muted: false,
      solo: false,
      sourceNode: null,
      pannerNode: null,
      gainNode: null,
    });
  }

  loopEnd = Math.min(10, duration || 10);
  abLoopBtn.textContent = `SET A-B (0-${Math.round(loopEnd)}s)`;
  renderTrackStrips();
  updateTimeDisplay(0);
}

sourceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const rawPath = pathInput.value.trim().replace(/^"+|"+$/g, "");
  if (!rawPath) {
    setStatus("Masukkan path file lagu atau folder stems dulu.", true);
    return;
  }

  loadBtn.disabled = true;
  const activeModel = modelSelect.value;
  setStatus(
    modeSelect.value === "separate"
      ? `Memproses (${activeModel})... cek log terminal untuk progres.`
      : "Memuat folder stems..."
  );

  try {
    const payload = {
      mode: modeSelect.value,
      path: rawPath,
      model: activeModel,
      num_threads: 4,
      use_trim: modeSelect.value === "separate",
      start_sec: Number(startInput.value || 0),
      duration_sec: Number(durationInput.value || 25),
    };

    const resp = await fetch("/api/load-source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "Gagal memuat sumber audio");
    }

    await loadStemBuffers(data.stems || []);
    songTitleEl.textContent = (data.title || "STEM MIXER").toUpperCase();
    setStatus(`Berhasil memuat ${tracks.length} stem untuk "${data.title}".`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  } finally {
    loadBtn.disabled = false;
  }
});

playPauseBtn.addEventListener("click", () => {
  if (!tracks.length) return;
  if (isPlaying) {
    playStartOffset = getCurrentPosition();
    stopPlayback(false);
  } else {
    startPlaybackAt(playStartOffset);
  }
});

seekBar.addEventListener("input", () => {
  if (!tracks.length || duration <= 0) return;
  const targetPos = (Number(seekBar.value) / 1000) * duration;
  playStartOffset = targetPos;
  updateTimeDisplay(targetPos);
  if (isPlaying) {
    startPlaybackAt(targetPos);
  }
});

loopBtn.addEventListener("click", () => {
  loopEnabled = !loopEnabled;
  if (loopEnabled) abLoopEnabled = false;
  loopBtn.classList.toggle("active", loopEnabled);
  abLoopBtn.classList.toggle("active", abLoopEnabled);
  loopBtn.textContent = loopEnabled ? "LOOP: ON" : "LOOP: OFF";
});

abLoopBtn.addEventListener("click", () => {
  if (duration <= 0) return;
  abLoopEnabled = !abLoopEnabled;
  if (abLoopEnabled) {
    loopEnabled = false;
    loopBtn.classList.remove("active");
    loopBtn.textContent = "LOOP: OFF";
    loopStart = Math.max(0, Math.min(playStartOffset, Math.max(0, duration - 1)));
    loopEnd = Math.min(duration, loopStart + 10);
    abLoopBtn.textContent = `A-B (${Math.round(loopStart)}-${Math.round(loopEnd)}s)`;
    startPlaybackAt(loopStart);
  } else {
    abLoopBtn.textContent = "SET A-B (0-10s)";
  }
  abLoopBtn.classList.toggle("active", abLoopEnabled);
});

resetMixBtn.addEventListener("click", () => {
  for (const t of tracks) {
    t.volume = 1.0;
    t.pan = 0.0;
    t.muted = false;
    t.solo = false;
    if (t.volSlider) t.volSlider.value = "1";
    if (t.panSlider) t.panSlider.value = "0";
    if (t.panLabel) t.panLabel.textContent = formatPan(0);
    if (t.pannerNode && audioCtx) {
      t.pannerNode.pan.setTargetAtTime(0, audioCtx.currentTime, 0.015);
    }
  }
  masterMuted = false;
  masterFader.value = "1";
  masterMuteBtn.classList.remove("active");
  masterMuteBtn.textContent = "MUTE";
  updateMasterReadout();
  if (masterGainNode && audioCtx) {
    masterGainNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.015);
  }
  recomputeTrackGains();
  setStatus("Mix di-reset ke posisi default.");
});

function updateMasterReadout() {
  const pct = Math.round(Number(masterFader.value) * 100);
  masterReadout.innerHTML = masterMuted ? `MUTED<br />${pct}%` : `GAIN<br />${pct}%`;
}

masterFader.addEventListener("input", () => {
  updateMasterReadout();
  if (masterGainNode && audioCtx && !masterMuted) {
    masterGainNode.gain.setTargetAtTime(Number(masterFader.value), audioCtx.currentTime, 0.015);
  }
});

masterMuteBtn.addEventListener("click", () => {
  masterMuted = !masterMuted;
  masterMuteBtn.classList.toggle("active", masterMuted);
  masterMuteBtn.textContent = masterMuted ? "UNMUTE" : "MUTE";
  updateMasterReadout();
  if (masterGainNode && audioCtx) {
    const target = masterMuted ? 0 : Number(masterFader.value);
    masterGainNode.gain.setTargetAtTime(target, audioCtx.currentTime, 0.015);
  }
});

clearSoloBtn.addEventListener("click", () => {
  for (const t of tracks) {
    t.solo = false;
  }
  recomputeTrackGains();
});

exportBtn.addEventListener("click", async () => {
  if (!tracks.length) {
    setStatus("Belum ada stem untuk di-export.", true);
    return;
  }
  exportBtn.disabled = true;
  setStatus("Merender mix WAV...");
  try {
    const payload = {
      master_volume: masterMuted ? 0 : Number(masterFader.value),
      tracks: tracks.map((t) => ({
        name: t.name,
        volume: t.volume,
        pan: t.pan,
        muted: t.muted,
        solo: t.solo,
      })),
    };

    const resp = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.detail || "Gagal mengekspor mix");
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "custom_mix.wav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Export selesai: custom_mix.wav terunduh.");
  } catch (err) {
    setStatus(`Error export: ${err.message}`, true);
  } finally {
    exportBtn.disabled = false;
  }
});

modeSelect.addEventListener("change", syncModeUI);
syncModeUI();
updateMasterReadout();