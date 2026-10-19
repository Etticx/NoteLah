# NoteLah: product, technology, and learning plan

Planning baseline: 19 October 2026. This document describes the inspected application and a proposed expansion. Proposed features, models, and measurements are not implemented results.

Product baseline confirmed by the owner: **NoteLah currently provides task tracking only. Notes are a new capability to design and build.** Any note-related field found in the source is an implementation detail to assess during migration, not evidence of a delivered notes feature.

Implementation update after this planning baseline: Notes implements folders, written notes, TXT/Markdown/PDF imports, complete file-aware backup/restore, and storage information. Chat implements hybrid RAG and a bounded day-planning agent. See [Notes storage](NOTES_STORAGE.md), [RAG](RAG.md), and [agent implementation](AGENT.md) for the current design and checks. Task-to-note links remain future work. The sections below preserve the original roadmap and baseline for learning purposes.

## 1. What we are building toward

**A local personal workspace that connects tasks and notes, answers questions with traceable sources, and helps the user turn those answers into a practical plan.**

The learning objective is to understand and explain each layer: interface, desktop boundary, data storage, retrieval, model requests, tool execution, and evaluation. The portfolio objective is a working application with reproducible evidence for its claims.

Use one demonstration throughout development:

> "Use my supervisor's latest feedback and unfinished degree-project tasks to suggest what I should do in the two hours I have today."

Success means finding the correct notes, respecting real task dates and available time, showing the supporting sources, proposing changes, and applying only the changes the user accepts.

## 2. What exists today

### Product capabilities

- Today and Later task views, planned dates, task completion, and bringing unfinished work forward.
- Profile editing and an activity grid derived from completion history.
- Task search in the inspected implementation.
- Desktop SQLite storage, automatic daily backups retaining seven daily snapshots, manual backup, backup-folder selection, and a recovery copy before restoring.
- JSON and CSV export; desktop restore from supported SQLite or JSON backups.
- A browser version with IndexedDB storage and separate browser backup/export behavior.
- A packaged portable Windows executable, with taskbar relaunch handling for its temporary extracted executable.

Task-associated notes, standalone notes, folders, note-to-task links, semantic retrieval, AI chat, agents, due dates, effort estimates, dependencies, and Gantt charts are proposed additions. The current product should be presented as a task tracker.

Ollama and Qwen were set up separately during the earlier session. They are **not connected to NoteLah's application code**. Their current availability must be checked when integration begins.

### Current technology and what each part does

- **TypeScript 7.0.2:** shared application types, strict checking, and desktop code compilation. TypeScript checks development-time assumptions; it does not validate arbitrary runtime input by itself.
- **React 19.3.0:** component rendering, UI state, forms, and interactions. Most application behavior currently lives in `src/components/workspace.tsx`.
- **Next.js 16.4.0:** builds the React interface as a static export. The packaged app serves those generated files through a custom `notelah://app/` protocol. There is no running Next.js API server in the packaged desktop app.
- **Plain CSS, Radix Dialog/Dropdown, Lucide, and bundled Inter fonts:** styling, UI primitives, icons, and local fonts. The app does not currently use Tailwind.
- **Electron 44.7.0:** provides the desktop window and privileged main process. The renderer has context isolation, sandboxing, and no direct Node integration.
- **Electron preload and IPC:** expose a narrow typed API between the interface and desktop functions. Main-process handlers check the sender; runtime data still needs validation there.
- **SQLite through sql.js 1.14.2 / WebAssembly:** the desktop database is loaded into memory, changed using SQL, then exported to a local `.sqlite` file. The current save operation replaces all task rows and exports the entire database.
- **Zod 4.6.6:** validates workspace data, dates, and imported backups at runtime.
- **IndexedDB:** browser-only persistence. It is separate from the desktop database.
- **Node.js file APIs:** desktop persistence, temporary-file replacement, exports, backups, and restore operations.
- **Node's test runner, assert, and tsx:** existing data tests cover persistence, restore safety, invalid imports, CSV, dates, backup failure, and retention.
- **Playwright Core:** installed for browser/desktop checks; existing ad hoc QA scripts live under ignored `work/`. It is not currently a continuous-integration suite.
- **electron-builder 26.15.3:** packages the portable Windows executable.

