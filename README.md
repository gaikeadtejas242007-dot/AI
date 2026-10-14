# Perch — Bird Detection & Deterrent (Full-stack edition)

The original `index.html`, `style.css`, and `script.js` are preserved. A small script include and `fullstack.js` add server-backed accounts and history sync. The camera/AI detection remains in the browser; camera frames and selected audio are **not uploaded**.

## What's added

- Node.js + Express REST API
- Local SQLite database (`data/perch.sqlite`) for accounts, detection history, and revoked login sessions
- Password hashing with bcrypt; JWT-based API sessions; logout token revocation
- Account registration/login validation and auth rate limiting
- Per-user history sync, list, and delete API
- Health endpoint and basic security headers
- Existing app works locally without any AI/camera code rewrite

## Requirements

- Node.js 20 or newer
- Internet access on first load for the existing TensorFlow.js / COCO-SSD browser libraries
- A browser with camera permission; use `localhost` or HTTPS

## Run on Windows (PowerShell)

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy the generated secret into the `JWT_SECRET` value in `.env`. Keep `.env` private; it is excluded by `.gitignore`.

From the project folder, install dependencies and start the server:

```powershell
npm install
npm start
```

Open `http://localhost:3000`. The SQLite database is created automatically under `data/`.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Server/database service check |
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/logout` | Revoke current token |
| GET | `/api/me` | Current account |
| GET | `/api/history` | Fetch signed-in user's history |
| PUT | `/api/history/sync` | Sync browser detection history |
| DELETE | `/api/history` | Delete signed-in user's server history |

Auth endpoints accept JSON. Register: `{"fullName":"Example User","email":"user@example.com","phone":"","password":"a-long-password"}`. Login: `{"email":"user@example.com","password":"a-long-password"}`. Protected endpoints require `Authorization: Bearer <token>`.

## Important notes / next steps for production

- Set a strong `JWT_SECRET` in your hosting provider's environment variables. Do not commit real secrets.
- Use HTTPS in production. Add CORS only if you host the frontend and API on different origins; configure a strict allowlist.
- SQLite is stored on the local machine. For shared hosting or multiple server instances, move to a managed database and persistent storage.
- The browser session token is stored in localStorage for compatibility with the original app. For a public production service, prefer secure, HttpOnly, SameSite cookies and CSRF protection.
- History sync is best-effort and requires signing in while the backend is online. The original local history stays in the browser. Camera clips/photos remain local in IndexedDB; this backend does not upload them.
- Camera model inference still runs locally in the browser, so distant/small birds may be missed depending on resolution, lighting, focus, angle, and model class limits.
- The previous local demo accounts in localStorage are not imported into the server database; create a new account in this full-stack edition.

## Original project files

- `index.html` — original interface plus one script include for the backend bridge
- `style.css` — original styling, unchanged
- `script.js` — original camera/detection/history behavior, unchanged
- `fullstack.js` — backend authentication and history bridge
- `server.js` — Express API and local SQLite persistence
- `package.json` — backend dependencies/scripts
