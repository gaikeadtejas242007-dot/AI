(() => {
  "use strict";

  const HISTORY_KEY = "perch.detection-history.v1";
  const SETTINGS_KEY = "perch.settings.v1";
  const $ = (id) => document.getElementById(id);

  const ui = {
    start: $("start-button"),
    stop: $("stop-button"),
    camera: $("camera-feed"),
    canvas: $("detection-canvas"),
    stage: $("camera-stage"),
    placeholder: $("camera-placeholder"),
    cameraStatus: $("camera-status"),
    cameraStatusText: $("camera-status-text"),
    cameraError: $("camera-error"),
    feedLabel: $("feed-label"),
    modelPill: $("model-pill"),
    modelLabel: $("model-pill-label"),
    banner: $("detection-banner"),
    detectionStatus: $("detection-status"),
    detectionDetail: $("detection-detail"),
    count: $("live-bird-count"),
    confidence: $("live-confidence"),
    duration: $("live-duration"),
    liveTotal: $("live-total-detections"),
    audio: $("deterrent-audio"),
    file: $("audio-file"),
    fileName: $("audio-file-name"),
    audioStatus: $("audio-status"),
    play: $("audio-play"),
    stopAudio: $("audio-stop"),
    enableAudio: $("enable-audio"),
    playIcon: $("play-icon"),
    pauseIcon: $("pause-icon"),
    volume: $("volume-control"),
    volumeValue: $("volume-value"),
    auto: $("auto-toggle"),
    autoLabel: $("auto-label"),
    threshold: $("confidence-threshold"),
    thresholdValue: $("threshold-value"),
    persistence: $("persistence-setting"),
    persistenceValue: $("persistence-value"),
    interval: $("performance-setting"),
    historyRows: $("history-rows"),
    historyEmpty: $("history-empty"),
    historyTotal: $("history-total"),
    historyToday: $("history-today"),
    historyDuration: $("history-duration"),
    historyPeak: $("history-peak"),
    historyCount: $("history-entry-count"),
    historyNavCount: $("history-nav-count"),
    clearHistory: $("clear-history"),
    toast: $("toast"),
  };

  let model = null;
  let modelPromise = null;
  let cameraStream = null;
  let isRunning = false;
  let frameTimer = null;
  let statsTimer = null;
  let currentPredictions = [];
  let currentConfidence = 0;
  let lastSeenAt = 0;
  let session = null;
  let autoAudioPlaying = false;
  let audioUnlocked = false;
  let currentAudioName = "";
  let audioObjectUrl = "";
  let toastTimer = null;
  let history = loadHistory();

  const defaults = { threshold: 60, persistence: 1.5, interval: 450, volume: 65, auto: false };
  const settings = loadSettings();

  function loadHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value.filter((entry) => entry && entry.id && entry.startedAt) : [];
    } catch {
      return [];
    }
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return { ...defaults, ...(saved && typeof saved === "object" ? saved : {}) };
    } catch {
      return { ...defaults };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      showToast("Browser storage is unavailable; settings may not persist.");
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      showToast("Could not save history in this browser. Check available storage.");
    }
  }

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("visible"), 3500);
  }

  function setModelState(state, label) {
    ui.modelPill.classList.remove("loading", "ready", "error");
    if (state) ui.modelPill.classList.add(state);
    ui.modelLabel.textContent = label;
  }

  function ensureModel() {
    if (model) return Promise.resolve(model);
    if (modelPromise) return modelPromise;
    if (!window.tf || !window.cocoSsd) {
      return Promise.reject(new Error("The AI model libraries could not be loaded. Check your internet connection and reload."));
    }
    setModelState("loading", "Loading browser AI model…");
    ui.detectionStatus.textContent = "Loading bird detection model";
    ui.detectionDetail.textContent = "The model downloads once and runs locally in this browser.";
    modelPromise = (async () => {
      try {
        await window.tf.ready();
        const loadedModel = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
        model = loadedModel;
        setModelState("ready", "Bird model ready");
        return model;
      } catch (error) {
        modelPromise = null;
        setModelState("error", "Model failed to load");
        throw new Error(`Could not load the bird detection model: ${error.message || "model download failed"}`);
      }
    })();
    return modelPromise;
  }

  function setCameraState(active) {
    ui.cameraStatus.classList.toggle("active", active);
    ui.cameraStatusText.textContent = active ? "Camera on" : "Camera off";
    ui.placeholder.hidden = active;
    ui.feedLabel.classList.toggle("visible", active);
    ui.start.disabled = active;
    ui.stop.disabled = !active;
  }

  function updateDetectorState(detected, count = 0) {
    ui.banner.classList.toggle("detected", detected);
    if (detected) {
      ui.detectionStatus.textContent = count === 1 ? "Bird detected" : `${count} birds detected`;
      ui.detectionDetail.textContent = "AI detection is active · audio follows your auto deterrent setting";
      ui.count.textContent = String(count);
    } else if (isRunning) {
      ui.detectionStatus.textContent = "No bird detected";
      ui.detectionDetail.textContent = session ? "Watching for a return before ending this session." : "Scanning the live camera feed for birds.";
      ui.count.textContent = "0";
    } else {
      ui.detectionStatus.textContent = "Waiting to start";
      ui.detectionDetail.textContent = "Allow camera access to begin local AI detection.";
      ui.count.textContent = "—";
    }
  }

  function syncSettingsToUI() {
    settings.threshold = clamp(Number(settings.threshold) || defaults.threshold, 30, 90);
    settings.persistence = clamp(Number(settings.persistence) || defaults.persistence, 0.5, 4);
    settings.interval = [180, 450, 900].includes(Number(settings.interval)) ? Number(settings.interval) : defaults.interval;
    settings.volume = clamp(Number(settings.volume), 0, 100);
    settings.auto = Boolean(settings.auto);
    ui.threshold.value = settings.threshold;
    ui.thresholdValue.textContent = `${settings.threshold}%`;
    ui.persistence.value = settings.persistence;
    ui.persistenceValue.textContent = `${settings.persistence.toFixed(1)} sec`;
    ui.interval.value = String(settings.interval);
    ui.volume.value = settings.volume;
    ui.volumeValue.textContent = `${settings.volume}%`;
    ui.audio.volume = settings.volume / 100;
    ui.auto.checked = settings.auto;
    ui.autoLabel.textContent = settings.auto ? "On" : "Off";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatDuration(milliseconds, compact = false) {
    const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    if (compact && seconds >= 3600) {
      const hours = Math.floor(seconds / 3600);
      return `${hours}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
    }
    if (compact && seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function formatDateTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return { date: "Unknown date", time: "—" };
    return {
      date: date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
      time: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    };
  }

  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function refreshHistory() {
    const today = localDateKey();
    const totalMs = history.reduce((sum, event) => sum + (Number(event.durationMs) || 0), 0);
    const peak = history.reduce((max, event) => Math.max(max, Number(event.maxBirds) || 0), 0);
    ui.historyTotal.textContent = String(history.length);
    ui.historyToday.textContent = String(history.filter((event) => event.localDate === today || localDateKey(new Date(event.startedAt)) === today).length);
    ui.historyDuration.textContent = totalMs < 60000 && totalMs > 0 ? `${Math.max(1, Math.round(totalMs / 1000))} sec` : `${Math.round(totalMs / 60000)} min`;
    ui.historyPeak.textContent = String(peak);
    ui.historyCount.textContent = `${history.length} ${history.length === 1 ? "session" : "sessions"}`;
    ui.historyNavCount.textContent = String(history.length);
    ui.clearHistory.disabled = history.length === 0;
    ui.liveTotal.textContent = String(history.length + (session ? 1 : 0));
    ui.historyRows.replaceChildren();
    ui.historyEmpty.hidden = history.length > 0;

    for (const event of [...history].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 100)) {
      const row = document.createElement("tr");
      const when = document.createElement("td");
      const dateParts = formatDateTime(event.startedAt);
      when.className = "date-cell";
      const dateStrong = document.createElement("strong");
      dateStrong.textContent = dateParts.date;
      const timeSpan = document.createElement("span");
      timeSpan.textContent = dateParts.time;
      when.append(dateStrong, timeSpan);

      const birds = document.createElement("td");
      const birdChip = document.createElement("span");
      birdChip.className = "bird-count-cell";
      const birdIcon = document.createElement("span");
      birdIcon.className = "bird-mini-icon";
      birdIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 15c4.8-.1 8-2.2 10.2-7 1.8 3.7 5 5.5 9.2 5.8-2.7 5.2-7.6 7.6-13.7 6.7l-4.6 2.1 1.3-4A13 13 0 0 1 4 15Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
      const birdNum = document.createElement("span");
      birdNum.textContent = String(event.maxBirds || 1);
      birdChip.append(birdIcon, birdNum);
      birds.append(birdChip);

      const duration = document.createElement("td");
      duration.textContent = formatDuration(event.durationMs || 0, true);
      const confidence = document.createElement("td");
      confidence.className = "confidence-cell";
      confidence.textContent = `${Math.round(Number(event.maxConfidence || event.averageConfidence || 0) * 100)}%`;
      const audio = document.createElement("td");
      audio.className = "audio-cell";
      audio.title = event.audioUsed || "No audio";
      audio.textContent = event.audioUsed || "No audio";
      row.append(when, birds, duration, confidence, audio);
      ui.historyRows.append(row);
    }
  }

  function updateStatsClock() {
    if (session) {
      const end = lastSeenAt || Date.now();
      ui.duration.textContent = formatDuration(Math.max(0, end - session.startMs));
    } else {
      ui.duration.textContent = "00:00";
    }
  }

  function startSession(confidence, birdCount, timestamp) {
    session = {
      id: makeId(),
      startedAt: new Date(timestamp).toISOString(),
      startMs: timestamp,
      lastSeenAt: timestamp,
      maxBirds: birdCount,
      maxConfidence: confidence,
      confidenceTotal: confidence,
      confidenceSamples: 1,
      audioUsed: currentAudioName || "",
    };
    lastSeenAt = timestamp;
    refreshHistory();
  }

  function recordBirds(birds, timestamp) {
    const best = Math.max(...birds.map((prediction) => prediction.score));
    if (!session) startSession(best, birds.length, timestamp);
    session.lastSeenAt = timestamp;
    session.maxBirds = Math.max(session.maxBirds, birds.length);
    session.maxConfidence = Math.max(session.maxConfidence, best);
    session.confidenceTotal += birds.reduce((sum, prediction) => sum + prediction.score, 0) / birds.length;
    session.confidenceSamples += 1;
    lastSeenAt = timestamp;
    ui.confidence.textContent = `${Math.round(best * 100)}%`;
    updateStatsClock();
    refreshHistory();
    if (settings.auto) startAutoAudio();
  }

  function finishSession() {
    if (!session) return;
    const endedAtMs = Math.max(session.startMs, session.lastSeenAt);
    const event = {
      id: session.id,
      localDate: localDateKey(new Date(session.startMs)),
      startedAt: session.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - session.startMs),
      maxBirds: session.maxBirds,
      maxConfidence: session.maxConfidence,
      averageConfidence: session.confidenceTotal / Math.max(1, session.confidenceSamples),
      audioUsed: session.audioUsed || "",
    };
    history.unshift(event);
    history = history.slice(0, 500);
    session = null;
    lastSeenAt = 0;
    updateStatsClock();
    if (autoAudioPlaying) pauseAudio();
    saveHistory();
    refreshHistory();
    if (isRunning) updateDetectorState(false);
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `bird-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clearCanvas() {
    const context = ui.canvas.getContext("2d");
    context.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  }

  function drawBirds(birds) {
    if (!ui.camera.videoWidth || !ui.camera.videoHeight) return;
    if (ui.canvas.width !== ui.camera.videoWidth || ui.canvas.height !== ui.camera.videoHeight) {
      ui.canvas.width = ui.camera.videoWidth;
      ui.canvas.height = ui.camera.videoHeight;
      ui.stage.style.aspectRatio = `${ui.camera.videoWidth} / ${ui.camera.videoHeight}`;
    }
    const context = ui.canvas.getContext("2d");
    context.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    birds.forEach((bird, index) => {
      const [x, y, width, height] = bird.bbox;
      const color = "#51d27a";
      context.lineWidth = Math.max(2, ui.canvas.width / 540);
      context.strokeStyle = color;
      context.fillStyle = "rgba(18, 82, 43, 0.78)";
      context.strokeRect(x, y, width, height);
      const label = `Bird ${Math.round(bird.score * 100)}%`;
      context.font = `600 ${Math.max(13, ui.canvas.width / 48)}px "DM Sans", sans-serif`;
      const labelWidth = context.measureText(label).width + 16;
      const labelHeight = Math.max(25, ui.canvas.width / 28);
      const labelX = clamp(x, 0, ui.canvas.width - labelWidth);
      const labelY = Math.max(0, y - labelHeight);
      context.fillRect(labelX, labelY, labelWidth, labelHeight);
      context.fillStyle = "#fff";
      context.textBaseline = "middle";
      context.fillText(label, labelX + 8, labelY + labelHeight / 2);
      if (index === 0) currentConfidence = bird.score;
    });
  }

  async function detectFrame() {
    if (!isRunning || !model || ui.camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scheduleNextFrame();
      return;
    }
    try {
      const predictions = await model.detect(ui.camera);
      const birds = predictions.filter((prediction) => prediction.class === "bird" && prediction.score >= settings.threshold / 100);
      currentPredictions = birds;
      drawBirds(birds);
      if (birds.length) {
        recordBirds(birds, Date.now());
        updateDetectorState(true, birds.length);
      } else {
        ui.confidence.textContent = "—";
        updateDetectorState(false);
        if (session && Date.now() - lastSeenAt >= settings.persistence * 1000) finishSession();
      }
    } catch (error) {
      console.error("Bird detection frame failed:", error);
      stopDetection();
      setModelState("error", "Detection stopped");
      showCameraError("The model could not process the camera frame. Stop and start detection again; if this continues, reload the app.");
      return;
    }
    scheduleNextFrame();
  }

  function scheduleNextFrame() {
    if (!isRunning) return;
    frameTimer = setTimeout(detectFrame, settings.interval);
  }

  function getCameraErrorMessage(error) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return "This browser cannot open a camera here. Use a current browser over HTTPS, or run this app on localhost.";
    }
    if (error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
      return "Camera access was blocked. Allow camera permission in your browser's site settings, then try again. Perch uses the camera only for live local detection.";
    }
    if (error && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) {
      return "No camera was found. Connect a camera or open Perch on a device with a camera.";
    }
    if (error && (error.name === "NotReadableError" || error.name === "TrackStartError")) {
      return "The camera is busy or unavailable. Close other apps using it, then try again.";
    }
    if (error && error.name === "OverconstrainedError") {
      return "The camera did not support the requested settings. Check that it is available, then try again.";
    }
    return `Could not start the camera: ${error && error.message ? error.message : "unknown camera error"}. Check camera permissions and try again.`;
  }

  function showCameraError(message) {
    ui.cameraError.textContent = message;
    ui.cameraError.hidden = false;
  }

  async function startDetection() {
    if (isRunning) return;
    ui.cameraError.hidden = true;
    ui.start.disabled = true;
    ui.start.querySelector("span").textContent = "Starting…";
    setModelState("loading", "Starting camera & AI…");
    ui.detectionStatus.textContent = "Starting detection";
    ui.detectionDetail.textContent = "Allow camera access; frames stay on this device.";

    // Invoke the audio unlock within the user's click gesture, before awaiting camera/model startup.
    if (ui.audio.src) void primeAudio(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      cameraStream = stream;
      ui.camera.srcObject = stream;
      await ui.camera.play();
      setCameraState(true);
      const loadedModel = await ensureModel();
      if (!loadedModel) throw new Error("Bird model was not available.");
      isRunning = true;
      ui.start.querySelector("span").textContent = "Detection active";
      ui.detectionStatus.textContent = "Scanning for birds";
      ui.detectionDetail.textContent = "Camera frames are analyzed locally in your browser.";
      setModelState("ready", "Bird model ready");
      clearCanvas();
      scheduleNextFrame();
      statsTimer = setInterval(updateStatsClock, 1000);
    } catch (error) {
      console.error("Could not start bird detection:", error);
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
        cameraStream = null;
      }
      ui.camera.srcObject = null;
      setCameraState(false);
      ui.start.querySelector("span").textContent = "Start detection";
      ui.start.disabled = false;
      if (String(error && error.message).includes("AI model") || String(error && error.message).includes("bird detection model")) {
        showCameraError(error.message);
        setModelState("error", "Model failed to load");
      } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showCameraError(getCameraErrorMessage(error));
        setModelState("error", "Camera unavailable");
      } else if (error && (error.name === "NotAllowedError" || error.name === "NotFoundError" || error.name === "NotReadableError" || error.name === "OverconstrainedError" || error.name === "DevicesNotFoundError")) {
        showCameraError(getCameraErrorMessage(error));
        setModelState("", "AI model loads on start");
      } else {
        showCameraError(error && error.message ? error.message : getCameraErrorMessage(error));
        setModelState("error", "Could not start");
      }
      updateDetectorState(false);
    }
  }

  function stopDetection() {
    isRunning = false;
    clearTimeout(frameTimer);
    clearInterval(statsTimer);
    frameTimer = null;
    statsTimer = null;
    if (session) finishSession();
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    ui.camera.srcObject = null;
    ui.camera.pause();
    clearCanvas();
    ui.canvas.width = 0;
    ui.canvas.height = 0;
    ui.stage.style.aspectRatio = "";
    setCameraState(false);
    ui.start.querySelector("span").textContent = "Start detection";
    ui.start.disabled = false;
    ui.confidence.textContent = "—";
    currentPredictions = [];
    updateDetectorState(false);
    if (!model) setModelState("", "AI model loads on start");
  }

  async function primeAudio(silent = false) {
    if (!ui.audio.src) {
      if (!silent) showToast("Choose an audio file first.");
      return false;
    }
    try {
      const previousMuted = ui.audio.muted;
      ui.audio.muted = true;
      ui.audio.currentTime = 0;
      await ui.audio.play();
      ui.audio.pause();
      ui.audio.currentTime = 0;
      ui.audio.muted = previousMuted;
      audioUnlocked = true;
      ui.audioStatus.textContent = "Ready for playback";
      ui.enableAudio.textContent = "Audio enabled for automatic playback";
      return true;
    } catch (error) {
      ui.audio.muted = false;
      audioUnlocked = false;
      ui.audioStatus.textContent = "Tap to enable audio";
      if (!silent) showToast("Your browser blocked audio. Tap enable audio, then try again.");
      return false;
    }
  }

  async function startAutoAudio() {
    if (!settings.auto || !ui.audio.src || autoAudioPlaying) return;
    try {
      ui.audio.loop = true;
      await ui.audio.play();
      autoAudioPlaying = true;
      ui.audioStatus.textContent = "Auto deterrent playing";
      ui.audioStatus.classList.add("playing");
      ui.playIcon.hidden = true;
      ui.pauseIcon.hidden = false;
    } catch (error) {
      console.warn("Automatic audio was blocked by the browser:", error);
      autoAudioPlaying = false;
      ui.audioStatus.textContent = "Tap to enable audio";
      ui.audioStatus.classList.remove("playing");
      ui.enableAudio.focus({ preventScroll: true });
      showToast("Browser blocked automatic sound. Tap “Enable audio” once, then it will play on detection.");
    }
  }

  function pauseAudio() {
    ui.audio.pause();
    autoAudioPlaying = false;
    ui.audioStatus.classList.remove("playing");
    ui.playIcon.hidden = false;
    ui.pauseIcon.hidden = true;
    if (ui.audio.src) ui.audioStatus.textContent = audioUnlocked ? "Ready for playback" : "Audio selected";
  }

  function stopAudio() {
    ui.audio.pause();
    ui.audio.currentTime = 0;
    autoAudioPlaying = false;
    ui.audioStatus.classList.remove("playing");
    ui.playIcon.hidden = false;
    ui.pauseIcon.hidden = true;
    if (ui.audio.src) ui.audioStatus.textContent = audioUnlocked ? "Ready for playback" : "Audio selected";
  }

  function setPage(name) {
    document.querySelectorAll(".page").forEach((page) => {
      const active = page.id === `page-${name}`;
      page.classList.toggle("active", active);
      page.hidden = !active;
    });
    document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  document.querySelectorAll("[data-page-link]").forEach((link) => link.addEventListener("click", () => setPage(link.dataset.pageLink)));

  ui.start.addEventListener("click", startDetection);
  ui.stop.addEventListener("click", stopDetection);

  ui.file.addEventListener("change", async () => {
    const file = ui.file.files && ui.file.files[0];
    if (!file) return;
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = URL.createObjectURL(file);
    ui.audio.src = audioObjectUrl;
    currentAudioName = file.name;
    ui.fileName.textContent = file.name;
    ui.fileName.title = file.name;
    ui.audioStatus.textContent = "Preparing audio…";
    ui.audioStatus.classList.remove("playing");
    ui.play.disabled = false;
    ui.stopAudio.disabled = false;
    ui.enableAudio.disabled = false;
    ui.playIcon.hidden = false;
    ui.pauseIcon.hidden = true;
    if (session && !session.audioUsed) session.audioUsed = file.name;
    await primeAudio(true);
    if (!audioUnlocked) ui.audioStatus.textContent = "Audio selected · tap enable";
  });

  ui.play.addEventListener("click", async () => {
    if (!ui.audio.src) return;
    if (!ui.audio.paused) {
      pauseAudio();
      ui.audioStatus.textContent = "Paused";
      return;
    }
    try {
      ui.audio.loop = false;
      await ui.audio.play();
      autoAudioPlaying = false;
      ui.audioStatus.textContent = "Playing preview";
      ui.audioStatus.classList.add("playing");
      ui.playIcon.hidden = true;
      ui.pauseIcon.hidden = false;
    } catch {
      showToast("Could not play this file. Try a different browser-supported audio file.");
    }
  });

  ui.audio.addEventListener("ended", () => {
    if (!autoAudioPlaying) {
      ui.audioStatus.classList.remove("playing");
      ui.playIcon.hidden = false;
      ui.pauseIcon.hidden = true;
      ui.audioStatus.textContent = audioUnlocked ? "Ready for playback" : "Audio selected";
    }
  });
  ui.audio.addEventListener("error", () => {
    if (ui.audio.src) {
      ui.audioStatus.textContent = "Unsupported audio format";
      showToast("This browser could not read the audio file. Choose a different audio format.");
    }
  });
  ui.stopAudio.addEventListener("click", stopAudio);
  ui.enableAudio.addEventListener("click", () => void primeAudio());
  ui.volume.addEventListener("input", () => {
    settings.volume = Number(ui.volume.value);
    ui.volumeValue.textContent = `${settings.volume}%`;
    ui.audio.volume = settings.volume / 100;
    saveSettings();
  });

  ui.auto.addEventListener("change", () => {
    settings.auto = ui.auto.checked;
    ui.autoLabel.textContent = settings.auto ? "On" : "Off";
    saveSettings();
    if (!settings.auto && autoAudioPlaying) pauseAudio();
    if (settings.auto && session) startAutoAudio();
    if (settings.auto && !ui.audio.src) showToast("Choose your audio first to enable the automatic deterrent.");
  });

  ui.threshold.addEventListener("input", () => {
    settings.threshold = Number(ui.threshold.value);
    ui.thresholdValue.textContent = `${settings.threshold}%`;
    saveSettings();
    if (isRunning) {
      const filtered = currentPredictions.filter((prediction) => prediction.score >= settings.threshold / 100);
      drawBirds(filtered);
    }
  });
  ui.persistence.addEventListener("input", () => {
    settings.persistence = Number(ui.persistence.value);
    ui.persistenceValue.textContent = `${settings.persistence.toFixed(1)} sec`;
    saveSettings();
  });
  ui.interval.addEventListener("change", () => {
    settings.interval = Number(ui.interval.value);
    saveSettings();
  });

  ui.clearHistory.addEventListener("click", () => {
    if (!history.length) return;
    const confirmed = window.confirm("Clear all saved detection history on this device? This cannot be undone.");
    if (!confirmed) return;
    history = [];
    saveHistory();
    refreshHistory();
    showToast("Detection history cleared from this device.");
  });

  window.addEventListener("beforeunload", () => {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
  });

  syncSettingsToUI();
  refreshHistory();
  setCameraState(false);
})();