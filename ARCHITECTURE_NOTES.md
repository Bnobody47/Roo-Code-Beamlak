# ARCHITECTURE_NOTES.md — TRP1 Phase 0 & Hook System

## How the VS Code extension works

- **Entry**: Extension activates in `src/activate/` (e.g. `activate.ts`), which registers the **ClineProvider** (sidebar/tab panel) and commands.
- **Provider**: `src/core/webview/ClineProvider.ts` holds the **Task** stack, MCP hub, settings, and webview messaging. It does **not** execute tools; it creates **Task** instances and forwards messages.
- **Task**: `src/core/task/Task.ts` holds per-conversation state (API handler, history, mode, cwd, **activeIntentId** for TRP1), runs the API stream, and pushes assistant content for presentation.
- **Tool execution path**: When the model streams a `tool_use` (or `mcp_tool_use`) block, **presentAssistantMessage** in `src/core/assistant-message/presentAssistantMessage.ts` processes it: validates, then **dispatches to the correct tool handler** via a large `switch (block.name)`.

## Tool loop and mutation points

- **Single choke point**: All native and MCP tool execution goes through **presentAssistantMessage**:
    - **Native**: `case "tool_use":` → `switch (block.name)` with cases for `apply_patch`, `write_to_file`, `edit`, `execute_command`, **select_active_intent**, etc. Each case calls `someTool.handle(cline, block, { askApproval, handleError, pushToolResult })`.
    - **MCP**: `case "mcp_tool_use":` → builds a synthetic `use_mcp_tool` block and calls **useMcpToolTool.handle**.
- **File / mutation tools**: Implementations live under `src/core/tools/`:
    - **ApplyPatchTool** (`ApplyPatchTool.ts` + `apply-patch/`): parses patch, applies add/update/delete; uses **rooIgnoreController**, **rooProtectedController**, **diffViewProvider**, and **askApproval** before writing.
    - **WriteToFileTool**, **EditTool**, **ApplyDiffTool**, etc.: same pattern (validate, optional approval, then mutate).
- **execute_command** and **write_to_file** (and equivalents) are all invoked from this same `presentAssistantMessage` switch; there is no other code path that performs tool execution for the assistant.

## Prompt builder

- **System prompt**: Built in `src/core/prompts/system.ts` via **generatePrompt** (and exported **SYSTEM_PROMPT**). It composes:
    - Role and mode from **getModeBySlug** / **getModeSelection**
    - Sections from `src/core/prompts/sections/`: **getSharedToolUseSection**, **getToolUseGuidelinesSection**, **getCapabilitiesSection**, **getModesSection**, **getRulesSection**, **getSystemInfoSection**, **getObjectiveSection**, **addCustomInstructions**
- **Intent-first instruction**: In **getObjectiveSection** (`sections/objective.ts`) we add the TRP1 rule: before any mutating tool, the model **must** call **select_active_intent(intent_id)**; otherwise the Hook Engine blocks the call.
- **Tools catalog**: Tool definitions (names, descriptions, parameters) come from **getNativeTools** / **buildNativeToolsArrayWithRestrictions** in `src/core/task/build-tools.ts`, which uses `src/core/prompts/tools/native-tools/` (including **select_active_intent**) and mode filtering from `filter-tools-for-mode.ts`.

## Hook Engine (TRP1) integration

- **Location**: `src/hooks/` — **HookEngine.ts**, **types.ts**, **classifier.ts**, **sidecarWriter.ts**.
- **Wiring**: In **presentAssistantMessage**, **before** the tool `switch` we build a **HookContext** (taskId, activeIntentId, mode, modelId, toolName, params, cwd, timestamp) and instantiate **HookEngine** with:
    - **Pre-hooks**: **requireActiveIntent** (block destructive tools if no **activeIntentId**), **hashMutation** (set contentHash from mutationSummary).
    - **Post-hooks**: **syncActiveIntent** (write/update **.orchestration/active_intents.yaml** when intent is set).
