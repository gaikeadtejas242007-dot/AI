/* Perch full-stack bridge. Existing camera/detection code remains unchanged.
   Run the Express server to enable server-side accounts and cloud-synced history. */
(() => {
  "use strict";
  const API = window.PERCH_API_URL || (location.protocol === "file:" ? "http://localhost:3000/api" : `${location.origin}/api`);
  const SESSION_KEY = "perch.auth.session.v1";
  const HISTORY_KEY = "perch.detection-history.v1";
  const $ = (id) => document.getElementById(id);
  let syncing = false;

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
  }
  function setSession(user, token) {
    if (!user) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify({ id: user.id, email: user.email, fullName: user.fullName, token }));
    updateAuth(user);
  }
  function updateAuth(user = getSession()) {
    const loggedIn = !!(user && user.email);
    const signin = $("sign-in-button"), create = $("create-account-button"), menu = $("user-menu"), name = $("user-name");
    if (!signin || !create || !menu) return;
    signin.hidden = loggedIn; create.hidden = loggedIn; menu.hidden = !loggedIn;
    if (name && loggedIn) name.textContent = user.fullName || user.email;
  }
  function toast(message) {
    const node = $("toast");
    if (node) { node.textContent = message; node.classList.add("visible"); setTimeout(() => node.classList.remove("visible"), 3500); }
    else window.alert(message);
  }
  async function request(path, options = {}) {
    const session = getSession();
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (session && session.token) headers.Authorization = `Bearer ${session.token}`;
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Request failed. Check the server and try again.");
    return payload;
  }
  function showModal() { const modal = $("auth-modal"); if (modal) modal.hidden = false; }
  function closeModal() { const modal = $("auth-modal"); if (modal) modal.hidden = true; }

  // Capture phase takes precedence over the original demo-only localStorage auth handlers.
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form || !["sign-in-form", "create-account-form"].includes(form.id)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const submit = form.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      let result;
      if (form.id === "create-account-form") {
        const fullName = $("signup-name").value.trim();
        const email = $("signup-email").value.trim().toLowerCase();
        const phone = $("signup-phone").value.trim();
        const password = $("signup-password").value;
        const confirmPassword = $("signup-confirm-password").value;
        if (password !== confirmPassword) throw new Error("Passwords do not match.");
        if (password.length < 8) throw new Error("Use a password with at least 8 characters.");
        result = await request("/auth/register", { method: "POST", body: JSON.stringify({ fullName, email, phone, password }) });
      } else {
        result = await request("/auth/login", { method: "POST", body: JSON.stringify({
          email: $("signin-email").value.trim().toLowerCase(), password: $("signin-password").value
        }) });
      }
      setSession(result.user, result.token);
      form.reset(); closeModal(); toast(form.id === "create-account-form" ? "Account created successfully." : `Welcome back, ${result.user.fullName}!`);
      await syncHistoryToServer();
      await loadRemoteHistory();
    } catch (error) { toast(error.message || "Could not connect to the backend."); }
    finally { if (submit) submit.disabled = false; }
  }, true);

  document.addEventListener("click", async (event) => {
    if (event.target && event.target.closest("#sign-out-button")) {
      const session = getSession();
      if (session && session.token) request("/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
      setSession(null); toast("Signed out."); 
    }
  }, true);

  async function syncHistoryToServer() {
    const session = getSession();
    if (!session || !session.token || syncing) return;
    syncing = true;
    try {
      const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      await request("/history/sync", { method: "PUT", body: JSON.stringify({ entries: history }) });
    } catch (error) { console.warn("Perch history sync:", error.message); }
    finally { syncing = false; }
  }
  async function loadRemoteHistory() {
    const session = getSession();
    if (!session || !session.token) return;
    try {
      const result = await request("/history");
      const local = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      const map = new Map();
      [...(result.entries || []), ...local].forEach((entry) => { if (entry && entry.id) map.set(entry.id, entry); });
      localStorage.setItem(HISTORY_KEY, JSON.stringify([...map.values()].sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt))));
      // Original app reads history during boot; refresh to render the merged remote history.
      const rows = $("history-rows");
      if (rows) window.dispatchEvent(new CustomEvent("perch:remote-history-loaded"));
    } catch (error) { console.warn("Perch history load:", error.message); }
  }
  // Observe writes by the original app without editing its detection/session logic.
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    originalSetItem.call(this, key, value);
    if (this === localStorage && key === HISTORY_KEY) queueMicrotask(syncHistoryToServer);
  };

  window.PerchBackend = { request, syncHistoryToServer, loadRemoteHistory };
  document.addEventListener("DOMContentLoaded", () => {
    updateAuth();
    const user = getSession();
    if (user && user.token) { loadRemoteHistory(); request("/health").catch(() => {}); }
  });
})();
