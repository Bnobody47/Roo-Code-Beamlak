# .orchestration/ — TRP1 machine-generated artifacts

This directory is **maintained by the extension** when the agent runs in this workspace. The files are written by the hook system (post-hooks and `select_active_intent` tool), not by hand.

## Artifacts (cross-referenced)

| File                    | Purpose                                                                                                                                                                                            | Updated by                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **active_intents.yaml** | Intent specification: id, name, **status** (IN_PROGRESS / DONE / BLOCKED), owned_scope, constraints, acceptance_criteria. **Multiple intents** show a richer lifecycle.                            | Pre/Post-hook when agent calls `select_active_intent` or when intent is synced |
| **agent_trace.jsonl**   | Append-only ledger: intent → content_hash → file path (TRP1 schema with `vcs.revision_id`, `related`). Entries from **multiple sessions** (e.g. task-001, task-002) show cross-artifact evolution. | Post-hook after every mutating tool                                            |
| **intent_map.md**       | Spatial map: intent ID → physical files. **Multi-intent** (INT-001, INT-002) so “where is X?” is answerable per intent.                                                                            | Post-hook when a file is written under an active intent                        |
| **CLAUDE.md**           | **Shared brain / knowledge base**: project rules, lessons learned, session notes. Maintained and appended to across sessions (e.g. via `appendLesson()`).                                          | Scaffolded by hook; appended by tools or Phase 4 lesson recording              |

**Internal consistency:** Intent IDs and file paths appear across all four artifacts. Multiple intents (INT-001, INT-002, INT-003) and diverse statuses (IN_PROGRESS, DONE, BLOCKED) demonstrate a multi-intent lifecycle and cross-artifact evolution across sessions.

This directory is included in the repo as **evidence from a real run** for the TRP1 final submission.
