"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Folder, FolderPlus, Inbox, Pencil, Plus, Search, Trash2, Upload, ArrowUpRight } from "lucide-react";
import Modal from "./dialog";
import { createFolder, createNote, MAX_TEXT_BYTES, type Note, type NoteFolder, type StorageInfo, type WorkspaceState } from "@/lib/model";

export function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

type Props = {
  state: WorkspaceState; info: StorageInfo | null; busy: boolean;
  onChange: (update: (state: WorkspaceState) => WorkspaceState) => void;
  onImport: (folderId: string | null) => void; onOpenFile: (id: string) => void;
  onDropFiles: (folderId: string | null, files: File[]) => void;
  onDraftDirty: (dirty: boolean) => void;
};

export default function NotesWorkspace({ state, info, busy, onChange, onImport, onDropFiles, onOpenFile, onDraftDirty }: Props) {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const canImport = !busy && info?.mode === "desktop";
  useEffect(() => {
    // Keep dropped documents from replacing the workspace with a browser preview.
    const preventNavigation = (event: DragEvent) => { event.preventDefault(); };
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    return () => { window.removeEventListener("dragover", preventNavigation); window.removeEventListener("drop", preventNavigation); };
  }, []);
  const [folderId, setFolderId] = useState("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ note: Note; isNew: boolean } | null>(null);
  const [folderEditor, setFolderEditor] = useState<{ folder: NoteFolder | null; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: "note" | "folder"; id: string; title: string } | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const destination = folderId === "all" || folderId === "inbox" ? null : folderId;
  const selectedFolder = state.folders.find((folder) => folder.id === folderId);
  const visible = state.notes.filter((note) => (folderId === "all" || (folderId === "inbox" ? note.folderId === null : note.folderId === folderId)) && `${note.title}\n${note.body}`.toLowerCase().includes(query.trim().toLowerCase()));
  const changeDirty = (dirty: boolean) => { setDraftDirty(dirty); onDraftDirty(dirty); };
  const closeEditor = () => { if (draftDirty && !window.confirm("Discard unsaved note changes?")) return; setEditing(null); };

  return <>
    <div className="page-heading"><div><div className="page-eyebrow">Thoughts, references, and a little room to think</div><h1>Notes<span className="heading-period">.</span></h1><p className="page-subtitle">Keep your ideas and documents together.</p></div><div className="notes-actions"><button className="button secondary" disabled={busy || !info || info.mode !== "desktop"} title={info?.mode !== "desktop" ? "Import files using the Windows app" : "Import TXT, Markdown, or PDF"} onClick={() => onImport(destination)}><Upload size={14} />Import files</button><button className="button primary" disabled={busy || !info} onClick={() => setEditing({ note: createNote("Untitled note", "", destination), isNew: true })}><Plus size={14} />New note</button></div></div>
    <div className="notes-layout">
      <aside className="notes-folders" aria-label="Note folders">
        <div className="notes-folder-heading"><span>LIBRARY</span><button className="icon-button" aria-label="New folder" disabled={busy || !info} onClick={() => setFolderEditor({ folder: null, name: "" })}><FolderPlus size={16} /></button></div>
        <button className={`notes-folder${folderId === "all" ? " active" : ""}`} aria-pressed={folderId === "all"} onClick={() => setFolderId("all")}><FileText size={15} /><span>All notes</span><small>{state.notes.length}</small></button>
        <button className={`notes-folder${folderId === "inbox" ? " active" : ""}`} aria-pressed={folderId === "inbox"} onClick={() => setFolderId("inbox")}><Inbox size={15} /><span>Inbox</span><small>{state.notes.filter((note) => !note.folderId).length}</small></button>
        <div className="notes-folder-divider" />
        {state.folders.map((folder) => <div className="notes-folder-row" key={folder.id}><button className={`notes-folder${folderId === folder.id ? " active" : ""}`} aria-pressed={folderId === folder.id} onClick={() => setFolderId(folder.id)}><Folder size={15} /><span>{folder.name}</span><small>{state.notes.filter((note) => note.folderId === folder.id).length}</small></button><button className="icon-button" aria-label={`Rename folder ${folder.name}`} disabled={busy} onClick={() => setFolderEditor({ folder, name: folder.name })}><Pencil size={12} /></button><button className="icon-button" aria-label={`Delete folder ${folder.name}`} disabled={busy} onClick={() => setDeleting({ kind: "folder", id: folder.id, title: folder.name })}><Trash2 size={12} /></button></div>)}
        <button className="notes-new-folder" disabled={busy || !info} onClick={() => setFolderEditor({ folder: null, name: "" })}><Plus size={13} />Create folder</button>
      </aside>
      <section className={`notes-collection${dragging ? " notes-drop-active" : ""}`} aria-label="Notes collection"
        onDragEnter={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (canImport) { dragDepth.current++; setDragging(true); } }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = canImport ? "copy" : "none"; }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (canImport && event.dataTransfer.files.length) onDropFiles(destination, Array.from(event.dataTransfer.files)); }}>
        {dragging && <div className="notes-drop-message" role="status"><Upload size={24} />Drop files into {selectedFolder?.name ?? "Inbox"}</div>}
        <div className="notes-collection-heading"><h2>{selectedFolder?.name ?? (folderId === "inbox" ? "Inbox" : "All notes")}<span className="section-count">{visible.length}</span></h2><label className="notes-search"><Search size={14} /><input aria-label="Search notes" placeholder="Find a note…" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
        {visible.length ? <div className="notes-grid">{[...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((note) => <article className="note-card" key={note.id}><button className="note-card-content" onClick={() => setEditing({ note, isNew: false })}><span className="note-card-type"><FileText size={16} /><span>{note.file ? note.file.extension.toUpperCase() : "NOTE"}</span>{note.file && <small>{formatBytes(note.file.size)}</small>}</span><h3>{note.title}</h3><p>{note.body.trim().slice(0, 180) || (note.file?.extension === "pdf" ? "A PDF saved in your library. Open it in NoteLah." : "A little space for your next thought.")}</p><time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</time></button><button className="icon-button note-delete" aria-label={`Delete note ${note.title}`} disabled={busy} onClick={() => setDeleting({ kind: "note", id: note.id, title: note.title })}><Trash2 size={13} /></button></article>)}</div> : <div className="notes-empty"><FileText size={29} strokeWidth={1.2} /><h3>{query ? "No matching notes" : "A place for what you want to keep"}</h3><p>{query ? "Try a different word or another folder." : "Create a note here, or bring in a text file, Markdown document, or PDF."}</p>{!query && <div className="notes-empty-actions"><button className="button primary" disabled={!canImport} aria-label={`Import files into ${selectedFolder?.name ?? "Inbox"}`} onClick={() => onImport(destination)}><Upload size={14} />Import files</button><button className="text-button" disabled={busy || !info} onClick={() => setEditing({ note: createNote("Untitled note", "", destination), isNew: true })}>Write your first note<Plus size={13} /></button></div>}{!query && info?.mode === "desktop" && <p className="notes-drop-hint">Or drag PDF, TXT, or Markdown files here</p>}</div>}
        <p className="notes-storage-hint">{info?.mode === "desktop" ? "Imported files are copied into NoteLah. Your originals stay where they are. Text files: up to 1 MB · PDFs: up to 20 MB · Library files: up to 50 MB." : "Written notes are saved in this browser. Use the Windows app to import TXT, Markdown, and PDF files."}</p>
      </section>
    </div>
    <Modal open={!!editing} onOpenChange={(open) => !open && closeEditor()} title={editing?.isNew ? "New note" : editing?.note.file ? "Imported document" : "Edit note"} className="note-editor-modal">{editing && <NoteEditor key={editing.note.id} note={editing.note} isNew={editing.isNew} folders={state.folders} busy={busy} onDirty={changeDirty} onOpenFile={() => onOpenFile(editing.note.id)} onCancel={closeEditor} onSave={(note) => { onChange((current) => ({ ...current, notes: editing.isNew ? [...current.notes, note] : current.notes.map((old) => old.id === note.id ? note : old) })); setEditing(null); }} />}</Modal>
    <Modal open={!!folderEditor} onOpenChange={(open) => !open && setFolderEditor(null)} title={folderEditor?.folder ? "Rename folder" : "New folder"}>{folderEditor && <form onSubmit={(event) => { event.preventDefault(); const name = folderEditor.name.trim(); if (!name) return; const existing = folderEditor.folder; onChange((current) => ({ ...current, folders: existing ? current.folders.map((folder) => folder.id === existing.id ? { ...folder, name, updatedAt: new Date().toISOString() } : folder) : [...current.folders, createFolder(name)] })); setFolderEditor(null); }}><label className="field-label" htmlFor="folder-name">Folder name</label><input id="folder-name" className="field-input" value={folderEditor.name} maxLength={100} required autoFocus onChange={(event) => setFolderEditor({ ...folderEditor, name: event.target.value })} /><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setFolderEditor(null)}>Cancel</button><button className="button primary" disabled={!folderEditor.name.trim() || busy}>{folderEditor.folder ? "Save folder" : "Create folder"}</button></div></form>}</Modal>
    <Modal open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)} title={deleting?.kind === "folder" ? "Delete this folder?" : "Delete this note?"} description={deleting?.kind === "folder" ? "Its notes will move to Inbox. Your documents will be kept." : "The note and its imported copy will be removed from this library. Your original computer file is kept."}>{deleting && <><p className="delete-title">{deleting.title}</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleting(null)}>Cancel</button><button className="button destructive" disabled={busy} onClick={() => { onChange((current) => deleting.kind === "folder" ? { ...current, folders: current.folders.filter((folder) => folder.id !== deleting.id), notes: current.notes.map((note) => note.folderId === deleting.id ? { ...note, folderId: null, updatedAt: new Date().toISOString() } : note) } : { ...current, notes: current.notes.filter((note) => note.id !== deleting.id) }); if (deleting.kind === "folder" && folderId === deleting.id) setFolderId("inbox"); setDeleting(null); }}>{deleting.kind === "folder" ? "Delete folder" : "Delete note"}</button></div></>}</Modal>
  </>;
}

