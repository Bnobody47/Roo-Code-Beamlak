# Intent Map

Maps business intents to physical files (updated by post-hook when agent writes under an intent). Enables "Where is the billing logic?" → intent → files. Multiple intents show cross-artifact evolution across sessions.

- **INT-001** → `src/auth/middleware.ts`
- **INT-001** → `src/middleware/jwt.ts`
- **INT-002** → `src/api/billing.ts`
- **INT-002** → `src/billing/charge.ts`
