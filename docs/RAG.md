# NoteLah local hybrid RAG

Implemented as a desktop-only Chat view. The chat model is Qwen 3.5 2B through local Ollama; nomic-embed-text creates embeddings. Both are independently selectable from locally installed, capability-checked models. No model downloads occur inside the app. The development setup installed nomic-embed-text alongside the existing Qwen model.

## Storage and ingestion

The existing `notelah.sqlite` and managed `files/` remain the source of truth. The derived `search-index.sqlite` stores one JSON chunk/vector record per document, plus an embedding identity. This is an embedded exact-search vector store, not a separate vector database server or an approximate nearest-neighbor index. Backups retain source notes and files; the search cache is rebuilt when needed. Chat messages remain in renderer memory for the current session. Model selections are saved in localStorage.

When a question arrives, the backend snapshots saved notes, fingerprints title/body/folder/file metadata, and reuses unchanged documents. New or edited documents are extracted, chunked, embedded in batches of eight, and persisted atomically. Deleted notes are absent from the replacement index. Model name, model digest, and chunker version invalidate incompatible embeddings. A library change during indexing or answering rejects the stale result. Cancelled or failed indexing leaves the previous cache intact.

TXT/Markdown text comes from the imported body stored in SQLite; written notes use the same body. PDFs are read from their verified managed copies and processed by Mozilla PDF.js. Each page is independently chunked, preserving one-based PDF page references. No OCR is included: scanned PDFs without text and unreadable/encrypted PDFs surface indexing notices. There is a 500-page/2-million-character PDF limit and 5,000-chunk library limit.

Chunks target 1,000 characters, cut at word/newline boundaries when possible, with 150-character overlap. This is character-based, not tokenizer-based. Titles are included in embedding input and keyword text. Source IDs link every chunk back to its note, folder, and optional PDF page. A SHA-256 ID includes the note fingerprint and chunk position.

## Retrieval and generation

1. Apply the selected folder scope before retrieval. All-library indexing currently happens on each question, with unchanged embeddings reused.
2. Unicode-normalized lowercase word tokens feed a TypeScript BM25 implementation (k1=1.2, b=0.75). SQLite's existing sql.js build lacks FTS5; no FTS5 support is assumed. BM25 is calculated over the scoped collection.
3. Embed the question with nomic's `search_query:` prefix; document embeddings use `search_document:`. Compute exact cosine similarity over cached vectors. The implementation currently applies these prefixes to all selectable embedding models; other models may not benefit from nomic's conventions.
4. Take up to 20 positive-score results from each search, then reciprocal rank fusion with k=60 and equal weights: score(chunk) = sum(1 / (60 + rank)). Missing ranks contribute zero. RRF scores are not probabilities or confidence values.
5. Remove exact duplicate passages, cap each note at three chunks, then select up to six passages within a 5,500-character evidence budget. Positive cosine similarity is only a candidate filter, not a calibrated relevance threshold.
6. Send the question, bounded conversation context, numbered sources, and grounding instructions to the local chat model. Generation uses an 8,192-token context setting, a 650-token output cap, temperature 0.1, and thinking disabled. The final system/payload text is bounded to 6,500 UTF-8 bytes as a conservative token bound, reserving room for output and chat-template tokens. History and lower-ranked sources are removed to fit; oversized individual prompts are rejected. This is not a model-specific tokenizer measurement.
7. Display the answer and source links. Invalid numeric citations are removed; an answer without any valid citation is withheld and its retrieved passages remain inspectable. Valid citation labels do not prove that every claim is supported: source checking remains necessary. Output truncation is reported.

The last user question is included in retrieval to help simple follow-ups. There is no dedicated query rewriting model; complicated follow-ups may need a self-contained question. The last two turns are passed to the chat model as context, explicitly not as evidence. Changing the folder starts a new conversation.

## Local runtime and boundaries

Only fixed localhost Ollama endpoints are used, with HTTP redirects refused. Model discovery checks capabilities and excludes declared remote/cloud models. Renderer IPC is restricted to the trusted app frame, with request validation. Long inference is independent of the workspace save queue; only one RAG job runs at a time and Stop aborts network requests and PDF work. Models use `keep_alive: 0` to release memory after each embedding batch or answer; this favors memory over loading speed. A cancelled request is aborted, but actual model unloading timing is controlled by Ollama.

Document text is untrusted prompt data. The system prompt instructs the model not to follow document commands, but this does not guarantee prompt-injection resistance. The model has no tools and cannot change notes, tasks, or files. Answers and source text are rendered as escaped React text. Clicking a source shows its retrieved passage and current text, or opens its managed PDF; the system PDF viewer does not necessarily jump to the cited page.

## Validation and interview discussion

`npm test` covers BM25 and fusion behavior, chunk bounds, persisted embedding reuse, folder scoping, edit/deletion invalidation, model-digest invalidation, cancellation, stale indexing rejection, PDF page extraction, invalid-PDF notices, and withholding uncited answers, alongside existing storage tests.

After `npm run build`, `node scripts/chat-qa.cjs` uses isolated data under `work/` and real installed Ollama models to verify the desktop question-to-answer path, PDF citations, source preview, folder scope, session retention across navigation, narrow layout, and cancellation. `node scripts/notes-qa.cjs` checks Notes regressions.

This is a working hybrid RAG baseline, not a benchmarked claim of superiority. Next evaluation: create a fixed set of representative questions with relevant chunk/page labels; compare BM25-only, vector-only, and hybrid Recall@k/MRR, answer support, and latency. Tune chunk sizes, candidate counts, and RRF only against those results. Add a reranker or approximate vector index when measured quality or library size justifies it. GraphRAG and agents are not implemented.
