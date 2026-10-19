import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileKey, MAX_FILE_BYTES, MAX_TEXT_BYTES, type NoteFile, type WorkspaceState } from "../src/lib/model";

export type FileContents = Map<string, Uint8Array>;
export function verifyFile(file: NoteFile, bytes: Uint8Array) {
  if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`The saved copy of ${file.name} is missing or damaged. Restore a complete NoteLah backup.`);
}
export function importedText(extension: string, bytes: Uint8Array): string {
  if (extension === "pdf") {
    if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) throw new Error("Choose a valid PDF file.");
    return "";
  }
  if (bytes.byteLength > MAX_TEXT_BYTES) throw new Error("Choose a text or Markdown file smaller than 1 MB.");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Binary text");
    return text;
  } catch { throw new Error("Text and Markdown files must be saved as UTF-8 text."); }
}

export class FileLibrary {
  constructor(readonly directory: string) {}
  location(file: NoteFile) { return path.join(this.directory, fileKey(file)); }
  async read(file: NoteFile) {
    let bytes: Buffer;
    try { bytes = await fs.readFile(this.location(file)); }
    catch { throw new Error(`The saved copy of ${file.name} could not be found. Restore a complete NoteLah backup.`); }
    verifyFile(file, bytes);
    return bytes;
  }
  async stage(state: WorkspaceState, contents: FileContents) {
    await fs.mkdir(this.directory, { recursive: true });
    const created: string[] = [];
    try {
      for (const note of state.notes) {
        if (!note.file) continue;
        const file = note.file;
        const incoming = contents.get(fileKey(file));
        if (incoming) verifyFile(file, incoming);
        let existing: Buffer | null = null;
        try { existing = await fs.readFile(this.location(file)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (existing) {
          try { verifyFile(file, existing); continue; }
          catch (error) {
            if (!incoming) throw error;
            // Only verified backup/import bytes may repair a damaged managed copy.
            const temporary = `${this.location(file)}.${randomUUID()}.pending`;
            try { await fs.writeFile(temporary, incoming, { flag: "wx" }); await fs.rename(temporary, this.location(file)); }
            finally { await fs.unlink(temporary).catch(() => undefined); }
            continue;
          }
        }
        if (!incoming || incoming.byteLength > MAX_FILE_BYTES) throw new Error(`The backup does not include ${file.name}.`);
        await fs.writeFile(this.location(file), incoming, { flag: "wx" });
        created.push(this.location(file));
      }
      return created;
    } catch (error) { await Promise.all(created.map((file) => fs.unlink(file).catch(() => undefined))); throw error; }
  }
  async cleanupCreated(files: string[]) { await Promise.all(files.map((file) => fs.unlink(file).catch(() => undefined))); }
}
