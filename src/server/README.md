# src/server — server-only business logic

- Every module here starts with `import "server-only";`. Importing it from client code fails the build.
- This is the **only** place allowed to import the privileged admin client (`@/lib/supabase/admin`). ESLint enforces this rule.
- Every function that changes data must:
  1. validate its input (Zod),
  2. derive the caller from the session, never from client-supplied IDs,
  3. check authorization,
  4. call the database, preferring Postgres functions for state transitions,
  5. return data or throw an `AppError` (`@/lib/errors/app-error`).
- Route Handlers and Server Functions are thin. They call into this folder and convert errors with `toPublicError`.