Versions above come from `package.json`, not a fresh dependency-upgrade recommendation. Git is available for version history. No hosted CI pipeline was found in the inspected project files.

### Trace one action before changing the architecture

Follow an edited task through:

`workspace.tsx -> storage.ts -> window.notelah -> preload.ts IPC -> main.ts -> DatabaseStore.save -> sql.js -> atomicWrite -> notelah.sqlite`

For the browser version, the storage adapter writes to IndexedDB instead. Be able to explain where the two paths diverge.

### Important limitations discovered

1. The current model has a **planned date**, not a distinct due date. Deadline-aware planning requires a separate field.
2. Whole-workspace saves are convenient for a small tracker. Notes, chat history, and embeddings increase the cost of loading and rewriting everything.
3. An in-memory capability check of the installed sql.js build found FTS4 available, FTS5 unavailable, and `OMIT_LOAD_EXTENSION`. Do not assume a native SQLite vector extension can be loaded into this build. This check did not open the user's database.
4. The browser and desktop data stores are separate. The first AI release should target the desktop app; browser AI support is a later product decision.
5. The earlier first-response check took about 95 seconds. It is one historical cold-start observation, not a representative speed benchmark.

## 3. Proposed technology decisions

### Keep the existing application stack

Continue with React, TypeScript, Next.js static export, Electron, Zod, and SQLite. Use the Electron main process for Ollama requests through a fixed local endpoint, with typed IPC to the renderer. A separate Python/FastAPI service is not needed for the first release.

Keep ordinary task and note editing available when Ollama is missing or stopped. Return a clear connection/model-status message for AI features.

### Keep original records and search data distinct

The main SQLite database remains authoritative for tasks, notes, folders, relationships, accepted plans, and saved chats. Search chunks and embeddings are derived data that can be rebuilt from those records.

Start with a separate local `search.sqlite` cache managed using sql.js. Store Float32 vector bytes plus their metadata. Run similarity scoring in a Node worker so a scan does not block the Electron main process. This is an **exact vector-search index**, not an approximate-nearest-neighbor database.

Use the available FTS4 module for the lexical retrieval branch, adding an explicit, documented ranking rule. Do not claim built-in FTS5/BM25 support. Compare lexical, vector, and combined retrieval using the same evaluation questions. Reciprocal Rank Fusion is a candidate for combining ranked lists without treating their raw scores as directly comparable.

For a small personal collection, a transparent exact scan is a useful first implementation. Benchmark it at increasing chunk counts before setting a supported limit. If measured search or persistence costs become unacceptable, evaluate native SQLite with an appropriate vector extension, or a dedicated local vector store. Native modules introduce Electron rebuild and Windows packaging work; WASM extensions would require a compatible custom build. Migration is an explicit later decision.

### Use separate generation and embedding models

- **Generation candidate:** the previously installed `qwen3.5:2b-q4_K_M` through Ollama `/api/chat`. It has not been evaluated for this app's retrieval or tool-use tasks.
- **Embedding candidate:** `embeddinggemma:300m` through Ollama `/api/embed`. The current listed download is about 622 MB. Selection is provisional until English and any intended Malay/mixed-language queries are tested, and its license is reviewed for distribution.
- Use the same embedding model/version, dimensions, and documented query/document preprocessing when indexing and searching. Record those settings. Changing them requires rebuilding compatible embeddings.
- Keep Ollama and model files external to the app initially. Do not bundle models inside the portable executable.

The first agent should use a small TypeScript tool loop and Zod validation. Learning the loop directly makes its behavior easier to explain. LangChain/LangGraph can be evaluated later if orchestration requirements justify them.

## 4. Milestones, learning work, and completion checks