function NoteEditor({ note, isNew, folders, busy, onSave, onCancel, onDirty, onOpenFile }: { note: Note; isNew: boolean; folders: NoteFolder[]; busy: boolean; onSave: (note: Note) => void; onCancel: () => void; onDirty: (dirty: boolean) => void; onOpenFile: () => void }) {
  const [title, setTitle] = useState(isNew ? "" : note.title);
  const [body, setBody] = useState(note.body);
  const [folderId, setFolderId] = useState(note.folderId ?? "");
  const dirty = title !== (isNew ? "" : note.title) || body !== note.body || folderId !== (note.folderId ?? "");
  // Callback changes must not reset the app's unsaved-edit guard.
  const dirtyCallback = useRefCallback(onDirty);
  useEffect(() => { dirtyCallback.current(dirty); return () => dirtyCallback.current(false); }, [dirty, dirtyCallback]);
  return <form onSubmit={(event) => { event.preventDefault(); onSave({ ...note, title: title.trim() || "Untitled note", body, folderId: folderId || null, updatedAt: new Date().toISOString() }); }}>
    <label className="field-label" htmlFor="note-title">Title</label><input id="note-title" className="field-input" placeholder="Untitled note" value={title} maxLength={300} disabled={busy} onChange={(event) => setTitle(event.target.value)} autoFocus />
    <label className="field-label" htmlFor="note-folder">Folder</label><select id="note-folder" className="field-input" value={folderId} disabled={busy} onChange={(event) => setFolderId(event.target.value)}><option value="">Inbox</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
    {note.file?.extension === "pdf" ? <div className="note-pdf"><FileText size={30} strokeWidth={1.3} /><strong>{note.file.name}</strong><span>{formatBytes(note.file.size)} · PDF document</span><button type="button" className="button secondary" disabled={busy} onClick={onOpenFile}>Open PDF<ArrowUpRight size={14} /></button></div> : <><label className="field-label" htmlFor="note-body">{note.file ? "File contents" : "Note"}{note.file && <span>Read-only imported copy</span>}</label><textarea id="note-body" className="field-input note-body" placeholder="Start with a thought…" value={body} readOnly={!!note.file || busy} maxLength={MAX_TEXT_BYTES} onChange={(event) => setBody(event.target.value)} /></>}
    <div className="note-editor-footer"><span>{dirty ? "Unsaved changes" : note.file ? "Your original file is kept separately." : "Save your note to keep it in your library."}</span><div className="modal-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy}>Save note</button></div></div>
  </form>;
}

function useRefCallback(callback: (dirty: boolean) => void) { const ref = useRef(callback); ref.current = callback; return ref; }
