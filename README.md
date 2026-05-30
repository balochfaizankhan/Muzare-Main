# Muzare Platform

This repository contains the existing Android application and the new PWA platform.

## Project Structure

| Directory | Purpose | Deployment |
| --- | --- | --- |
| `app/` | Existing Android application | Android build only |
| `web/` | React/Vite installable PWA | Vercel |
| `api/` | Fastify/TypeScript API | Render Web Service |
| `database/` | PostgreSQL initial schema | Render Postgres |

The Git repository root is the folder containing this `README.md`, `api/`, `web/`, and `render.yaml`.

## Local Development

Requirements: Node.js 22+.

```bash
npm install
npm run dev:api
npm run dev:web
```

For quick local testing, do not create `.env` files yet. When `DATABASE_URL` is not configured, the development API provides a local-only login:

```text
admin@muzare.local
ChangeMe123!
```

Open the local PWA at `http://localhost:5173`. Local login sessions reset when the API restarts. Operational module records are currently stored in the browser's IndexedDB pending their Render API synchronization endpoints.

## Local PostgreSQL Development

Use these instructions only when testing the API with your own local PostgreSQL database:

1. Copy `api/.env.example` to `api/.env`.
2. Copy `web/.env.example` to `web/.env`.
3. Set `DATABASE_URL` in `api/.env`.
4. Apply `database/migrations/0001_initial.sql` to your PostgreSQL database.
5. Start the API and PWA.

When `DATABASE_URL`, `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` are set, the API creates the first platform administrator on startup if one does not already exist. Platform administrators do not belong to a farm workspace.

## Production Deployment

Production has three resources:

| Provider | Service | Contents |
| --- | --- | --- |
| Render | `muzare-db` Postgres database | PostgreSQL records |
| Render | `muzare-api` Node Web Service | `api/` backend |
| Vercel | `muzare-web` PWA frontend | `web/` |

### 1. Deploy Render From Blueprint

Use the checked-in `render.yaml` Blueprint instead of creating Render resources manually. It creates both resources on free test instances in Singapore and connects `muzare-api` to `muzare-db` through `DATABASE_URL`.

1. Push this repository to GitHub.
2. In Render, click **New > Blueprint**.
3. Connect the GitHub repository.
4. Select branch `main` and Blueprint path `render.yaml`.
5. When prompted, enter these secret values:

| Variable | Value |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated allowed frontend origins, for example `https://muzare-main.onrender.com,https://muzare-main-web.vercel.app` |
| `BOOTSTRAP_ADMIN_EMAIL` | Production administrator email |
| `BOOTSTRAP_ADMIN_PASSWORD` | Strong production password |
| `BOOTSTRAP_ADMIN_NAME` | `Administrator` |

6. Click **Deploy Blueprint**.

Do not manually create a second `muzare-api` or `muzare-db` after deploying the Blueprint.

Free Render services are suitable for setup and testing. The web service may spin down while idle, and a free Render Postgres database expires after 30 days. Upgrade both resources before using the application for live farm records.

### 2. Initialize Render Postgres Once

The initial database schema must be applied once before the API can finish starting. From PowerShell in this repository, copy the **External Database URL** from `muzare-db` and run:

```powershell
$env:DATABASE_URL = "PASTE_RENDER_EXTERNAL_DATABASE_URL_HERE"
npm run db:init
Remove-Item Env:DATABASE_URL
```

Then open `muzare-api` and select **Manual Deploy > Deploy latest commit**.

After the API becomes live, verify:

```text
https://YOUR-RENDER-API-DOMAIN/health
```

Render supplies `PORT`; do not configure it manually. `LOCAL_ADMIN_EMAIL` and `LOCAL_ADMIN_PASSWORD` are development-only and must not be used for production.

### 3. Deploy `muzare-web` On Vercel

Import this same GitHub repository in Vercel with these settings:

| Vercel Setting | Value |
| --- | --- |
| Project Name | `muzare-web` |
| Framework Preset | `Vite` |
| Root Directory | `web` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

Set the frontend environment variable:

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | Public Render API URL, for example `https://muzare-api.onrender.com` |

After Vercel assigns the public frontend URL, return to the Render `muzare-api` environment variables and set `ALLOWED_ORIGINS` to every frontend origin that should call the API, for example `https://muzare-main.onrender.com,https://muzare-main-web.vercel.app`. Redeploy `muzare-api` after changing it.
