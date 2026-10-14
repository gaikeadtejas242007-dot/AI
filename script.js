(() => {
  "use strict";

  const HISTORY_KEY = "perch.detection-history.v1";
  const SETTINGS_KEY = "perch.settings.v1";
  const $ = (id) => document.getElementById(id);

  const ui = {
    start: $("start-button"),
    stop: $("stop-button"),
    screenRecord: $("screen-record-button"),
    screenStop: $("screen-stop-button"),
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
    positionPanel: $("position-panel"),
    positionDot: $("position-dot"),
    positionX: $("position-x"),
    positionY: $("position-y"),
    signInButton: $("sign-in-button"),
    createAccountButton: $("create-account-button"),
    userMenu: $("user-menu"),
    userName: $("user-name"),
    signOutButton: $("sign-out-button"),
    authModal: $("auth-modal"),
    authTabSignin: $("auth-tab-signin"),
    authTabCreate: $("auth-tab-create"),
    signInForm: $("sign-in-form"),
    createAccountForm: $("create-account-form"),
    closeAuthModal: $("close-auth-modal"),
    historyVideoModal: $("history-video-modal"),
    historyVideo: $("history-video"),
    closeHistoryVideo: $("close-history-video"),
    historyPhotoModal: $("history-photo-modal"),
    historyPhoto: $("history-photo"),
    closeHistoryPhoto: $("close-history-photo"),
  };

  const AUTH_ACCOUNTS_KEY = "perch.auth.accounts.v1";
  const AUTH_SESSION_KEY = "perch.auth.session.v1";
  const CLIPS_DB_NAME = "perch.detection-clips.v1";
  const CLIPS_STORE_NAME = "clips";
  const PHOTOS_STORE_NAME = "photos";
  const USER_FRAME_WIDTH_CM = 120;
  const USER_FRAME_HEIGHT_CM = 80;

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
  let historyVideoUrl = "";
  let historyPhotoUrl = "";
  let clipsDatabasePromise = null;
  let activeClipRecorder = null;
  let activeClipChunks = [];
  let activeClipSessionId = "";
  let activeClipTimeout = null;
  let clipSupportNoticeShown = false;
  let screenRecorder = null;
  let screenRecordingStream = null;
  let screenRecordingChunks = [];
  let screenRecordingTimeout = null;
  let toastTimer = null;
  let previousMotionFrame = null;
  let lastDetectionAt = 0;
  let history = loadHistory();

  const defaults = { threshold: 35, persistence: 1.5, interval: 450, volume: 65, auto: false };
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

  function openClipsDatabase() {
    if (!window.indexedDB) return Promise.reject(new Error("Local video storage is unavailable."));
    if (!clipsDatabasePromise) {
      clipsDatabasePromise = new Promise((resolve, reject) => {
        const request = window.indexedDB.open(CLIPS_DB_NAME, 2);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(CLIPS_STORE_NAME)) {
            request.result.createObjectStore(CLIPS_STORE_NAME, { keyPath: "id" });
          }
          if (!request.result.objectStoreNames.contains(PHOTOS_STORE_NAME)) {
            request.result.createObjectStore(PHOTOS_STORE_NAME, { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open local video storage."));
      });
    }
    return clipsDatabasePromise;
  }

  async function saveDetectionClip(id, blob) {
    try {
      const database = await openClipsDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(CLIPS_STORE_NAME, "readwrite");
        transaction.objectStore(CLIPS_STORE_NAME).put({ id, blob, type: blob.type });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not save the detection clip."));
        transaction.onabort = () => reject(transaction.error || new Error("Clip storage was interrupted."));
      });
      const event = history.find((entry) => entry.id === id);
      if (event) {
        event.videoAvailable = true;
        saveHistory();
        refreshHistory();
      }
    } catch (error) {
      console.error("Could not save bird detection clip:", error);
      showToast("Could not save this clip in browser storage.");
    }
  }

  async function getDetectionClip(id) {
    const database = await openClipsDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(CLIPS_STORE_NAME, "readonly").objectStore(CLIPS_STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result ? request.result.blob : null);
      request.onerror = () => reject(request.error || new Error("Could not load the detection clip."));
    });
  }

  async function saveDetectionPhoto(id, blob) {
    try {
      const database = await openClipsDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(PHOTOS_STORE_NAME, "readwrite");
        transaction.objectStore(PHOTOS_STORE_NAME).put({ id, blob, type: blob.type });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not save the bird photo."));
        transaction.onabort = () => reject(transaction.error || new Error("Photo storage was interrupted."));
      });
      const event = history.find((entry) => entry.id === id);
      if (event) {
        event.photoAvailable = true;
        saveHistory();
      }
      if (session && session.id === id) session.photoAvailable = true;
      refreshHistory();
    } catch (error) {
      console.error("Could not save bird detection photo:", error);
      showToast("Could not save the bird photo in browser storage.");
    }
  }

  async function getDetectionPhoto(id) {
    const database = await openClipsDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(PHOTOS_STORE_NAME, "readonly").objectStore(PHOTOS_STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result ? request.result.blob : null);
      request.onerror = () => reject(request.error || new Error("Could not load the bird photo."));
    });
  }

  async function showDetectionPhoto(id) {
    try {
      const photo = await getDetectionPhoto(id);
      if (!photo) {
        showToast("No saved photo is available for this detection.");
        return;
      }
      if (historyPhotoUrl) URL.revokeObjectURL(historyPhotoUrl);
      historyPhotoUrl = URL.createObjectURL(photo);
      ui.historyPhoto.src = historyPhotoUrl;
      ui.historyPhotoModal.hidden = false;
    } catch (error) {
      console.error("Could not open bird detection photo:", error);
      showToast("Could not open this bird photo.");
    }
  }

  function closeDetectionPhoto() {
    ui.historyPhoto.removeAttribute("src");
    ui.historyPhotoModal.hidden = true;
    if (historyPhotoUrl) URL.revokeObjectURL(historyPhotoUrl);
    historyPhotoUrl = "";
  }

  function captureBirdPhoto(bird) {
    if (!bird || !ui.camera.videoWidth || !ui.camera.videoHeight) return Promise.resolve(null);
    const [birdX, birdY, birdWidth, birdHeight] = bird.bbox;
    const paddingX = birdWidth * 0.2;
    const paddingY = birdHeight * 0.2;
    const sourceX = Math.max(0, birdX - paddingX);
    const sourceY = Math.max(0, birdY - paddingY);
    const sourceRight = Math.min(ui.camera.videoWidth, birdX + birdWidth + paddingX);
    const sourceBottom = Math.min(ui.camera.videoHeight, birdY + birdHeight + paddingY);
    const sourceWidth = sourceRight - sourceX;
    const sourceHeight = sourceBottom - sourceY;
    if (sourceWidth <= 0 || sourceHeight <= 0) return Promise.resolve(null);

    const maxDimension = 1200;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    context.drawImage(ui.camera, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  }

  async function clearDetectionClips() {
    const database = await openClipsDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([CLIPS_STORE_NAME, PHOTOS_STORE_NAME], "readwrite");
      transaction.objectStore(CLIPS_STORE_NAME).clear();
      transaction.objectStore(PHOTOS_STORE_NAME).clear();
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not clear saved clips."));
      transaction.onabort = () => reject(transaction.error || new Error("Clip cleanup was interrupted."));
    });
  }

  function getSupportedVideoMimeType() {
    const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
    return typeof MediaRecorder.isTypeSupported === "function"
      ? types.find((type) => MediaRecorder.isTypeSupported(type)) || ""
      : "";
  }

  function startClipRecording(sessionId) {
    if (!cameraStream || activeClipRecorder) return;
    if (!window.MediaRecorder) {
      if (!clipSupportNoticeShown) showToast("This browser does not support video clips; bird detection will continue.");
      clipSupportNoticeShown = true;
      return;
    }
    try {
      const mimeType = getSupportedVideoMimeType();
      const recorder = new MediaRecorder(cameraStream, mimeType ? { mimeType } : undefined);
      activeClipRecorder = recorder;
      activeClipChunks = [];
      activeClipSessionId = sessionId;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size) activeClipChunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const clipBlob = new Blob(activeClipChunks, { type: recorder.mimeType || "video/webm" });
        const clipId = activeClipSessionId;
        activeClipRecorder = null;
        activeClipChunks = [];
        activeClipSessionId = "";
        clearTimeout(activeClipTimeout);
        activeClipTimeout = null;
        if (clipBlob.size) void saveDetectionClip(clipId, clipBlob);
      }, { once: true });
      recorder.start(1000);
      activeClipTimeout = setTimeout(() => stopClipRecording(sessionId), 119000);
    } catch (error) {
      console.error("Could not record bird detection clip:", error);
      showToast("This browser could not record a detection clip.");
    }
  }

  function stopClipRecording(sessionId) {
    if (!activeClipRecorder || activeClipSessionId !== sessionId) return;
    clearTimeout(activeClipTimeout);
    activeClipTimeout = null;
    if (activeClipRecorder.state !== "inactive") activeClipRecorder.stop();
  }

  async function startScreenRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || !window.MediaRecorder) {
      showToast("This browser does not support screen recording.");
      return;
    }
    try {
      screenRecordingStream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false });
      const mimeType = getSupportedVideoMimeType();
      screenRecorder = new MediaRecorder(screenRecordingStream, mimeType ? { mimeType } : undefined);
      screenRecordingChunks = [];
      screenRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size) screenRecordingChunks.push(event.data);
      });
      screenRecorder.addEventListener("stop", () => {
        const recording = new Blob(screenRecordingChunks, { type: screenRecorder.mimeType || "video/webm" });
        const extension = recording.type.includes("mp4") ? "mp4" : "webm";
        screenRecordingStream.getTracks().forEach((track) => track.stop());
        screenRecordingStream = null;
        screenRecorder = null;
        screenRecordingChunks = [];
        clearTimeout(screenRecordingTimeout);
        screenRecordingTimeout = null;
        ui.screenRecord.hidden = false;
        ui.screenStop.hidden = true;
        if (!recording.size) {
          showToast("The screen recording was empty. Try recording again.");
          return;
        }
        const url = URL.createObjectURL(recording);
        const download = document.createElement("a");
        download.href = url;
        download.download = `perch-detection-demo-${Date.now()}.${extension}`;
        download.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast("Screen video downloaded to your device.");
      }, { once: true });
      screenRecordingStream.getVideoTracks()[0].addEventListener("ended", stopScreenRecording, { once: true });
      screenRecorder.start(1000);
      ui.screenRecord.hidden = true;
      ui.screenStop.hidden = false;
      screenRecordingTimeout = setTimeout(stopScreenRecording, 119000);
      showToast("Screen recording started. Show bird detection on screen, then stop recording.");
    } catch (error) {
      if (screenRecordingStream) screenRecordingStream.getTracks().forEach((track) => track.stop());
      screenRecordingStream = null;
      screenRecorder = null;
      if (error && error.name === "NotAllowedError") {
        showToast("Screen recording was canceled. Choose this browser tab to record the app.");
      } else if (error && error.name === "NotSupportedError") {
        showToast("This browser cannot capture the screen. Open Perch in Edge or Chrome, or use Windows Snipping Tool.");
      } else {
        console.error("Could not start screen recording:", error);
        showToast("Could not start screen recording in this browser.");
      }
    }
  }

  function stopScreenRecording() {
    if (!screenRecorder || screenRecorder.state === "inactive") return;
    clearTimeout(screenRecordingTimeout);
    screenRecordingTimeout = null;
    screenRecorder.stop();
  }

  async function playDetectionClip(id) {
    try {
      const clip = await getDetectionClip(id);
      if (!clip) {
        showToast("No saved video clip is available for this detection.");
        return;
      }
      if (historyVideoUrl) URL.revokeObjectURL(historyVideoUrl);
      historyVideoUrl = URL.createObjectURL(clip);
      ui.historyVideo.src = historyVideoUrl;
      ui.historyVideoModal.hidden = false;
      ui.historyVideo.play().catch(() => showToast("Press play on the video to start playback."));
    } catch (error) {
      console.error("Could not play bird detection clip:", error);
      showToast("Could not open this video clip.");
    }
  }

  function closeDetectionClip() {
    ui.historyVideo.pause();
    ui.historyVideo.removeAttribute("src");
    ui.historyVideo.load();
    ui.historyVideoModal.hidden = true;
    if (historyVideoUrl) URL.revokeObjectURL(historyVideoUrl);
    historyVideoUrl = "";
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

  function loadAccounts() {
    try {
      const accounts = JSON.parse(localStorage.getItem(AUTH_ACCOUNTS_KEY) || "[]");
      return Array.isArray(accounts) ? accounts : [];
    } catch {
      return [];
    }
  }

  function saveAccounts(accounts) {
    localStorage.setItem(AUTH_ACCOUNTS_KEY, JSON.stringify(accounts));
  }

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveSession(user) {
    if (!user) {
      localStorage.removeItem(AUTH_SESSION_KEY);
      return;
    }
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(user));
  }

  function setAuthTab(tabName) {
    const isSignIn = tabName === "signin";
    ui.authTabSignin.classList.toggle("active", isSignIn);
    ui.authTabCreate.classList.toggle("active", !isSignIn);
    ui.signInForm.classList.toggle("active", isSignIn);
    ui.createAccountForm.classList.toggle("active", !isSignIn);
  }

  function openAuthModal(tabName = "signin") {
    setAuthTab(tabName);
    ui.authModal.hidden = false;
  }

  function closeAuthModal() {
    ui.authModal.hidden = true;
  }

  function updateAuthUI() {
    const session = loadSession();
    if (session && session.email) {
      ui.signInButton.hidden = true;
      ui.createAccountButton.hidden = true;
      ui.userMenu.hidden = false;
      ui.userName.textContent = session.fullName || session.email.split("@")[0];
    } else {
      ui.signInButton.hidden = false;
      ui.createAccountButton.hidden = false;
      ui.userMenu.hidden = true;
    }
  }

  function ensureValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  function handleCreateAccount(event) {
    event.preventDefault();
    const accounts = loadAccounts();
    const form = event.currentTarget;
    const fullName = form.querySelector("#signup-name").value.trim();
    const email = form.querySelector("#signup-email").value.trim();
    const phone = form.querySelector("#signup-phone").value.trim();
    const password = form.querySelector("#signup-password").value;
    const confirmPassword = form.querySelector("#signup-confirm-password").value;

    if (!fullName || !email || !password || !confirmPassword) {
      showToast("Please fill in all required fields.");
      return;
    }
    if (!ensureValidEmail(email)) {
      showToast("Enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      showToast("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      showToast("Passwords do not match.");
      return;
    }
    const exists = accounts.some((account) => account.email.toLowerCase() === email.toLowerCase());
    if (exists) {
      showToast("An account with this email already exists.");
      return;
    }

    const newUser = {
      id: makeId(),
      fullName,
      email: email.toLowerCase(),
      phone: phone || "",
      password,
      createdAt: new Date().toISOString(),
    };
    accounts.push(newUser);
    saveAccounts(accounts);
    saveSession({ id: newUser.id, email: newUser.email, fullName: newUser.fullName });
    updateAuthUI();
    form.reset();
    closeAuthModal();
    showToast("Account created successfully.");
  }

  function handleSignIn(event) {
    event.preventDefault();
    const accounts = loadAccounts();
    const form = event.currentTarget;
    const email = form.querySelector("#signin-email").value.trim().toLowerCase();
    const password = form.querySelector("#signin-password").value;

    if (!email || !password) {
      showToast("Email and password are required.");
      return;
    }
    if (!ensureValidEmail(email)) {
      showToast("Enter a valid email address.");
      return;
    }

    const account = accounts.find((item) => item.email.toLowerCase() === email && item.password === password);
    if (!account) {
      showToast("No account matches that email and password.");
      return;
    }

    saveSession({ id: account.id, email: account.email, fullName: account.fullName });
    updateAuthUI();
    form.reset();
    closeAuthModal();
    showToast(`Welcome back, ${account.fullName}.`);
  }

  function handleSignOut() {
    saveSession(null);
    updateAuthUI();
    showToast("Signed out successfully.");
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
      const video = document.createElement("td");
      const playClip = document.createElement("button");
      playClip.className = "clip-button";
      playClip.type = "button";
      playClip.textContent = event.videoAvailable ? "Play clip" : "No clip";
      playClip.disabled = !event.videoAvailable;
      playClip.dataset.clipId = event.id;
      video.append(playClip);
      const photo = document.createElement("td");
      const viewPhoto = document.createElement("button");
      viewPhoto.className = "clip-button";
      viewPhoto.type = "button";
      viewPhoto.textContent = event.photoAvailable ? "View photo" : "No photo";
      viewPhoto.disabled = !event.photoAvailable;
      viewPhoto.dataset.photoId = event.id;
      photo.append(viewPhoto);
      row.append(when, birds, duration, confidence, audio, video, photo);
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

  function startSession(confidence, birdCount, timestamp, primaryBird) {
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
      photoConfidence: confidence,
      photoCaptureVersion: 0,
      photoAvailable: false,
    };
    lastSeenAt = timestamp;
    startClipRecording(session.id);
    saveBirdSnapshot(session, primaryBird);
    refreshHistory();
  }

  function saveBirdSnapshot(sessionData, bird) {
    const captureVersion = ++sessionData.photoCaptureVersion;
    captureBirdPhoto(bird).then((photo) => {
      if (photo && sessionData.photoCaptureVersion === captureVersion) {
        void saveDetectionPhoto(sessionData.id, photo);
      }
    });
  }

  function recordBirds(birds, timestamp) {
    const best = Math.max(...birds.map((prediction) => prediction.score));
    if (!session) startSession(best, birds.length, timestamp, birds.reduce((top, bird) => bird.score > top.score ? bird : top));
    if (best > session.photoConfidence) {
      session.photoConfidence = best;
      const bestBird = birds.reduce((top, bird) => bird.score > top.score ? bird : top);
      saveBirdSnapshot(session, bestBird);
    }
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
    stopClipRecording(session.id);
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
      videoAvailable: false,
      photoAvailable: session.photoAvailable,
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

  function analyzeMotion(frameVideo) {
    const width = 160;
    const height = 90;
    const tmpCanvas = document.createElement("canvas");
    const tmpContext = tmpCanvas.getContext("2d", { willReadFrequently: true });
    tmpCanvas.width = width;
    tmpCanvas.height = height;
    tmpContext.drawImage(frameVideo, 0, 0, width, height);
    const frameData = tmpContext.getImageData(0, 0, width, height).data;

    if (!previousMotionFrame) {
      previousMotionFrame = frameData.slice();
      return 0;
    }

    let changedPixels = 0;
    const previousFrame = previousMotionFrame;

    for (let i = 0; i < frameData.length; i += 4) {
      const red = frameData[i];
      const green = frameData[i + 1];
      const blue = frameData[i + 2];
      const previousRed = previousFrame[i];
      const previousGreen = previousFrame[i + 1];
      const previousBlue = previousFrame[i + 2];
      const lum = (red + green + blue) / 3;
      const previousLum = (previousRed + previousGreen + previousBlue) / 3;
      const delta = Math.abs(lum - previousLum);
      if (delta > 22) changedPixels += 1;
    }

    previousMotionFrame = frameData.slice();
    const motionPercent = (changedPixels / (width * height)) * 100;
    return motionPercent;
  }

  function getDetectionState(predictions) {
    const birdPredictions = predictions.filter((prediction) => prediction.class && prediction.class.toLowerCase() === "bird" && (prediction.score || 0) >= settings.threshold / 100);
    const birdCount = birdPredictions.length;
    const topBirdScore = birdPredictions.reduce((max, prediction) => Math.max(max, prediction.score || 0), 0);

    return {
      hasBird: birdCount > 0,
      birdCount,
      topBirdScore,
    };
  }

  function resetBirdPosition() {
    ui.positionPanel.classList.remove("active");
    ui.positionDot.style.left = "50%";
    ui.positionDot.style.top = "50%";
    ui.positionX.textContent = "0.0 cm";
    ui.positionY.textContent = "0.0 cm";
    const existingDots = ui.positionPanel.querySelectorAll(".position-dot-multi");
    existingDots.forEach((dot) => dot.remove());
  }

  function updateBirdPosition(birds) {
    const existingDots = ui.positionPanel.querySelectorAll(".position-dot-multi");
    existingDots.forEach((dot) => dot.remove());

    if (!birds || !birds.length) {
      resetBirdPosition();
      return;
    }

    const videoWidth = ui.camera.videoWidth || 1280;
    const videoHeight = ui.camera.videoHeight || 720;
    const primaryBird = birds[0];

    birds.forEach((bird, index) => {
      const [x, y, width, height] = bird.bbox;
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const xPercent = (centerX / videoWidth) * 100;
      const yPercent = (centerY / videoHeight) * 100;
      const xCm = ((centerX / videoWidth) * USER_FRAME_WIDTH_CM).toFixed(1);
      const yCm = ((centerY / videoHeight) * USER_FRAME_HEIGHT_CM).toFixed(1);

      const dot = document.createElement("div");
      dot.className = "position-dot-multi";
      dot.style.left = `${clamp(xPercent, 0, 100)}%`;
      dot.style.top = `${clamp(yPercent, 0, 100)}%`;
      dot.title = `Bird ${index + 1}: ${xCm} cm, ${yCm} cm`;
      ui.positionPanel.appendChild(dot);

      if (index === 0) {
        ui.positionDot.style.left = `${clamp(xPercent, 0, 100)}%`;
        ui.positionDot.style.top = `${clamp(yPercent, 0, 100)}%`;
        ui.positionX.textContent = `${xCm} cm`;
        ui.positionY.textContent = `${yCm} cm`;
      }
    });

    ui.positionPanel.classList.add("active");
    if (primaryBird && primaryBird.bbox) {
      const [x, y, width, height] = primaryBird.bbox;
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const xPercent = (centerX / videoWidth) * 100;
      const yPercent = (centerY / videoHeight) * 100;
      ui.positionDot.style.left = `${clamp(xPercent, 0, 100)}%`;
      ui.positionDot.style.top = `${clamp(yPercent, 0, 100)}%`;
    }
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

    if (!birds.length) {
      resetBirdPosition();
      return;
    }

    birds.forEach((bird, index) => {
      const [x, y, width, height] = bird.bbox;
      const score = Math.max(0, Math.min(1, Number(bird.score) || 0));
      const scorePercent = Math.round(score * 100);
      const ringWidth = Math.max(4, ui.canvas.width / 220);
      const ringColor = "#7ef0a5";
      const glowColor = "rgba(126, 240, 165, 0.35)";

      context.save();
      context.lineWidth = ringWidth;
      context.strokeStyle = ringColor;
      context.fillStyle = glowColor;
      context.setLineDash([12, 10]);
      context.shadowColor = "rgba(67, 255, 135, 0.95)";
      context.shadowBlur = 26;
      context.strokeRect(x, y, width, height);
      context.fillRect(x, y, width, height);
      context.restore();

      const label = `Bird ${scorePercent}%`;
      context.font = `700 ${Math.max(13, ui.canvas.width / 48)}px "DM Sans", sans-serif`;
      const labelPaddingX = 12;
      const labelPaddingY = 8;
      const labelWidth = context.measureText(label).width + labelPaddingX * 2;
      const labelHeight = Math.max(24, ui.canvas.width / 28);
      const labelX = clamp(x, 0, ui.canvas.width - labelWidth);
      const labelY = Math.max(0, y - labelHeight - 10);

      context.fillStyle = "rgba(15, 33, 18, 0.8)";
      context.fillRect(labelX, labelY, labelWidth, labelHeight);
      context.strokeStyle = "rgba(126, 240, 165, 0.9)";
      context.lineWidth = 1.5;
      context.strokeRect(labelX, labelY, labelWidth, labelHeight);
      context.fillStyle = "#eafff0";
      context.textBaseline = "middle";
      context.fillText(label, labelX + labelPaddingX, labelY + labelHeight / 2 + 1);

      if (index === 0) {
        currentConfidence = bird.score;
      }
    });

    updateBirdPosition(birds);
  }

  async function detectFrame() {
    if (!isRunning || !model || ui.camera.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scheduleNextFrame();
      return;
    }
    try {
      const predictions = await model.detect(ui.camera);
      const birds = predictions.filter((prediction) => prediction.class && prediction.class.toLowerCase() === "bird" && (prediction.score || 0) >= settings.threshold / 100 );
      const detectionState = getDetectionState(predictions);

      currentPredictions = birds;
      drawBirds(birds);

      if (detectionState.hasBird) {
        const detectionTime = Date.now();
        const eventCount = detectionState.birdCount;
        const confidence = detectionState.topBirdScore || 0;
        lastDetectionAt = detectionTime;
        recordBirds(birds, detectionTime);
        ui.confidence.textContent = `${Math.round(confidence * 100)}%`;
        updateDetectorState(true, eventCount);
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

  function scheduleNextFrame(delay = settings.interval) {
    if (!isRunning) return;
    frameTimer = setTimeout(detectFrame, delay);
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
    if (!loadSession()) {
      openAuthModal("signin");
      showToast("Please sign in or create an account before starting detection.");
      return;
    }
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

  ui.signInButton.addEventListener("click", () => openAuthModal("signin"));
  ui.createAccountButton.addEventListener("click", () => openAuthModal("create"));
  ui.signOutButton.addEventListener("click", handleSignOut);
  ui.closeAuthModal.addEventListener("click", closeAuthModal);

  document.querySelectorAll("[data-close-auth='true']").forEach((element) => {
    element.addEventListener("click", closeAuthModal);
  });

  document.querySelectorAll("[data-auth-tab]").forEach((tabButton) => {
    tabButton.addEventListener("click", () => {
      setAuthTab(tabButton.dataset.authTab === "create" ? "create" : "signin");
    });
  });

  ui.signInForm.addEventListener("submit", handleSignIn);
  ui.createAccountForm.addEventListener("submit", handleCreateAccount);
  ui.historyRows.addEventListener("click", (event) => {
    const playButton = event.target.closest("button[data-clip-id]");
    if (playButton && !playButton.disabled) void playDetectionClip(playButton.dataset.clipId);
    const photoButton = event.target.closest("button[data-photo-id]");
    if (photoButton && !photoButton.disabled) void showDetectionPhoto(photoButton.dataset.photoId);
  });
  ui.closeHistoryVideo.addEventListener("click", closeDetectionClip);
  document.querySelectorAll("[data-close-history-video='true']").forEach((element) => {
    element.addEventListener("click", closeDetectionClip);
  });
  ui.closeHistoryPhoto.addEventListener("click", closeDetectionPhoto);
  document.querySelectorAll("[data-close-history-photo='true']").forEach((element) => {
    element.addEventListener("click", closeDetectionPhoto);
  });

  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  document.querySelectorAll("[data-page-link]").forEach((link) => link.addEventListener("click", () => setPage(link.dataset.pageLink)));

  ui.start.addEventListener("click", startDetection);
  ui.stop.addEventListener("click", stopDetection);
  ui.screenRecord.addEventListener("click", () => void startScreenRecording());
  ui.screenStop.addEventListener("click", stopScreenRecording);

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

  ui.clearHistory.addEventListener("click", async () => {
    if (!history.length) return;
    const confirmed = window.confirm("Clear all saved detection history on this device? This cannot be undone.");
    if (!confirmed) return;
    let clipsFailedToDelete = false;
    try {
      await clearDetectionClips();
    } catch (error) {
      console.error("Could not clear saved bird detection clips:", error);
      clipsFailedToDelete = true;
    }
    history = [];
    saveHistory();
    refreshHistory();
    showToast(clipsFailedToDelete
      ? "History was cleared, but some saved video clips could not be deleted."
      : "Detection history and video clips cleared from this device.");
  });

  window.addEventListener("beforeunload", () => {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    if (historyVideoUrl) URL.revokeObjectURL(historyVideoUrl);
    if (historyPhotoUrl) URL.revokeObjectURL(historyPhotoUrl);
    if (screenRecordingStream) screenRecordingStream.getTracks().forEach((track) => track.stop());
  });

  syncSettingsToUI();
  refreshHistory();
  setCameraState(false);
  updateAuthUI();
  setAuthTab("signin");
})();