# .orchestration/ — TRP1 machine-generated artifacts

This directory is **maintained by the extension** when the agent runs in this workspace. The files are written by the hook system (post-hooks and `select_active_intent` tool), not by hand.

## Artifacts (cross-referenced)

| File                    | Purpose                                                                                               | Updated by                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **active_intents.yaml** | Intent specification: id, name, status, owned_scope, constraints, acceptance_criteria                 | Pre/Post-hook when agent calls `select_active_intent` or when intent is synced |
| **agent_trace.jsonl**   | Append-only ledger: intent → content_hash → file path (TRP1 schema with `vcs.revision_id`, `related`) | Post-hook after every mutating tool                                            |
| **intent_map.md**       | Spatial map: intent ID → physical files                                                               | Post-hook when a file is written under an active intent                        |

**Internal consistency:** The same intent ID (e.g. `INT-001`) appears in all three: in `active_intents.yaml`, in `agent_trace.jsonl` under `files[].conversations[].related[].value`, and in `intent_map.md` as the left-hand side of each mapping. File paths in the trace match the paths listed under that intent in the intent map.

This directory is included in the repo as **evidence from a real run** for the TRP1 final submission (".orchestration/ directory from a real run showing active_intents.yaml, agent_trace.jsonl, and intent_map.md with machine-generated, internally consistent state and cross-references").
