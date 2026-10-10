# Design System (Phase 4)

> **Status: PROPOSED.** The Phase 4 instruction refers to "the approved design system". No visual design system had been approved in earlier phases, so this one was derived from the Phase 1 documents (roles, workflows) and accessibility requirements. **It needs owner approval**, and branding (logo, colours, typeface) can replace the tokens without touching components.

## 1. Principles

1. **Clarity over decoration.** This is a financial tool, so plain layouts and readable tables come first.
2. **Accessible by default:** WCAG 2.1 AA targets, keyboard-first, screen-reader labels.
3. **The UI never decides access.** Components only *display* what the server and RLS allow.
4. **Demo content is unmistakable:** it is always wrapped in a dashed "DEMO DATA" notice and never shown in production.

## 2. Tokens (`src/app/globals.css`)

| Token | Purpose |
|---|---|
| `--background`, `--foreground` | Page and text |
| `--surface`, `--surface-raised`, `--border`, `--muted` | Panels, cards, separators, secondary text |
| `--accent`, `--accent-foreground` | Primary actions, active navigation |
| `--success`, `--warning`, `--danger` (+ `-bg`) | Status, alerts, destructive actions |
| `--info-bg`, `--focus` | Information alerts, keyboard focus ring |
| `--sidebar-width` | Shell layout |

Light and dark palettes are defined (dark via `prefers-color-scheme`). Components use **tokens only, never raw colours**.

## 3. Components

| Component | File | Notes |
|---|---|---|
| App shell | `components/shell/app-shell.tsx` | Skip link; header (workspace label, notifications, account menu); sidebar on ≥ md, menu disclosure on mobile; `<main id="main">` |
| Navigation | `components/shell/nav-client.tsx` | Items come from `buildNavigation()` (the policy); `aria-current="page"` |
| Sub-navigation (tabs) | `components/ui/sub-nav.tsx` | Policy-filtered tabs inside a client's portal |
| Page header | `primitives.tsx` → `PageHeader` | Title, description, breadcrumbs (`aria-label="Breadcrumb"`), actions |
| Section, Card | `primitives.tsx`, `card.tsx` | Grouping |
| Buttons | `primitives.tsx` → `BUTTON_VARIANTS`, `LinkButton` | primary / secondary / danger |
| Badge | `primitives.tsx` | neutral / info / success / warning / danger |
| Alert | `primitives.tsx` | `role="alert"` for danger, `role="status"` otherwise |
| Empty state, Skeletons | `primitives.tsx` | `PageSkeleton` has `role="status"` and a hidden "Loading…" |
| Demo notice | `primitives.tsx` → `DemoNotice` | `role="note"`, `data-demo="true"` |
| Data table | `components/ui/data-table.tsx` | `<caption>` (sr-only), `scope="col"`, horizontal scroll, standard empty state, sr-only action headers |
| Forms | `components/ui/action-form.tsx` | `ActionForm`, `Field`, `Select`: labelled inputs, required markers, `aria-invalid`, `aria-describedby` to the hint and error, focus moved to the first invalid field or the error summary, double-submit guarded with `aria-busy` |
| Notifications | `components/ui/toast.tsx` | Toasts in an `aria-live="polite"` region (errors use `role="alert"`), dismissible, auto-expire after 6 s. The header bell shows the pending-invitation count. |
| Access states | `components/ui/access-states.tsx` | `AccessDenied` (403-style), `NotFoundState` (used for other tenants' URLs, so existence is never revealed) |

## 4. Page patterns

- Every protected page has the same shape: `Suspense(PageSkeleton)` → `guardRoute()` → `DeniedState` **or** content wrapped in `data-route="<route>"`.
- Loading: `(workspace)/loading.tsx` and per-page Suspense skeletons.
- Errors: `(workspace)/error.tsx` keeps the shell and shows a reference id; `global-error.tsx` is the last resort.
- Dates are shown in **Asia/Manila** (`formatManila`).

## 5. Accessibility checklist (implemented)

- Skip link, landmarks (`header`, `nav[aria-label]`, `main`), one `h1` per page
- Visible `:focus-visible` outline; `prefers-reduced-motion` respected
- All inputs labelled; errors announced and linked; tables have captions and header scopes
- Toasts announced politely; destructive actions confirm first

**Not yet done:** an automated axe/Lighthouse audit, and testing with real assistive technology. Proposed for the hardening phase.
