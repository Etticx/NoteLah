# What is NoteLah

It is a personal project intended to solve my daily problem, usually i have tons to do and i didn't jot it down. Thus,
i forgot. So this app helps track my task and give some sense of accomplishment on the profile page when we have the
box with green and greener thing. similar like token used haha.

## Use the Windows app

Open `outputs/NoteLah-0.1.0.exe`. A build copy also lives in `release/`. This is a portable Windows application; Node.js and a web server are not needed to use it. The first launch opens a blank workspace. The optional sample workspace is a temporary demonstration and never changes your own saved data.

To pin NoteLah to the Windows taskbar, keep the portable `.exe` in a permanent folder, open it, then right-click its taskbar icon and choose **Pin to taskbar**. If you pinned an older build and Windows says the executable is missing, unpin that shortcut and pin again after opening the updated build. Moving or renaming the portable `.exe` also requires pinning again.

- **Today:** add tasks, keep notes, choose dates, complete work, and bring unfinished tasks forward.
- **Later:** capture ideas without choosing a date, then schedule them when ready.
- **Notes:** create folders and written notes, import `.txt`, `.md`, and PDF files, search the library, and move notes between folders. Text imports have a read-only text preview; PDFs open in your usual PDF viewer. Chat extracts PDF text with page references for local AI search.
- **My profile:** edit your name and bio, see completed work, and click a day in the green activity grid to revisit it.
- **Settings:** choose the start of the week, manage backups, restore, and export.

Written notes and folder information are stored in `%APPDATA%\NoteLah\notelah.sqlite`. Imported originals are copied into `%APPDATA%\NoteLah\files` using content-based filenames, so moving your source files does not break the library. Settings shows the exact folder and imported-file usage. The first upgrade saves a recovery copy of the old database before adding Notes.

Use **Create backup** or **Export JSON** to make a complete copy, including imported files. Copying only the live database file does not include those external copies. Old task-only backups still restore. Deleting a folder moves its notes into Inbox; deleting a note removes its managed copy when nothing else uses it, while your original source file and existing complete backups are kept.

Import limits: UTF-8 `.txt`/`.md` up to 1 MB each, PDFs up to 20 MB each, 10 files per import, and 50 MB of distinct imported files in the library. Backups are limited to 100 MB. The browser version supports written notes and folders; importing documents and restoring backups containing them requires the Windows app.


## Develop

Requires Node.js 22.12 or newer and npm.

```sh
npm ci
npm run dev
```

Open the local URL printed by Next.js. All fonts are bundled locally.

```sh
npm run typecheck
npm test
npm run build
npm run preview
npm run desktop
npm run package:win
```

`desktop` builds the Next.js static export and opens it in Electron. `package:win` builds the portable Windows executable in `release/`. Development and packaging require downloading open-source dependencies; the packaged application runs offline.

The desktop app is intended for one person on one laptop. Chat implements local hybrid RAG (BM25 + vector similarity + reciprocal rank fusion) using Ollama. Cloud synchronization and AI agents are not implemented. The Windows build is unsigned.

Open-source acknowledgments are in `THIRD_PARTY_NOTICES.md`. Dependency versions are locked in `package-lock.json`.


### Local Chat

Open **Chat** in the Windows app. Choose an installed chat model and embedding model, select all notes or a folder, and ask a question. The first question builds a local search index; later questions reuse unchanged embeddings. Ollama must be running. The initial setup uses `qwen3.5:2b-q4_K_M` for answers and `nomic-embed-text:latest` for embeddings (`ollama pull nomic-embed-text`). Models are downloaded once; inference uses only `127.0.0.1:11434`. Cloud models are excluded.

Answers include clickable source labels and expandable retrieved passages with BM25/vector ranks and RRF scores. Stop cancels the current job. Chat history lasts only for the app session. The derived `%APPDATA%\NoteLah\search-index.sqlite` is separate from the notes database and is rebuilt after restoration as needed; it is not included in backups. Scanned PDFs need OCR, which is not included. See [RAG implementation and learning notes](docs/RAG.md).
