# src/features

One folder per business module from the module map (`docs/04-module-dependency-map.md`), for example `clients/`, `documents/`, `ledger/` and `tax-returns/`. Each folder can contain:

- `components/`: UI specific to the feature. It may be a Client or Server Component.
- `actions.ts`: Server Functions (`"use server"`). Each one validates its input with Zod and delegates to `src/server/<feature>`.
- `schemas.ts`: Zod input schemas shared by forms and server actions.

Business rules do **not** live here. They live in `src/server/<feature>` (server-only) or in pure, framework-free modules that can be unit-tested.

No feature folders exist yet. Phase 2 is the foundation only.