- **runWithHooks**: We call **hookEngine.runWithHooks(hookContext, async () => { switch (block.name) { ... } })**. If any pre-hook returns **allow: false**, the tool is **not** executed and we push a **tool_result** error (e.g. "No active intent selected. Call select_active_intent first."). After execution (or after a deny), post-hooks run and we append to **.orchestration/agent_trace.jsonl** (flat entry and, when intent+hash exist, a TRP1-shaped entry with **files[].conversations[].ranges[].content_hash** and **related**).
- **select_active_intent**: New tool in **SelectActiveIntentTool.ts**. It sets **task.activeIntentId**, reads **.orchestration/active_intents.yaml** via **loadActiveIntents**, and returns an **<intent_context>** XML block (constraints, owned_scope) as the tool result so the model has context for subsequent edits.
- **.orchestration/**: Machine-managed directory in workspace root: **active_intents.yaml** (TRP1 intent list), **agent_trace.jsonl** (append-only trace with TRP1 schema: content_hash, vcs.revision_id, related intent), **intent_map.md** (updated by post-hook when agent writes a file — maps intent ID → file path for cross-reference). **CLAUDE.md** is scaffolded for the shared brain. This repo includes a **.orchestration/** directory from a real run with **machine-generated, internally consistent** state: the same intent ID (e.g. INT-001) and file paths appear across all three artifacts; see `.orchestration/README.md`.

## Theoretical grounding (Why this architecture exists)

This implementation is intentionally designed to reduce **Cognitive Debt** and **Trust Debt** in AI-assisted engineering, and to prevent **Context Rot**.

- **Cognitive Debt**: When a developer (or reviewer) cannot reconstruct _why_ changes happened, velocity becomes “borrowed time” that must be repaid later via debugging, archeology, and re-learning. The Reasoning Loop forces an explicit _intent checkout_ step (`select_active_intent`) so changes are anchored to a named, reviewable business objective rather than an implicit chat thread.
- **Trust Debt**: When AI changes exceed our ability to verify them, we accumulate risk. The hook engine creates a deterministic interception point for _every_ mutating action and writes a ledger entry (`agent_trace.jsonl`) linking **intent_id → tool action → content hash** to improve auditability.
- **Context Rot**: Long-running agent sessions degrade because context becomes stale, overly broad, or contradictory. By loading only the selected intent’s **scope + constraints** into an explicit `<intent_context>` block, we keep the “active context” narrow and relevant for the next mutation.

In short: the hook middleware is not “extra plumbing”; it is the enforcement mechanism that turns AI output from “best effort” into a governed workflow with an inspectable decision trail.

## The “Reasoning Loop” architecture (Phases 1 & 2)

**Goal (Context Paradox)**: the agent must be constrained _before_ it generates code, but those constraints are intent-specific and cannot be known until an intent is selected.

**Solution (Two-stage state machine per turn)**:

- **Stage A — Handshake / Intent checkout**
    - Model analyzes user request and calls `select_active_intent({ intent_id })`.
    - Hook + tool handler load `active_intents.yaml` and return `<intent_context>` containing **owned_scope** and **constraints**.
    - Task state is updated: `task.activeIntentId = intent_id`.
- **Stage B — Contextualized action**
    - Model performs mutating tools (`write_to_file`, `apply_patch`, etc.) now operating under injected constraints.
    - Hook engine appends trace entries linking the mutation to the intent.

This is designed to be extendable in Phase 2 with: **scope enforcement**, **HITL approvals**, and **intent ignore rules**.

## Failure modes & mitigations (beyond “intent missing”)

The hook system must remain safe and predictable under partial failures. Below are key failure modes and the expected behavior.

### Intent + context failure modes

- **Missing `active_intents.yaml`**

    - **Symptom**: `select_active_intent` can’t find constraints/scope.
    - **Behavior**: Still sets `task.activeIntentId`, returns a message instructing how to add the intent to the file (current behavior).
    - **Mitigation (planned)**: auto-scaffold a minimal record in `active_intents.yaml` on first selection (merge rather than overwrite).

- **Malformed `active_intents.yaml`**

    - **Symptom**: parser returns `[]`, intent lookup fails silently.
    - **Behavior**: tool returns “Active intent set… add to file…” (safe fallback) but governance becomes weaker due to missing constraints.
    - **Mitigation (planned)**: strict YAML parser + explicit tool_result error that asks user/agent to fix the file, plus “safe mode” that blocks destructive tools when intent metadata cannot be loaded.

- **Invalid intent ID (not present in YAML)**

    - **Behavior**: allow selection but return “Add to YAML…” (current).
    - **Mitigation (planned)**: require the intent ID to exist for destructive tools; otherwise block with “Invalid intent_id”.

- **Context token limits / overlong intent context**
    - **Symptom**: `<intent_context>` becomes too large (many constraints, large scope, long trace history).
    - **Mitigation (planned)**:
        - compact serialization (only constraints + scope, no historical dumps by default)
        - size budget (e.g., truncate to N chars; include a `context_truncated=true` flag)
        - progressive disclosure (agent can request more via read tools if needed)

### Tool execution + hook engine failure modes

- **Hook engine throws (pre or post hook crash)**

    - **Risk**: tool execution could proceed without governance if errors are swallowed.
    - **Mitigation (planned)**: fail-closed policy for destructive tools (if hook fails, block tool and emit structured error).

- **MCP tool calls bypass hook wrapper**

    - **Current**: `mcp_tool_use` path is not wrapped by hooks in the interim.
    - **Risk**: destructive MCP tools could mutate without intent enforcement.
    - **Mitigation (planned)**: wrap `useMcpToolTool.handle` in `runWithHooks` and classify MCP tools as safe/destructive based on tool metadata.

- **Trace write failures (`agent_trace.jsonl` append fails)**
    - **Risk**: governance enforcement works but audit trail is incomplete.
    - **Mitigation (planned)**: best-effort append with telemetry/logging + “trace degraded mode” flag surfaced to the UI; optionally block destructive tools if trace cannot be written (strict mode).

### Concurrency / consistency failure modes (Phase 4 alignment)

- **Stale file writes in parallel sessions**
    - **Symptom**: last writer wins, overwriting newer changes.
    - **Mitigation (planned)**: optimistic locking (compare pre-read hash of file-on-disk vs current before write; block with “Stale File” error).

### Security boundary failure modes

- **Destructive command execution without intent**
    - **Mitigation**: current `requireActiveIntent` blocks destructive tools when `activeIntentId` is missing.
    - **Mitigation (planned)**: add HITL approval prompts for high-risk tools and enforce owned_scope checks for file mutations.

## Visual System Blueprint (Diagrams)

### High-Level Flow with Data Payloads

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         User / Webview (UI Layer)                        │
│  Emits: { type: "user_message", content: "Refactor auth middleware" }  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    ClineProvider (State Management)                     │
│  - Creates Task instance                                                │
│  - Manages webview messaging                                            │
│  - Holds MCP hub, settings                                              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │ Task instance created
                                │ { taskId, cwd, mode, activeIntentId: undefined }
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Task (Conversation State)                        │
│  - Holds: taskId, activeIntentId, API handler, history                  │
│  - Streams assistant content blocks                                     │
│  - Manages: activeIntentId (set by select_active_intent tool)           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │ Streams: { type: "tool_use", name: "...", params: {...} }
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              presentAssistantMessage (Tool Execution Router)            │
│  Processes each content block from assistant stream                     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                │                               │
        tool_use block                  mcp_tool_use block
                │                               │
                │ { name, params, id }           │
                ▼                               ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│   HookEngine.runWithHooks()   │   │  useMcpToolTool.handle()       │
│                                │   │  (No hook wrapper in interim) │
│  HookContext:                  │   └───────────────────────────────┘
│  { taskId, activeIntentId,     │
│    toolName, params, ... }     │
└───────────────┬───────────────┘
                │
                │ Pre-Hooks Phase
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Pre-Hook: requireActiveIntent                   │
│  Input: HookContext { toolName: "write_to_file", activeIntentId: null } │
│  Logic: if (destructive && !activeIntentId) → BLOCK                     │
│  Output: { allow: false, message: "No active intent selected..." }      │
└───────────────────────────────┬─────────────────────────────────────────┘
                │               │
                │ allow: true   │ allow: false
                │               │
                ▼               ▼
┌───────────────────────────┐   ┌───────────────────────────────┐
│  Pre-Hook: hashMutation    │   │  Push tool_result error to UI │
│  Input: mutationSummary    │   │  Skip tool execution          │
│  Output: contentHash      │   └───────────────────────────────┘
└───────────────┬───────────┘
                │
                │ All pre-hooks passed
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Tool Execution (switch block.name)                    │
│                                                                           │
│  case "select_active_intent":                                            │
│    Input: { intent_id: "INT-001" }                                      │
│    → Sets task.activeIntentId = "INT-001"                               │
│    → Reads .orchestration/active_intents.yaml                          │
│    → Returns: <intent_context>                                          │
│              <intent_id>INT-001</intent_id>                             │
│              <owned_scope>src/auth/**</owned_scope>                    │
│              <constraints>Must maintain backward compatibility</constraints>│
│              </intent_context>                                          │
│                                                                           │
│  case "write_to_file":                                                  │
│    Input: { path: "src/auth/middleware.ts", content: "..." }          │
│    → Validates activeIntentId exists (pre-hook already checked)        │
│    → Writes file to disk                                                │
│                                                                           │
│  case "apply_patch" | "edit" | "execute_command" | ...                 │
│    → Similar pattern                                                    │
└───────────────┬───────────────────────────────────────────────────────────┘
                │
                │ Post-Hooks Phase
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Post-Hook: syncActiveIntent                        │
│  Input: HookContext { activeIntentId: "INT-001", cwd: "/workspace" }    │
│  Action: Updates .orchestration/active_intents.yaml                     │
│  Writes:                                                               │
│    active_intents:                                                     │
│      - id: "INT-001"                                                   │
│        name: "INT-001"                                                 │
│        status: "IN_PROGRESS"                                           │
└───────────────┬───────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Post-Hook: writeTrace (Automatic)                     │
│  Input: HookContext + HookResult                                        │
│                                                                           │
│  If intent_id + content_hash exist:                                     │
│    → Writes TRP1 schema to .orchestration/agent_trace.jsonl:            │
│      {                                                                   │
│        "id": "uuid-v4",                                                 │
│        "timestamp": "2026-02-18T...",                                  │
│        "files": [{                                                      │
│          "relative_path": "src/auth/middleware.ts",                    │
│          "conversations": [{                                           │
│            "ranges": [{                                                │
│              "content_hash": "sha256:a8f5f167f44f4964e6c998dee827110c" │
│            }],                                                          │
│            "related": [{                                                │
│              "type": "specification",                                  │
│              "value": "INT-001"                                         │
│            }]                                                           │
│          }]                                                             │
│        }]                                                               │
│      }                                                                   │
│                                                                           │
│  Otherwise:                                                              │
│    → Writes flat HookTraceEntry for all tool calls                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Handshake Sequence (Intent Selection Flow)

```
┌──────────┐         ┌──────────┐         ┌──────────────┐         ┌──────────────┐
│   User   │         │   Task   │         │ HookEngine   │         │.orchestration│
└────┬─────┘         └────┬─────┘         └──────┬───────┘         └──────┬───────┘
     │                    │                       │                        │
     │ "Refactor auth"    │                       │                        │
     ├───────────────────►│                       │                        │
     │                    │                       │                        │
     │                    │ Streams tool_use:    │                        │
     │                    │ select_active_intent │                        │
     │                    ├──────────────────────►│                        │
     │                    │ { intent_id: "INT-001" }                       │
     │                    │                       │                        │
     │                    │                       │ Pre-hook: allow        │
     │                    │                       │ (select_active_intent   │
     │                    │                       │  is not destructive)   │
     │                    │                       │                        │
     │                    │ Execute tool:        │                        │
     │                    │ SelectActiveIntentTool│                       │
     │                    ├──────────────────────┤                        │
     │                    │                       │                        │
     │                    │                       │ Read active_intents.yaml│
     │                    │                       ├───────────────────────►│
     │                    │                       │                        │
     │                    │                       │◄───────────────────────┤
     │                    │                       │ [{ id: "INT-001",      │
     │                    │                       │   owned_scope: [...],  │
     │                    │                       │   constraints: [...] }]│
     │                    │                       │                        │
     │                    │◄──────────────────────┤                        │
     │                    │ XML: <intent_context> │                        │
     │                    │   <intent_id>INT-001</intent_id>              │
     │                    │   <owned_scope>src/auth/**</owned_scope>     │
     │                    │   <constraints>...</constraints>               │
     │                    │ </intent_context>                             │
     │                    │                       │                        │
     │                    │ Sets:                │                        │
     │                    │ task.activeIntentId = "INT-001"               │
     │                    │                       │                        │
     │                    │                       │ Post-hook: syncActiveIntent│
     │                    │                       ├───────────────────────►│
     │                    │                       │                        │
     │                    │                       │◄───────────────────────┤
     │                    │                       │ Write active_intents.yaml│
     │                    │                       │                        │
     │                    │◄──────────────────────┤                        │
     │                    │ tool_result:          │                        │
     │                    │ "Active intent set..."│                        │
     │                    │                       │                        │
     │                    │ Now agent can call    │                        │
     │                    │ write_to_file with   │                        │
     │                    │ context loaded       │                        │
     │                    │                       │                        │
     │                    │ Streams tool_use:     │                        │
     │                    │ write_to_file         │                        │
     │                    ├──────────────────────►│                        │
     │                    │ { path: "src/auth/...", content: "..." }      │
     │                    │                       │                        │
     │                    │                       │ Pre-hook: requireActiveIntent│
     │                    │                       │ Checks: activeIntentId exists│
     │                    │                       │ ✓ allow: true          │
     │                    │                       │                        │
     │                    │ Execute: WriteToFileTool│                     │
     │                    │                       │                        │
     │                    │                       │ Post-hook: writeTrace  │
     │                    │                       ├───────────────────────►│
     │                    │                       │                        │
     │                    │                       │◄───────────────────────┤
     │                    │                       │ Append agent_trace.jsonl│
     │                    │                       │ with TRP1 schema        │
     │                    │                       │                        │
     │                    │◄──────────────────────┤                        │
     │                    │ tool_result: "File written"                    │
     │                    │                       │                        │
     │◄───────────────────┤                       │                        │
     │ File updated       │                       │                        │
     │                    │                       │                        │
```

### Hook Middleware Boundary (Security & Governance)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Extension Host (Privileged Layer)                      │
│  - Can execute file system operations                                    │
│  - Manages API keys, secrets                                              │
│  - Executes MCP tools                                                     │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
                                │ Tool execution request
                                │ HookContext { toolName, params, activeIntentId, ... }
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    Hook Engine (Middleware Boundary)                     │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Pre-Hook Phase (Authorization & Validation)                    │   │
│  │                                                                   │   │
│  │ 1. requireActiveIntent                                          │   │
│  │    Input: { toolName: "write_to_file", activeIntentId: null }   │   │
│  │    Logic: if (classifyTool(toolName) === "destructive" &&       │   │
│  │            !activeIntentId)                                      │   │
│  │    Output: { allow: false, message: "No active intent..." }     │   │
│  │                                                                   │   │
│  │ 2. hashMutation                                                 │   │
│  │    Input: { mutationSummary: "..." }                            │   │
│  │    Logic: contentHash = SHA256(canonicalize(mutationSummary))   │   │
│  │    Output: { contentHash: "sha256:..." }                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                │                                         │
│                    ┌────────────┴────────────┐                           │
│                    │                         │                           │
│            allow: true              allow: false                         │
│                    │                         │                           │
│                    ▼                         ▼                           │
│        ┌───────────────────┐   ┌──────────────────────────┐           │
│        │ Execute Tool      │   │ Return Error to Agent     │           │
│        │ (switch block.name)│   │ Push tool_result: error   │           │
│        └─────────┬─────────┘   └──────────────────────────┘           │
│                  │                                                     │
│                  │ Tool execution completes                            │
│                  ▼                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Post-Hook Phase (Side Effects & Traceability)                    │   │
│  │                                                                   │   │
│  │ 1. syncActiveIntent                                              │   │
│  │    Input: { activeIntentId: "INT-001", cwd: "/workspace" }     │   │
│  │    Action: Write/update .orchestration/active_intents.yaml     │   │
│  │                                                                   │   │
│  │ 2. writeTrace (Automatic)                                       │   │
│  │    Input: HookContext + HookResult                                │   │
│  │    Action: Append to .orchestration/agent_trace.jsonl           │   │
│  │    Schema:                                                        │   │
│  │      - If intent_id + content_hash: TRP1 AgentTraceEntryTRP1   │   │
│  │      - Otherwise: Flat HookTraceEntry                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
                                │ HookResult { allow, message }
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    Tool Result Returned to Agent                          │
│  - Success: tool_result with file content or operation result            │
│  - Error: tool_result with error message (e.g., "No active intent...")  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Data Flow: Intent Context Injection

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    .orchestration/active_intents.yaml                    │
│                                                                           │
│  active_intents:                                                         │
│    - id: "INT-001"                                                       │
│      name: "JWT Authentication Migration"                               │
│      status: "IN_PROGRESS"                                              │
│      owned_scope:                                                       │
│        - "src/auth/**"                                                   │
│        - "src/middleware/jwt.ts"                                        │
│      constraints:                                                       │
│        - "Must not use external auth providers"                         │
│        - "Must maintain backward compatibility with Basic Auth"          │
│      acceptance_criteria:                                               │
│        - "Unit tests in tests/auth/ pass"                               │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │ loadActiveIntents(orchestrationDir)
                                │ Called by SelectActiveIntentTool.execute()
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    SelectActiveIntentTool                                 │
│                                                                           │
│  Input: { intent_id: "INT-001" }                                         │
│                                                                           │
│  Steps:                                                                   │
│  1. Set task.activeIntentId = "INT-001"                                 │
│  2. Load intents from YAML                                               │
│  3. Find matching intent by id                                          │
│  4. Construct XML context block                                         │
│                                                                           │
│  Output (pushToolResult):                                                │
│    "Active intent set to INT-001.                                       │
│                                                                           │
│    <intent_context>                                                     │
│    <intent_id>INT-001</intent_id>                                       │
│    <name>JWT Authentication Migration</name>                             │
│    <owned_scope>src/auth/**, src/middleware/jwt.ts</owned_scope>       │
│    <constraints>Must not use external auth providers; Must maintain      │
│    backward compatibility with Basic Auth</constraints>                 │
│    </intent_context>"                                                   │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                │ XML context injected into conversation
                                │ Agent now has constraints and scope
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    Subsequent Tool Calls                                 │
│                                                                           │
│  Agent calls write_to_file:                                              │
│    { path: "src/auth/middleware.ts", content: "..." }                   │
│                                                                           │
│  Pre-hook checks:                                                        │
│    ✓ activeIntentId exists ("INT-001")                                   │
│    ✓ Tool is destructive → requires intent                               │
│    → allow: true                                                         │
│                                                                           │
│  File written successfully                                               │
│                                                                           │
│  Post-hook writes trace:                                                 │
│    {                                                                      │
│      "intent_id": "INT-001",                                            │
│      "content_hash": "sha256:...",                                       │
│      "related": [{ "type": "specification", "value": "INT-001" }]      │
│    }                                                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

## Deliverable checklist (interim + final)

- [x] Fork Roo Code and run in Extension Host.
- [x] Trace tool loop: **presentAssistantMessage** → **switch (block.name)** → tool.handle().
- [x] Locate prompt builder: **system.ts** + **sections/**; intent-first rule in **objective.ts**.
- [x] **src/hooks/** with HookEngine, classifier, sidecarWriter, types.
- [x] **select_active_intent** tool and context injection from **active_intents.yaml**.
- [x] Pre-hook: block mutating tools when **activeIntentId** is missing.
- [x] Pre-hook: **scope enforcement** — destructive tools blocked if target file is outside intent **owned_scope**.
- [x] Post-hook: append **agent_trace.jsonl** (flat + TRP1 schema with content_hash, vcs.revision_id, mutation_class).
- [x] **.orchestration/** sidecars: **active_intents.yaml**, **agent_trace.jsonl**, **intent_map.md**, **CLAUDE.md** (scaffolded on first intent selection); **appendLesson()** helper for Phase 4.
- [ ] Phase 2 (optional): HITL approval inside hook (beyond existing tool askApproval), .intentignore.
- [ ] Phase 3 (optional): Model-provided **mutation_class** (AST_REFACTOR vs INTENT_EVOLUTION) via tool params.
- [ ] Phase 4 (optional): Optimistic locking (stale file detection), automatic lesson recording on test/lint failure.

---

## Complete report: detailed schemas, architecture, and notes

### Schemas

**active_intents.yaml (Intent Specification)**

- **Purpose:** Lifecycle of business requirements; why we are working.
- **Updated by:** Pre-hooks (agent picks task), Post-hooks (task complete).
- **Structure:**
    - `active_intents`: list of intents.
    - Per intent: `id`, `name`, `status` (e.g. IN_PROGRESS | DONE | BLOCKED), `owned_scope` (glob-like paths), `constraints`, `acceptance_criteria`.

**agent_trace.jsonl (Ledger)**

- **Purpose:** Append-only, machine-readable history linking Intent → Code Hash → Agent Action (spatial independence).
- **Updated by:** Post-hook after file writes.
- **TRP1 schema (one JSON object per line):**
    - `id`: UUID.
    - `timestamp`: ISO 8601.
    - `vcs`: `{ "revision_id": "<git_sha>" }`.
    - `files`: array of `{ "relative_path": string, "conversations": [ { "url": task/session id, "contributor": { "entity_type": "AI", "model_identifier": string }, "ranges": [ { "start_line"?, "end_line"?, "content_hash": "sha256:...", "mutation_class"?: "AST_REFACTOR"|"INTENT_EVOLUTION" } ], "related": [ { "type": "specification", "value": "<intent_id>" } ] } ] }`.

**intent_map.md (Spatial Map)**

- **Purpose:** Maps intents to physical files (“Where is the billing logic?”).
- **Updated by:** Post-hook when a file is written under an intent (`updateIntentMap`).
- **Format:** Markdown list: `- **INT-001** → \`path/to/file\``.

**CLAUDE.md (Shared Brain)**

- **Purpose:** Persistent knowledge base: project rules, lessons learned, session notes; shared across Architect/Builder/Tester.
- **Updated by:** Scaffolded on first intent selection; appended via `appendLesson()` (e.g. on verification failure).

### Architecture in one place

- **Extension Host** runs the hook engine and tools; **Webview** is presentation only.
- **Single choke point:** All native tool execution goes through `presentAssistantMessage` → `HookEngine.runWithHooks` → `switch (block.name)` → tool.handle().
- **Pre-hooks:** `requireActiveIntent` (block destructive if no intent), `hashMutation` (content hash), `enforceOwnedScope` (block if file outside intent’s owned_scope).
- **Post-hooks:** `syncActiveIntent` (write/merge active_intents.yaml), and inside trace flow: `writeTrace` (append agent_trace.jsonl, TRP1 when intent+hash present) and `updateIntentMap` (append intent → file to intent_map.md).
- **.orchestration/** is the sidecar directory (workspace root); all four artifacts are machine-managed and cross-referenced by intent ID and file paths.

---

## Detailed breakdown: Agent flow and implemented hook

1. **User sends a message** (e.g. “Refactor the auth middleware”) → ClineProvider creates/uses a Task; message goes to the model.
2. **Model streams content blocks.** For each block, `presentAssistantMessage` runs.
3. **Block type `tool_use`:**
    - Build `HookContext` (taskId, activeIntentId, toolName, params, cwd, timestamp).
    - Instantiate `HookEngine` with pre-hooks `[requireActiveIntent, hashMutation, enforceOwnedScope]` and post-hooks `[syncActiveIntent]`; trace writing is inside the engine after execute.
4. **Pre-hook phase (in order):**
    - **requireActiveIntent:** If tool is destructive and `activeIntentId` is missing → return `{ allow: false }`, push tool_result error “No active intent selected…”, skip execution, run post-hooks and write trace (denial).
    - **hashMutation:** If mutationSummary present, set contentHash (SHA-256).
    - **enforceOwnedScope:** If destructive and intent has owned_scope, resolve target file from params; if file outside scope → `{ allow: false }`, “Scope Violation…”, skip execution, post-hooks + trace.
5. **Execute:** If all pre-hooks allow, run `switch (block.name)` (e.g. `select_active_intent`, `write_to_file`, `apply_patch`, …).
    - **select_active_intent:** SelectActiveIntentTool runs: set `task.activeIntentId`, load `active_intents.yaml`, return `<intent_context>` XML; no file write.
    - **write_to_file / apply_patch / etc.:** Corresponding tool runs (e.g. WriteToFileTool); may ask user approval; writes to disk.
6. **Post-hook phase:**
    - **syncActiveIntent:** If activeIntentId and cwd set, update `.orchestration/active_intents.yaml` (and ensure intent_map.md + CLAUDE.md exist).
    - **Trace:** `buildTraceEntry` + `writeTrace`: append to `agent_trace.jsonl` (flat or TRP1 with intent_id, content_hash, vcs.revision_id, mutation_class); if TRP1 and file path present, call `updateIntentMap` to append intent → file to `intent_map.md`.
7. **Result:** Tool result (or error) is pushed to the conversation; stream continues.  
   So: every mutating tool is gated by intent and scope, and every such action is traced and reflected in the intent map; the shared brain (CLAUDE.md) is scaffolded and can be appended to for lessons.

---

## Summary of what has been achieved

- **Phase 0:** Mapped the extension (entry, provider, task, tool loop, prompt builder); documented in ARCHITECTURE_NOTES.
- **Phase 1:** Implemented the Reasoning Loop: `select_active_intent(intent_id)` tool; context injection from `active_intents.yaml` into `<intent_context>`; gatekeeper pre-hook so destructive tools are blocked without an active intent; prompt change so the agent must call select_active_intent before mutating.
- **Phase 2 (core):** Hook engine as middleware (pre/post hooks); tool classification (safe vs destructive); scope enforcement so destructive tools only touch files in the active intent’s `owned_scope`; clear error messages for “no intent” and “scope violation”.
- **Phase 3 (core):** Append-only `agent_trace.jsonl` with TRP1 schema: intent_id, content_hash (SHA-256), vcs.revision_id, mutation_class in ranges; intent_map.md updated on write so artifacts stay cross-referenced; spatial independence via content hashing.
- **.orchestration/ artifacts:** Repo includes a `.orchestration/` directory from a real run: **active_intents.yaml** (multiple intents, diverse statuses), **agent_trace.jsonl** (multi-session trace entries), **intent_map.md** (intent → files), **CLAUDE.md** (shared brain: rules, lessons, session notes). All four are machine-managed and internally consistent.
- **Documentation:** ARCHITECTURE_NOTES contains theoretical grounding (Cognitive Debt, Trust Debt, Context Rot), blueprint diagrams with data payloads, failure modes and mitigations, detailed schemas, and a step-by-step agent and hook breakdown.
- **Codebase:** Clean `src/hooks/` (HookEngine, types, classifier, sidecarWriter); SelectActiveIntentTool; hook wiring in presentAssistantMessage; no mutating tool execution outside the hook path.