### Milestone 0 — Understand and stabilize the foundation

**Build:** a small synthetic development workspace and an architecture walkthrough. Extract storage/domain functions from the large UI component only where the new features need a clear boundary. Capture the current schema and backup format before evolving them.

**Technology:** current TypeScript, React, Electron IPC, sql.js, Zod, Node tests, Git.

**Practise yourself:** trace task creation to the saved file; make a small validation change; write one persistence test; explain renderer/main separation without reading the code.

**Done when:** a new developer can trace the save path; the existing checks pass; synthetic test data is isolated; there is a documented migration and recovery approach.

**Interview questions:** Why use Electron? Why a static Next.js export? What is IPC? Why validate input after TypeScript compilation? What does sql.js change about persistence?

### Milestone 1 — Notes, folders, and task links

**Build:** NoteLah's first notes capability: a Notes area with an Inbox, folders, a title/body editor, and links between notes and tasks. Design task-associated notes and standalone notes as new user-facing features. Start with plain text and flat folders; nested folders and rich editing can follow actual need. Assess any existing note-related source fields for compatibility without assuming a notes feature already exists.

**Technology:** React components and existing CSS; relational SQLite tables; SQL migrations; Zod; parameterized queries. No rich-text-editor dependency is required initially.

**Proposed records:** `folders`, `notes`, and `task_note_links`. A note has a stable ID, optional folder ID, title, body, revision, and timestamps. The link table permits multiple notes per task and reuse of a note across tasks, with unique pairs and deliberate delete behavior.

**Practise yourself:** draw the relationships; implement one create/read/update/delete path; explain the join table; write a migration test from a v1 backup.

**Done when:** existing task data, including any populated legacy fields, survives migration; newly created notes persist across restarts; folder deletion has defined behavior; note deletion removes links; exports, backups, and restore preserve all authoritative new records. Old backups remain importable through a documented migration path. No data migration is performed merely by writing this plan.

**Interview questions:** Why separate task notes and standalone notes? Why a many-to-many link? What is a foreign key? How do you evolve a local schema without losing user data?

### Milestone 2 — Search and the retrieval index

**Build:** lexical search plus semantic search, with source snippets and folder/date filters. Build a reusable retriever before introducing answer generation.

**Technology:** Ollama embedding API; heading/paragraph-aware chunking with a documented fallback for long passages; FTS4; Float32 vectors in the derived search cache; cosine similarity; a worker thread; candidate rank fusion.

**Index metadata:** source type and ID, source revision/content hash, chunk position and text, embedding model identifier, preprocessing/chunker version, dimensions, and indexing status. Choose chunk length/overlap through evaluation; keep passages within the embedding model's input limit and detect truncation.

**Lifecycle:** save original text immediately, then queue indexing. Re-embed only changed content. At retrieval time, exclude stale revisions; deleted notes must not appear. A source becomes available through lexical retrieval while its vector index is pending. Rebuilding the cache must not destroy original notes.

**Practise yourself:** implement and test cosine similarity; hand-check a few vectors; label relevant source IDs for sample questions; explain why keyword matching and similarity fail on different queries.

**Done when:** paraphrased questions find relevant notes; exact identifiers remain searchable; edits/deletions are reflected; index errors are visible and recoverable; ranked results retain traceable source IDs; a baseline comparison is recorded.

**Interview questions:** What is an embedding? What does cosine similarity measure? Why chunk? Why combine lexical and semantic retrieval? Why not use similarity for due-date calculations? When would a vector database be worthwhile?

### Milestone 3 — RAG chat with source links

**Build:** an Ask NoteLah panel that answers questions using retrieved records, displays source snippets/links, and acknowledges missing evidence. Save local chats with a delete option.

**Technology:** Electron main-process Ollama client; `/api/chat`; bounded retrieved context; typed streaming events over preload IPC; cancellation/timeouts; Zod response checks; SQLite `conversations`, `messages`, and evidence references.

