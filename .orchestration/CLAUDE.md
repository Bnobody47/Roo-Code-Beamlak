# CLAUDE.md — Shared Brain

Persistent knowledge base shared across parallel sessions (Architect / Builder / Tester). Maintained by the extension and by agents; prevents drift and captures lessons so future sessions don’t repeat mistakes.

---

## Project rules (style & constraints)

- Prefer TypeScript strict mode; avoid `any` where a type can be inferred.
- All mutating tools (write_to_file, apply_patch, edit, etc.) require an active intent: call `select_active_intent(intent_id)` first.
- Files under an intent’s `owned_scope` are the only targets that intent may edit; out-of-scope writes are blocked by the hook.

---

## Lessons learned

- 2026-02-18T12:05:00.000Z: Scope violation: Agent attempted to edit `src/billing/invoice.ts` while intent INT-001 (JWT Auth) was active; INT-001’s owned_scope is `src/auth/**` and `src/middleware/jwt.ts`. Resolution: Agent called `select_active_intent("INT-002")` and then proceeded.
- 2026-02-18T12:10:00.000Z: Linter failed on `src/middleware/jwt.ts` after refactor — export of `validateToken` was missing. Re-export added and tests re-run.
- 2026-02-18T12:15:00.000Z: Parallel session (Architect) updated intent_map.md while Builder was editing; both referenced INT-002. No conflict because intent_map is append-only and both wrote under INT-002’s scope.

---

## Session notes (cross-session evolution)

| Session  | Intent(s) | Outcome                                                                   |
| -------- | --------- | ------------------------------------------------------------------------- |
| task-001 | INT-001   | JWT middleware refactor; 2 files traced (middleware.ts, jwt.ts).          |
| task-002 | INT-002   | Billing API stub added; intent marked DONE after acceptance criteria met. |
| task-003 | INT-001   | Auth tests updated; INT-001 still IN_PROGRESS.                            |

This file is scaffolded by the hook system and appended to via `appendLesson()` (e.g. when verification fails). Multiple intents and sessions above demonstrate cross-artifact evolution.
