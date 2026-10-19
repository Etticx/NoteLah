# Notes: what was built and how storage works

## The feature

Notes is a new section alongside Today and Later. It supports flat folders, written notes, folder rename/delete, note editing/deletion, and keyword search. Deleting a folder moves its notes into Inbox. Desktop users can import UTF-8 TXT/Markdown files and PDF documents. Imported text is previewed without executing markup; PDFs open in a separate sandboxed NoteLah viewer window with no app preload or IPC bridge. RAG, PDF extraction, nested folders, and task-to-note links are later work.

## Where the data lives

On Windows, the default application data directory is `%APPDATA%\NoteLah`, normally `C:\Users\User\AppData\Roaming\NoteLah` for this account.

- `notelah.sqlite`: tasks, folders, written note bodies, imported-file metadata, profile, and settings.
- `files/<SHA-256>.<extension>`: managed imported copies. Original filenames remain in the metadata shown to the user. The app's folders are logical organization, not arbitrary filesystem paths.
- `backups/`: complete SQLite backup snapshots, unless the user chooses another backup directory.

The files directory is outside the portable executable and its temporary extraction directory. Moving the source PDF or replacing the application executable does not move or delete the library.

## Import flow

The interface passes a folder ID through the preload API. The main process validates that ID and opens a native file picker. Only paths selected by that picker reach the import method. The storage layer validates file type/size, checks UTF-8 text or a PDF header, computes SHA-256, and writes managed copies before committing the note records.

Identical contents with the same extension share a managed copy. Two different files with the same original name keep separate content-based copies. Failed imports do not commit part of the batch. Text and PDF contents are not interpreted as application instructions or HTML.

The original computer file is unchanged. Imported text previews are read-only; the library title and folder can be edited. Written notes are editable in the app and require Save note. The app guards unsaved note edits when closing the editor or window.

## Database upgrade and recovery

Schema version 2 adds `folders` and `notes`. Existing task-only databases are read and validated, and a byte-for-byte recovery copy named `NoteLah-before-notes-upgrade-...sqlite` is written before migration. Legacy task fields are preserved. Zod normalizes version-one JSON imports into the current workspace shape and rejects duplicate IDs or missing folder references.

The current application still uses sql.js and a whole-workspace save. This implementation does not claim to solve the larger-collection write-amplification tradeoff described in the learning plan.

## Complete backups

Live file bytes stay outside the main database. A backup snapshot adds a `file_contents` table containing each referenced copy, so a single SQLite backup can restore the entire workspace on another machine. JSON exports include the same bytes as Base64 in `fileData`. Backup import validates sizes and hashes before displaying a restore preview. Restoration stages the verified copies before committing restored records. A complete pre-restore backup is made first.

Removing a live note can remove an unreferenced managed copy, but backup snapshots own their own bytes. A missing or damaged live copy causes backup creation to fail visibly instead of producing a falsely complete backup. Verified backup bytes can repair damaged copies on restore.

Complete backups duplicate file bytes and therefore consume additional disk space. Automatic backup retention remains seven daily snapshots; recovery copies are retained separately. Limits are 1 MB per text import, 20 MB per PDF, 10 imports per batch, 50 MB distinct imported bytes, and 100 MB per complete backup.

## Useful interview explanations

1. SQLite holds structured records; the filesystem holds live imported documents. Backup snapshots deliberately include the bytes for portability.
2. Content addressing prevents filename collisions and permits deduplication; hashes also detect damaged copies.
3. Runtime validation belongs in the privileged process, even though the interface is written in TypeScript.
4. A migration must preserve existing data and offer a recovery path; a passing UI demonstration alone does not establish that.
5. This feature prepares a data source for RAG. Importing files and keyword search are not yet embeddings, RAG, or agent behavior.

## Verification

`tests/notes.test.ts` covers legacy migration/recovery, persistent notes/folders, invalid relationships, portable SQLite and JSON recovery of TXT/Markdown/PDF copies, damaged bytes, atomic imports, duplicate filenames, forged file references, deletion, and missing-file backup failures. The existing task-storage tests remain applicable.

After `npm run build`, run `node scripts/notes-qa.cjs` for the repeatable desktop journey. It creates an isolated development profile under `work/`, substitutes native pickers with fixture paths, checks the real preload/IPC handlers and UI, and cleans up its data. It does not open the user's saved workspace.

Files can be imported using the folder’s Import files button or by dragging PDF, TXT, and Markdown files from File Explorer into the selected collection. Drops use Electron webUtils.getPathForFile in the preload bridge and the same validated, atomic import pipeline as the native picker. Computer directories are not imported recursively.
