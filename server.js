require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "perch.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  
  CREATE TABLE IF NOT EXISTS detection_history (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds REAL DEFAULT 0,
    peak_birds INTEGER DEFAULT 0,
    max_confidence REAL DEFAULT 0,
    average_confidence REAL DEFAULT 0,
    audio_name TEXT DEFAULT '',
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_history_user_started ON detection_history(user_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false }));

function publicUser(row) {
  return { id: row.id, fullName: row.full_name, email: row.email, phone: row.phone, createdAt: row.created_at };
}

function makeToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET must be set to a random secret of at least 32 characters.");
  return jwt.sign({ sub: String(user.id) }, secret, { expiresIn: "7d", issuer: "perch-api", audience: "perch-web" });
}

function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Please sign in to continue." });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { issuer: "perch-api", audience: "perch-web" });
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const revoked = db.prepare("SELECT 1 FROM revoked_tokens WHERE token_hash = ?").get(tokenHash);
    if (revoked) return res.status(401).json({ error: "Session expired. Please sign in again." });
    req.token = token;
    req.user = db.prepare("SELECT id, full_name, email, phone, created_at FROM users WHERE id = ?").get(Number(decoded.sub));
    if (!req.user) return res.status(401).json({ error: "Account no longer exists." });
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session. Please sign in again." });
  }
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function normalizeEntry(entry, userId) {
  if (!entry || typeof entry !== "object" || !String(entry.id || "").trim() || !String(entry.startedAt || "").trim()) return null;
  const n = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const payload = JSON.stringify(entry);
  if (payload.length > 100000) return null;
  return {
    id: String(entry.id).slice(0, 150),
    userId,
    startedAt: String(entry.startedAt).slice(0, 80),
    endedAt: entry.endedAt ? String(entry.endedAt).slice(0, 80) : null,
    durationSeconds: Math.max(0, n(entry.durationSeconds ?? entry.duration)),
    peakBirds: Math.max(0, Math.min(10000, n(entry.peakBirds ?? entry.peak))),
    maxConfidence: Math.max(0, Math.min(1, n(entry.maxConfidence))),
    averageConfidence: Math.max(0, Math.min(1, n(entry.averageConfidence))),
    audioName: String(entry.audioName || "").slice(0, 255),
    payload
  };
}

const UPSERT_HISTORY = db.prepare(`
  INSERT INTO detection_history(id,user_id,started_at,ended_at,duration_seconds,peak_birds,max_confidence,average_confidence,audio_name,payload_json,updated_at)
  VALUES(@id,@userId,@startedAt,@endedAt,@durationSeconds,@peakBirds,@maxConfidence,@averageConfidence,@audioName,@payload,datetime('now'))
  ON CONFLICT(user_id,id) DO UPDATE SET started_at=excluded.started_at,ended_at=excluded.ended_at,
  duration_seconds=excluded.duration_seconds,peak_birds=excluded.peak_birds,max_confidence=excluded.max_confidence,
  average_confidence=excluded.average_confidence,audio_name=excluded.audio_name,payload_json=excluded.payload_json,updated_at=datetime('now')
`);

app.get("/api/health", (_req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ status: "ok", service: "Perch API", database: "connected" });
  } catch (error) {
    console.error("SQLite health check failed:", error);
    res.status(503).json({ status: "error", service: "Perch API", database: "disconnected" });
  }
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const body = req.body || {};
    const fullName = String(body.fullName || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "");
    if (fullName.length < 2 || fullName.length > 100) return res.status(400).json({ error: "Enter a name between 2 and 100 characters." });
    if (!validEmail(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be 8–128 characters." });
    if (phone.length > 30) return res.status(400).json({ error: "Phone number is too long." });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users(full_name,email,phone,password_hash) VALUES(?,?,?,?)")
      .run(fullName, email, phone, passwordHash);
    const user = db.prepare("SELECT id,full_name,email,phone,created_at FROM users WHERE id=?").get(result.lastInsertRowid);
    res.status(201).json({ user: publicUser(user), token: makeToken(user) });
  } catch (error) {
    if (String(error.code) === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "An account with this email already exists." });
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    res.json({ user: publicUser(user), token: makeToken(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", auth, (req, res) => {
  const tokenHash = crypto.createHash("sha256").update(req.token).digest("hex");
  const decoded = jwt.decode(req.token);
  db.prepare("INSERT OR REPLACE INTO revoked_tokens(token_hash,expires_at) VALUES(?,?)").run(tokenHash, decoded.exp);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get("/api/history", auth, (req, res, next) => {
  try {
    const rows = db.prepare("SELECT payload_json FROM detection_history WHERE user_id=? ORDER BY started_at DESC LIMIT 1000")
      .all(req.user.id);
    res.json({ entries: rows.map((row) => JSON.parse(row.payload_json)) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/history/sync", auth, (req, res, next) => {
  try {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries)) return res.status(400).json({ error: "entries must be an array." });
    if (entries.length > 1000) return res.status(413).json({ error: "Sync is limited to 1000 history entries at a time." });
    const saveMany = db.transaction((items) => {
      let saved = 0;
      for (const entry of items) {
        const normalized = normalizeEntry(entry, req.user.id);
        if (normalized) {
          UPSERT_HISTORY.run(normalized);
          saved += 1;
        }
      }
      return saved;
    });
    res.json({ ok: true, received: entries.length, saved: saveMany(entries) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/history", auth, (req, res, next) => {
  try {
    const result = db.prepare("DELETE FROM detection_history WHERE user_id=?").run(req.user.id);
    res.json({ ok: true, deleted: result.changes });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(ROOT, { extensions: ["html"] }));
app.get("/{*path}", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(ROOT, "index.html"));
});
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error." : (err.message || "Internal server error.") });
});

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("Set JWT_SECRET to a random secret of at least 32 characters in your .env file.");
  process.exitCode = 1;
} else {
  const server = app.listen(PORT, () => console.log(`Perch full-stack server running at http://localhost:${PORT}`));
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
