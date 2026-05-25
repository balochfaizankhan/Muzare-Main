# Muzare Platform

This repository contains the existing Android application and the new PWA platform.

## Applications

- `app/`: existing Android application
- `web/`: React/Vite installable PWA deployed to Vercel
- `api/`: Fastify/TypeScript API deployed to Render
- `database/`: PostgreSQL baseline migration and data model notes

## Local Development

Requirements for UI testing: Node.js 22+.

```bash
npm install
npm run dev:api
npm run dev:web
```

With no `DATABASE_URL` configured, the development API runs in local login mode so the PWA can be tested before Render is connected:

```text
admin@muzare.local
ChangeMe123!
```

These local sessions are memory-only and reset when the API restarts.

## PostgreSQL Mode

Copy `api/.env.example` to `api/.env` and `web/.env.example` to `web/.env`. Set `DATABASE_URL`, then apply `database/migrations/0001_initial.sql` to PostgreSQL before starting the API.

When `DATABASE_URL`, `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` are configured, the API creates the first PostgreSQL admin user on startup if it does not already exist. The sample configured login is:

```text
admin@muzare.local
ChangeMe123!
```

Change that password value for any hosted deployment.

## Deployment Model

- Vercel serves only the PWA frontend.
- Render hosts the API service and PostgreSQL database.
- The frontend sends API-issued session tokens to the backend.
- The API stores password hashes and sessions in PostgreSQL, enforces roles, and accesses PostgreSQL through Render internal networking.