**Request path:** user question -> exact filters and/or semantic retrieval -> selected passages with source IDs -> model request -> validate cited IDs -> answer with clickable evidence. Date/status questions use structured queries. A valid citation ID establishes provenance; separate evaluation is needed to judge whether the cited text actually supports the claim.

**Practise yourself:** assemble one prompt from retrieved passages; handle a question with no answer in the notes; explain retrieved knowledge versus the model's training; implement one streaming/cancel path.

**Done when:** source links open the correct records; unknown IDs are rejected; insufficient evidence is acknowledged; chat deletion works; context has a clear budget; the app remains usable when Ollama is offline. Notes are treated as untrusted data, not instructions that grant access to tools.

**Interview questions:** How is this RAG rather than a generic chatbot? How do you measure groundedness? What can citations prove? Why does a larger context window not replace retrieval?

### Milestone 4 — A bounded planning agent

**Build:** an assistant that chooses read tools, inspects their results, and proposes a plan. Add effort estimates, priority, optional due dates, and optional project membership as needed. Keep planned dates and deadlines separate.

**Technology:** Ollama tool calling; TypeScript tool registry; JSON Schema tool descriptions; Zod validation; an explicit bounded loop; pure TypeScript scheduling/constraint checks; SQLite plan proposals, accepted changes, and an action log.

**Initial tools:** `search_notes`, `get_note`, `list_tasks`, and `propose_plan`. Each has a narrow typed contract. The model receives no arbitrary SQL, shell, or filesystem tool.

The model selects relevant tools and sequencing. Code enforces valid IDs, dates, effort totals, availability, and dependency constraints. Missing estimates remain explicit assumptions or trigger a question; the assistant must not invent deadlines. Start with a small configurable limit on tool calls and total time, and test that limit on the laptop.

**Applying changes:** the user reviews a concrete preview. The application rechecks current task/note revisions and commits accepted changes transactionally. Repeated clicks must not duplicate tasks. Record enough information for an undo operation where supported.

**Practise yourself:** implement one tool by hand, log the sequence of tool calls, deliberately return a malformed tool argument, and explain what happens on timeout or stale data.

**Done when:** a plan fits the stated availability; writes require review; malformed calls cause no writes; stale proposals are rejected or refreshed; accepted changes are applied once; failures stop within defined limits. If Qwen 2B cannot reliably select tools, ship the deterministic planning workflow while continuing model/tool evaluation. Describe the implemented behavior accurately.

**Interview questions:** What makes this an agent? What is the difference from a workflow? Who decides the next step? Who authorizes writes? Why validate model output? How do you prevent infinite loops and duplicate actions?

### Milestone 5 — Calendar and optional project timeline

**Build first:** a weekly calendar/time-block view of accepted plans. Shared task records should drive the list and calendar.

**Optional extension:** a read-only Gantt view for multi-day projects after introducing start/due dates, task durations, projects, and dependencies. Distinguish estimated effort from calendar duration and allow tasks with incomplete dates to remain unscheduled.

**Technology:** React, CSS Grid or SVG, existing date utilities, pure TypeScript interval arithmetic and dependency-cycle detection. Choose a timeline library only if custom rendering/interaction requirements justify it. Drag-and-drop editing is a later feature.

**Practise yourself:** write overlap and timezone-boundary tests, explain a dependency cycle, and show how a single accepted task change updates both views.

**Done when:** the calendar represents the accepted plan accurately; overlapping commitments are detected; display dates are consistent; any Gantt view reflects real data. Gantt is a planning interface feature, not a requirement for RAG or agent behavior.

**Interview questions:** How do you model time? What is the difference between effort and duration? How do you detect impossible dependencies? Why is the model not doing date arithmetic itself?

## 5. Evaluation runs alongside every milestone

Create a versioned synthetic dataset that can be shared without exposing personal notes. Start with roughly 30–50 labeled questions and planning cases, then expand based on failures. Keep a held-out subset for comparing changes; avoid tuning only to a demonstration script.

