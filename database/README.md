# Database Model

PostgreSQL becomes the canonical Muzare data store. Browser IndexedDB is an offline queue, not the financial source of truth.

## Rules

- Operational records use UUID identifiers generated client-side or by PostgreSQL.
- Every seasonal transaction is scoped by `farm_id` and `season_id`.
- Financial balances are derived from immutable `account_transactions`.
- Server authorization controls writes for `admin`, `operator`, and `viewer`.
- Users authenticate through API-managed password hashes and expiring database sessions.
- `sync_version` supports conflict checks for offline PWA submissions.

The baseline schema is in `migrations/0001_initial.sql`. The API also represents this model in Drizzle for type-safe application access.

Until a PostgreSQL `DATABASE_URL` is configured, the development API uses an in-memory local admin session solely to allow frontend testing.
