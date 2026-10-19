# Planning and goal-breakdown agent

The desktop Chat page has **Ask my notes** (existing RAG), **Plan my day** (schedule existing tasks), and **Break down a goal** (suggest new tasks). Requests for a checklist or "what tasks do I need?" in Plan my day also route to goal breakdown. Both agent flows inspect existing work, optionally search notes, and return a proposal. New tasks or date changes require explicit user approval. The model cannot delete work, mark tasks complete, browse the web, or execute commands.

## Request and tools

The form supplies a date, 5–480 available minutes, an optional session preference, and the latest message. Up to two previous planning summaries and their proposed task durations provide session context. Current tasks and notes are fetched again through tools; previous conversation is not authoritative application state.

The selected local chat model chooses one structured JSON tool request per turn:

- `list_tasks`: up to 40 unfinished tasks, sorted by planned day and creation time; an optional query filters titles. Reports truncation. Completed tasks are excluded.
- `get_task`: details of a task already returned by `list_tasks`; note text is limited to 1,200 characters.
- `search_notes`: at most one hybrid search over the selected notes folder or all notes, using the existing BM25/vector/RRF pipeline. No second answer-generation call is needed. The task list is workspace-wide regardless of notes scope.
- `propose_plan`: one to eight distinct inspected task IDs, estimated durations, and reasons. The backend supplies actual titles and prior planned dates, checks total time against the budget, and returns an opaque approval token.
- `propose_tasks`: in goal-breakdown mode, one to six new task titles and notes, a summary, and up to five assumptions. The backend assigns IDs, omits duplicate/existing titles, and returns an approval token. This tool is not available for ordinary day scheduling. It never adds tasks by itself.
- `ask_user`: return a clarification without a plan or approval token.

The model has no write tool. `agent:apply` and `agent:undo` are separate IPC handlers reached by review-card buttons, not tools exposed to the model. Application code validates tool names, strict argument schemas, task eligibility, duplicate IDs, budgets, and source scope. The agent uses structured JSON decisions because a small local model's native tool-calling support may vary.

## Review and changes

The plan card lists selected tasks in suggested order, estimated minutes, reasons, and old/new dates. It also exposes a tool activity log and consulted passages. Users can dismiss it or change their request, budget, date, or session preference and generate a new proposal. Direct item editing is not implemented.

Applying a plan saves **only planned dates** and update timestamps for the selected tasks. The current task schema has no persistent duration, priority, or within-day order fields. Those suggestions remain in the chat. A planned date is not a deadline.

A goal-checklist card shows suggested titles, descriptions, assumptions, and any consulted passages. **Add tasks** creates exactly those tasks in **Later**, with no planned date, completion mark, or duration. Existing tasks remain unchanged. Notes record that these are AI suggestions, the user's goal, and assumptions to verify. This is a project checklist, not a promise to finish the entire goal within the day-planning budget. Dismiss or request a revised checklist if the suggestions need changes; direct item editing is not implemented. Undo removes the additions only if the workspace has no newer edits.

The goal-generation prompt omits the scheduling date and numeric day budget. A limited English parser recognizes explicit domain choices such as "on second domain" and presents them separately as stated constraints. When one domain was selected, common cross-domain formulations are rejected and can use the single correction attempt. This targeted check prevents the reported "combine both domains" mistake; it is not general semantic verification of all user constraints or task descriptions.

Approval tokens expire after 30 minutes, are single-use, and are held only in main-process memory. A fingerprint of the entire workspace must still match the planning snapshot. Application saves and agent writes use the same main-process queue. The renderer waits for its save queue and prevents concurrent edits during apply/undo. A complete recovery backup is required before either write.

The applied card shows an action receipt and offers Undo for 30 minutes in the current session. Undo requires the entire workspace to match the post-apply state; it refuses to overwrite subsequent edits. It restores the previous workspace through the normal validated save path. There is no permanent agent audit-log database. Closing/reloading Chat clears visible conversation; restarting the application also clears approvals and undo tokens. The normal backup files persist independently.

## Bounds and remaining limitations

- Eight model/tool decisions, a three-minute overall timeout, one notes search, bounded prompt/result sizes, and a user Stop control. One rejected-response correction is allowed inside the same eight-decision budget, including malformed arguments, duplicate/over-budget scheduling proposals, and detected domain-scope conflicts. A repeated rejected response returns a clarification with no approval token. There are no automatic tool-execution retries or background jobs. Small models may still fail or ask for clarification; the application does not relax write permissions or time limits to force a result.
- Tool arguments are validated according to the selected tool. Unused fields are discarded rather than allowing irrelevant malformed plan placeholders to break a clarification. Task IDs offered in structured generation are restricted to tasks actually inspected; backend eligibility checks still run before any proposal is accepted.
- Research task breakdowns do not require uploaded documents: the model can suggest general actions based on the stated goal. Missing event facts should become verification tasks or explicit assumptions, rather than invented rules. A selected domain should be respected, not re-selected. Neither mode performs internet research or verifies current hackathon rules.
- A conservative English routing check recognizes checklist/task-breakdown wording before the broader research scope check. **Break down a goal** explicitly selects this behavior without relying on keyword routing. Broad requests for research or explanations without a task-breakdown or scheduling request still clarify. The clarification card offers **Ask my notes instead** and keeps the original question without submitting it. This heuristic does not guarantee correct interpretation of every request.
- Ollama remains restricted to localhost; model capability checks exclude declared cloud models. No additional model is downloaded by this feature.
- Retrieved passages, task notes, titles, and previous conversation are explicitly marked as untrusted data. The system prompt tells the model not to follow embedded instructions. This reduces prompt-injection risk but cannot prove model compliance. Structural permission checks and approval-before-write remain necessary even if the model is misled.
- Session preferences are instructions to the model, not hard scheduling constraints enforced by a parser. The overall numeric time budget is enforced in code. No persistent saved preference or vector memory of chat messages is implemented.
- Estimates, suggested tasks, task selection, assumptions, and reasons may be poor or unsupported. Consulted passages are shown for inspection, not represented as semantic proof of each recommendation. Suggested new tasks are not automatically saved. No verified extraction of event requirements is claimed.
- Safety tests use deterministic model fixtures and isolated databases. They verify enforcement, not universal model reasoning or injection resistance. Live QA should also use synthetic data, never the personal workspace.

## Validation

Run `npm run typecheck`, `npm test`, and `npm run build`. With the configured Qwen and Nomic models installed and Ollama running, `node scripts/agent-qa.cjs` exercises live planning, review, apply, navigation, undo, narrow layout, and Stop in a path-verified isolated workspace. The script deletes its own temporary fixtures on completion.

`node scripts/agent-research-qa.cjs` checks a conversational hackathon research request with no matching task/brief, safe recovery from two deliberately malformed model responses, and switching to note search without changing any tasks. The scope clarification is deterministic; normal live-model tool use is tested by `agent-qa.cjs`. These checks are not a guarantee that every unsupported request will be correctly classified.

`node scripts/agent-breakdown-qa.cjs` uses the reported conversational hackathon task-list request with an unrelated existing task and no imported brief. It checks that the live model returns a new-task checklist, proposals leave data untouched, approval adds unscheduled tasks to Later, unrelated tasks are preserved, and Undo restores the original fixture.