- **Retrieval:** measure Recall@k against labeled relevant source IDs, ranking quality such as MRR where appropriate, and stale/deleted-source leakage. Record k, dataset, preprocessing, and embedding model.
- **Answers:** judge correctness, supported claims, source attribution, and handling of unanswerable questions. Validate citation IDs automatically and review whether their evidence supports the answer.
- **Agent:** measure valid tool arguments, task completion, availability/constraint violations, handling of tool errors, and unauthorized or duplicate mutations. Include instructions embedded inside notes as adversarial cases.
- **Performance:** record cold and warm response latency, retrieval latency, index time, cancellation behavior, RAM/VRAM, and storage. Distinguish model load time from generation time. Choose resource budgets after measuring this laptop.
- **Comparisons:** compare lexical-only, vector-only, and combined retrieval; compare generation with and without retrieved context on answerable and unanswerable cases; compare a fixed planning workflow with the bounded agent on the same cases.

Use TypeScript/Node scripts and the existing test runner first. Promote critical desktop journeys to repeatable Playwright tests using synthetic data. A hosted CI workflow can run deterministic tests and mocked model contracts; live local-model benchmarks are a separate reproducible run, not an assumed capability of hosted CI.

Do not write resume percentages until the dataset, metric, baseline, and actual measured result exist.

## 6. Laptop and storage decisions

Historical hardware check: Ryzen 5 5600H, GTX 1650 with 4 GB VRAM, 24 GB installed RAM with about 20 GB OS-usable at that check. Other running applications affect available resources.

- Index only changed notes, using a cancellable queue. Prefer explicit "index now" or an idle period over embedding on every keystroke.
- Keep embedding and generation workloads sequential initially. Unload models or use a short configurable keep-alive when appropriate; measure the reload/latency tradeoff.
- Cap retrieved passages and tool iterations. Storing chat history does not require sending the entire archive to every model request.
- For scale intuition only: 10,000 chunks x 768 dimensions x 4 bytes is 30,720,000 bytes (about 29.3 MiB) for raw Float32 vectors. Text, database overhead, metadata, in-memory copies, model files, and runtime memory are additional. This is a calculation, not a measured NoteLah index or a promised supported collection size.
- Authoritative records belong in backups. The derived search cache can be rebuilt. Record indexing configuration in a backup or settings record so restore can trigger a compatible rebuild.
- Local storage is not a claim of encryption. The current app has no application-level database encryption.

## 7. How we will learn while building

### Vocabulary you should be comfortable explaining

- **Frontend:** the interface the user sees and interacts with; React fills this role here.
- **Privileged application layer:** Electron's main process handles local files, storage, and model requests. It fills much of the role a server backend would fill in a web application, but runs on this laptop.
- **IPC:** messages between processes. The preload API is the controlled bridge from the interface to desktop operations.
- **Migration:** a repeatable change from an older stored schema/data format to a newer one, with a tested recovery path.
- **Embedding:** a model-produced numeric representation used to compare meaning. Similarity is not a probability that a passage is true or relevant.
- **Vector index:** stored embeddings and a way to search them. Exact scanning and approximate nearest-neighbor indexing have different performance/recall tradeoffs.
- **RAG:** retrieving outside information and supplying it to a generative model when answering. Storing vectors alone is not a complete RAG feature.
- **Context:** the information included in a model request, such as recent messages, retrieved passages, and tool results. Saved chat history and the current context are different things.
- **Tool calling:** the model proposes a function and arguments. Application code validates and executes permitted operations; the model does not acquire unrestricted access to the app.
- **Agent loop:** the model chooses a next action, observes its result, and continues within defined limits. A fixed sequence remains a workflow.
- **Evaluation:** a repeatable way to measure whether a change improved the intended behavior, including cases where the system should decline or stop.

### Working pattern

For each milestone:

