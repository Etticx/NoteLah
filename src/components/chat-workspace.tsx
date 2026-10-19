"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, MessageCircle, RefreshCw, Send, Square } from "lucide-react";
import Modal from "./dialog";
import type { Note, WorkspaceState } from "@/lib/model";
import type { ChatModels, RagReply, RagSource, RagStatus } from "@/lib/rag-types";

type Turn = { question: string; reply?: RagReply; error?: string };
export default function ChatWorkspace({ state, enabled, visible }: { state: WorkspaceState; enabled: boolean; visible: boolean }) {
  const [models, setModels] = useState<ChatModels>([]);
  const [chatModel, setChatModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [folder, setFolder] = useState("");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<RagStatus | null>(null);
  const [source, setSource] = useState<{ note: Note; passage: RagSource } | null>(null);
  const initialized = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  async function refreshModels() {
    if (!window.notelah) return;
    setLoadingModels(true); setError("");
    try {
      const available = await window.notelah.chatModels();
      setModels(available);
      const previous = JSON.parse(localStorage.getItem("notelah-chat-models") ?? "{}");
      setChatModel((current) => available.find((m) => m.chat && m.name === (current || previous.chat))?.name ?? available.find((m) => m.chat && /qwen3.5.*2b/i.test(m.name))?.name ?? available.find((m) => m.chat)?.name ?? "");
      setEmbeddingModel((current) => available.find((m) => m.embedding && m.name === (current || previous.embedding))?.name ?? available.find((m) => m.embedding && m.name.startsWith("nomic-embed-text"))?.name ?? available.find((m) => m.embedding)?.name ?? "");
    } catch (error) { setError((error as Error).message); }
    finally { setLoadingModels(false); }
  }
  useEffect(() => { if (enabled && visible && !initialized.current) { initialized.current = true; void refreshModels(); } }, [enabled, visible]);
  useEffect(() => {
    if (!busy) return;
    let mounted = true;
    const timer = setInterval(() => { void window.notelah?.chatStatus().then((status) => { if (mounted) setProgress(status); }).catch(() => undefined); }, 700);
    return () => { mounted = false; clearInterval(timer); };
  }, [busy]);
  useEffect(() => { if (visible) end.current?.scrollIntoView({ block: "nearest" }); }, [turns, busy, visible]);
  useEffect(() => { if (folder && !state.folders.some((item) => item.id === folder)) setFolder(""); }, [state.folders, folder]);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!window.notelah || busy || !question.trim() || !chatModel || !embeddingModel) return;
    const text = question.trim();
    setQuestion(""); setBusy(true); setError(""); setProgress({ busy: true, message: "Starting local search", completed: 0, total: 0 });
    const index = turns.length;
    const history = turns.filter((turn) => turn.reply).slice(-4).map((turn) => ({ question: turn.question, answer: turn.reply!.answer }));
    setTurns((current) => [...current, { question: text }]);
    try {
      localStorage.setItem("notelah-chat-models", JSON.stringify({ chat: chatModel, embedding: embeddingModel }));
      const reply = await window.notelah.chatAsk({ question: text, folderId: folder || null, chatModel, embeddingModel, history });
      setTurns((current) => current.map((turn, i) => i === index ? { ...turn, reply } : turn));
    } catch (error) { setTurns((current) => current.map((turn, i) => i === index ? { ...turn, error: (error as Error).message } : turn)); }
    finally { setBusy(false); setProgress(null); }
  }
  async function openSource(passage: RagSource) {
    try { const note = await window.notelah!.chatSource(passage.noteId); setSource({ note, passage }); }
    catch (error) { setError((error as Error).message); }
  }
  return <>
    <div className="page-heading"><div><div className="page-eyebrow">A conversation with your notes</div><h1>Chat<span className="heading-period">.</span></h1><p className="page-subtitle">Ask a question. Find the passages behind the answer.</p></div><button className="button secondary" disabled={busy || !turns.length} onClick={() => { setTurns([]); setError(""); }}>New chat</button></div>
    {!enabled ? <div className="notes-empty"><MessageCircle size={28} /><h3>Chat is available in the Windows app</h3><p>Open your own desktop workspace to chat with local notes using Ollama.</p></div> : <>
      <div className="chat-settings">
        <label>Answer model<select aria-label="Answer model" value={chatModel} disabled={busy || loadingModels} onChange={(e) => setChatModel(e.target.value)}><option value="">Select a model</option>{models.filter((m) => m.chat).map((m) => <option key={m.name}>{m.name}</option>)}</select></label>
        <label>Embedding model<select aria-label="Embedding model" value={embeddingModel} disabled={busy || loadingModels} onChange={(e) => setEmbeddingModel(e.target.value)}><option value="">Select a model</option>{models.filter((m) => m.embedding).map((m) => <option key={m.name}>{m.name}</option>)}</select></label>
        <label>Search in<select aria-label="Search in" value={folder} disabled={busy} onChange={(e) => { setFolder(e.target.value); setTurns([]); }}><option value="">All notes</option>{state.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <button className="icon-button" aria-label="Refresh local models" title="Refresh local models" disabled={busy || loadingModels} onClick={() => void refreshModels()}><RefreshCw size={16} /></button>
      </div>
      {error && <p className="chat-error" role="alert">{error}</p>}
      {!embeddingModel && !loadingModels && <p className="chat-help">An embedding model is required. Install one in Ollama with <code>ollama pull nomic-embed-text</code>, then refresh the model list.</p>}
      <div className="chat-conversation" aria-label="Conversation">
        {!turns.length && <div className="chat-welcome"><MessageCircle size={30} strokeWidth={1.3} /><h2>What would you like to find?</h2><p>Try asking what a document requires, how two ideas relate, or for a summary of your notes.</p><span>Your first question prepares a local search index. Later questions reuse unchanged documents.</span></div>}
        {turns.map((turn, index) => <article className="chat-turn" key={index}><div className="chat-question"><span>You</span><p>{turn.question}</p></div>{turn.error && <p className="chat-error" role="alert">{turn.error}</p>}{turn.reply && <div className="chat-answer"><span>NoteLah</span><p className="chat-answer-text">{turn.reply.answer.split(/(\[\d+\])/g).map((part, i) => { const label = /^\[(\d+)\]$/.exec(part); const passage = label && turn.reply!.sources.find((s) => s.label === Number(label[1])); return passage ? <button className="chat-citation" key={i} onClick={() => void openSource(passage)} aria-label={`Source ${passage.label}: ${passage.title}`}>{part}</button> : part.split(/(\*\*[^*]+\*\*)/g).map((text, j) => text.startsWith("**") && text.endsWith("**") ? <strong key={`${i}-${j}`}>{text.slice(2, -2)}</strong> : text); })}</p>
          {!!turn.reply.warnings.length && <details className="chat-warnings"><summary>Indexing and answer notices ({turn.reply.warnings.length})</summary>{turn.reply.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
          {!!turn.reply.sources.length && <details className="chat-sources"><summary>Retrieved passages ({turn.reply.sources.length})</summary>{turn.reply.sources.map((passage) => <div className="chat-source" key={passage.id}><button className="text-button" onClick={() => void openSource(passage)}>[{passage.label}] {passage.title}{passage.page ? ` · page ${passage.page}` : ""}<ArrowUpRight size={12} /></button><p>{passage.text}</p><small>Keyword rank: {passage.bm25Rank ?? "—"} · Meaning rank: {passage.vectorRank ?? "—"} · RRF: {passage.score.toFixed(4)}</small></div>)}</details>}
        </div>}</article>)}
        {busy && <div className="chat-progress" role="status"><span className="saving-dot" />{progress?.message ?? "Working locally…"}{!!progress?.total && <span>{progress.completed}/{progress.total} documents</span>}</div>}
        <div ref={end} />
      </div>
      <form className="chat-composer" onSubmit={ask}><label className="sr-only" htmlFor="chat-question">Ask your notes</label><textarea id="chat-question" placeholder="Ask something about your notes…" value={question} maxLength={2000} disabled={busy} rows={3} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />{busy ? <button type="button" className="button secondary" onClick={() => void window.notelah!.chatCancel()}><Square size={13} />Stop</button> : <button className="button primary" disabled={!question.trim() || !chatModel || !embeddingModel || loadingModels}><Send size={14} />Ask</button>}</form>
      <div className="chat-footer"><p>Local models · Chats last until you close or reload the app · Answers can be wrong; check sources.</p><button className="text-button" disabled={busy} onClick={async () => { try { await window.notelah!.chatResetIndex(); setError("Search index cleared. Your next question will rebuild it. Your notes are kept."); } catch (e) { setError((e as Error).message); } }}>Rebuild search index</button></div>
    </>}
    <Modal open={!!source} onOpenChange={(open) => !open && setSource(null)} title={source?.note.title ?? "Source"} className="note-editor-modal">{source && <><p className="chat-source-label">Retrieved passage{source.passage.page ? ` · PDF page ${source.passage.page}` : ""}</p><pre className="chat-source-preview">{source.passage.text}</pre>{source.note.file?.extension === "pdf" ? <button className="button secondary" onClick={async () => { try { await window.notelah!.openNoteFile(source.note.id); } catch (e) { setError((e as Error).message); } }}>Open PDF<ArrowUpRight size={14} /></button> : <details className="chat-sources"><summary>Current note contents</summary><pre className="chat-source-preview">{source.note.body}</pre></details>}<p className="chat-help">The passage reflects the answer's search. Current document contents may have changed.</p></>}</Modal>
  </>;
}
