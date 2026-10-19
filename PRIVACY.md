# Privacy and local data

This document describes the current official NoteLah desktop implementation. Modified builds, browser extensions, operating systems, and separately installed software can behave differently.

## Where information goes

- Tasks, profile information, settings, written notes, and folder metadata are stored in `%APPDATA%\NoteLah\notelah.sqlite`.
- Imported documents are copied to `%APPDATA%\NoteLah\files`. Importing does not transfer ownership of their contents.
- Extracted document passages and embeddings are stored in the derived `search-index.sqlite` in the same application data directory. Treat that index as private information too.
- Chat history is held in application memory for the current session. It is not currently saved as a persistent conversation archive.
- Chat sends questions, retrieved passages, and relevant conversation context to the separately installed Ollama service at `127.0.0.1:11434`. NoteLah excludes models identified as cloud models. Ollama's own configuration, storage, logs, and any software behind that endpoint are outside NoteLah's control.
- The current application has no developer-operated account service, cloud synchronization, analytics, or telemetry. Dependency installation and model downloads require network access; local inference does not require uploading notes to a developer-operated service.
- The browser version stores its workspace in browser storage, separately from the desktop workspace. Browser settings control that storage.

## Access, backups, and deletion

Local storage and exports are not encrypted by NoteLah. Other software or people with sufficient access to your Windows account, device, backups, or synchronized folders may be able to read them. Use device security appropriate to your information.

Settings provides backup and export controls. Complete backups can contain your profile, tasks, notes, and original imported files. Store them privately. Do not attach them to public issues.

Deleting a note does not delete the original file you imported, previously exported copies, or older backups. Uninstalling or replacing the portable executable does not necessarily delete application data. To remove the entire desktop workspace, close NoteLah and remove its application data directory only after deciding whether you need a backup. Remove separately stored exports and browser data independently. Model files and Ollama data are managed separately.

## Support and future changes

Anything you voluntarily submit in an issue or pull request may become public. Use synthetic examples and remove personal information, secrets, and document contents. Changes to persistence, telemetry, remote services, or agent memory must update this document before release.