1. Explain the problem and sketch the data/request flow before choosing a library.
2. Read the relevant primary documentation and a small part of the existing implementation.
3. Implement one understandable vertical slice and inspect its input/output.
4. Have you write or modify a core function or meaningful test.
5. Review the failure cases, discuss one alternative, and record the tradeoff.
6. Demonstrate the feature with synthetic data and answer its interview questions in your own words.

Keep a short learning journal: decision, reason, alternative, failure observed, evidence, and next improvement. Record architecture decisions such as retaining sql.js, using exact vector search first, choosing an embedding model, and bounding the agent loop. A framework name is not a substitute for explaining the request flow.

## 8. Portfolio and interview evidence

Keep these artifacts as features become real:

- An architecture diagram and a working demonstration using the same supervisor-feedback scenario.
- A schema/migration example, including compatibility with an older backup.
- A visible retrieval inspector showing selected passages and similarity/keyword ranks.
- Source-linked answers and an example where the assistant correctly says there is insufficient evidence.
- A tool trace, a proposed change preview, an accepted action, and a failure that leaves data intact.
- A reproducible evaluation command, labeled fixture data, actual results, and documented limitations.
- A small set of decision notes explaining why this architecture fits a single-user local desktop app.

Today you can describe the existing desktop tracker and local persistence you have reviewed and can explain. After Milestone 3 is built and evaluated, a local RAG claim becomes supportable. After Milestone 4 demonstrates model-directed tool selection and bounded execution, an agent claim becomes supportable. Describe your own work and assistance accurately; only list technologies you used and understand.

## 9. Scope decisions to revisit

- Default assumption: desktop-first AI, plain-text notes, flat folders, one local assistant, and user-reviewed changes.
- Choose the embedding model after retrieval-quality, language, resource, and license checks. No additional model is installed by this planning work.
- Validate Qwen 2B's answer quality and tool use. A larger local model or an explicitly chosen hosted option remains a later tradeoff if the small model fails the required cases.
- Revisit native SQLite/vector tooling only after representative index and save benchmarks. Revisit richer editing, attachments/PDF ingestion, nested folders, cloud sync, and multi-user access separately.
- Gantt is optional. The first complete portfolio release can be notes/folders + source-linked RAG + a reviewed planning agent + a weekly calendar.

## 10. First implementation slice

Start with **Milestone 0 and a minimal Milestone 1**: understand the current save path, design `notes`, `folders`, and `task_note_links`, test migration from the existing format, and ship one standalone note that persists and can link to a task.

This creates the data foundation before adding embeddings or model orchestration. The present deliverable is a plan; no application feature or user database is changed by it.

## Sources and implementation references

Current behavior is based on `package.json`, `next.config.ts`, `electron/main.ts`, `electron/preload.ts`, `electron/database.ts`, `src/lib/model.ts`, `src/lib/storage.ts`, `src/components/workspace.tsx`, and `tests/data.test.ts`. Capability checks used an isolated in-memory sql.js database.

- [sql.js documentation](https://sql.js.org/documentation/) — in-memory SQLite and database import/export.
- [Ollama embeddings API](https://docs.ollama.com/api/embed) — embedding inputs, results, model identity, and keep-alive.
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) — function descriptions, calls, tool results, and follow-up replies.
- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs) — schema-constrained generation. Schema validity does not establish factual accuracy or authorization.
- [EmbeddingGemma listing](https://ollama.com/library/embeddinggemma) and [model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card) — provisional embedding candidate, current download size, intended use, and limitations.
- [SQLite FTS5 documentation](https://sqlite.org/fts5.html) — a possible future search capability, not enabled in this project's current build.
- [sqlite-vec project](https://github.com/asg017/sqlite-vec) — a possible future vector extension requiring compatible integration; currently described by its maintainers as pre-v1.
- [RAG paper](https://arxiv.org/abs/2005.11401) — retrieval combined with generation.
- [Agents and workflows](https://www.anthropic.com/engineering/building-effective-agents) — distinction between predefined orchestration and model-directed tool use.
