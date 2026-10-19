"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, MessageCircle, RefreshCw, Send, Square } from "lucide-react";
import Modal from "./dialog";
import type { Note, WorkspaceState } from "@/lib/model";
import type { ChatModels, RagReply, RagSource, RagStatus } from "@/lib/rag-types";
import type { AgentReply, AgentReceipt } from "@/lib/agent-types";
import { localDate } from "@/lib/dates";
import AgentPlan from "./agent-plan";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
type Turn = { question: string; reply?: RagReply; agent?: AgentReply; receipt?: AgentReceipt; undone?: boolean; error?: string };
export default function ChatWorkspace({ state, enabled, visible, onAgentAction }: { state: WorkspaceState; enabled: boolean; visible: boolean; onAgentAction: (kind: "apply" | "undo", token: string) => Promise<AgentReceipt | undefined> }) {
  const [mode, setMode] = useState<"notes" | "plan" | "breakdown">("notes");
  const [minutes, setMinutes] = useState(120);
  const [date, setDate] = useState(localDate);
  const [preference, setPreference] = useState("");
  const [applying, setApplying] = useState(false);
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
    } catch (error) { setError(errorMessage(error)); }
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
    if (!window.notelah || !enabled || busy || applying || !question.trim() || !chatModel || !embeddingModel) return;
    if (mode === "plan" && (!date || !Number.isInteger(minutes) || minutes < 5 || minutes > 480)) { setError("Choose a plan date and 5–480 available minutes."); return; }
    const text = question.trim();
    setQuestion(""); setBusy(true); setError(""); setProgress({ busy: true, message: "Starting local search", completed: 0, total: 0 });
    const index = turns.length;
    const history = turns.filter((turn) => turn.reply).slice(-4).map((turn) => ({ question: turn.question, answer: turn.reply!.answer }));
    setTurns((current) => [...current, { question: text }]);
    try {
      localStorage.setItem("notelah-chat-models", JSON.stringify({ chat: chatModel, embedding: embeddingModel }));
      if (mode !== "notes") {
        const history = turns.filter(t => t.agent && (mode !== "breakdown" || t.agent.kind === "task_draft")).slice(-2).map(t => ({ question: t.question, summary: `${t.agent!.summary} ${t.agent!.items.map(i => `${i.title}: ${i.minutes} min`).join("; ")} ${t.agent!.draftTasks?.map(task => task.title).join("; ") ?? ""}`.slice(0, 1000) }));
        const agent = await window.notelah.agentPlan({ question: text, intent: mode === "breakdown" ? "breakdown" : "plan", folderId: folder || null, chatModel, embeddingModel, date, minutes, preference, history });
        setTurns(current => current.map((turn, i) => i === index ? { ...turn, agent } : turn));
        if (agent.kind === "task_draft") setMode("breakdown");
      } else {
        const reply = await window.notelah.chatAsk({ question: text, folderId: folder || null, chatModel, embeddingModel, history });
        setTurns((current) => current.map((turn, i) => i === index ? { ...turn, reply } : turn));
      }
    } catch (error) { setTurns((current) => current.map((turn, i) => i === index ? { ...turn, error: errorMessage(error) } : turn)); }
    finally { setBusy(false); setProgress(null); }
  }
  async function openSource(passage: RagSource) {
    try { const note = await window.notelah!.chatSource(passage.noteId); setSource({ note, passage }); }
    catch (error) { setError(errorMessage(error)); }
  }
  async function planAction(index: number, kind: "apply" | "undo", token: string) {
    if (applying || busy || !enabled) return;
    setApplying(true); setError("");
    try {
      const receipt = await onAgentAction(kind, token);
      setTurns(current => current.map((turn, i) => i === index ? { ...turn, ...(kind === "apply" ? { receipt } : { undone: true }) } : turn));
    } catch (error) { setError(errorMessage(error)); }
    finally { setApplying(false); }
  }
  return <>
    <div className="page-heading"><div><div className="page-eyebrow">A conversation with your workspace</div><h1>Chat<span className="heading-period">.</span></h1><p className="page-subtitle">Ask your notes, plan your day, or break a goal into tasks.</p></div><button className="button secondary" disabled={busy || applying || !turns.length} onClick={() => { setTurns([]); setError(""); }}>New chat</button></div>
    {!enabled ? <div className="notes-empty"><MessageCircle size={28} /><h3>Chat is available in the Windows app</h3><p>Open your own desktop workspace to chat with local notes using Ollama.</p></div> : <>
      <div className="chat-settings">
        <label>Chat mode<select aria-label="Chat mode" value={mode} disabled={busy || applying} onChange={e => setMode(e.target.value as "notes" | "plan" | "breakdown")}><option value="notes">Ask my notes</option><option value="plan">Plan my day</option><option value="breakdown">Break down a goal</option></select></label>
        <label>Answer model<select aria-label="Answer model" value={chatModel} disabled={busy || loadingModels} onChange={(e) => setChatModel(e.target.value)}><option value="">Select a model</option>{models.filter((m) => m.chat).map((m) => <option key={m.name}>{m.name}</option>)}</select></label>
        <label>Embedding model<select aria-label="Embedding model" value={embeddingModel} disabled={busy || loadingModels} onChange={(e) => setEmbeddingModel(e.target.value)}><option value="">Select a model</option>{models.filter((m) => m.embedding).map((m) => <option key={m.name}>{m.name}</option>)}</select></label>
        <label>Search in<select aria-label="Search in" value={folder} disabled={busy} onChange={(e) => { setFolder(e.target.value); setTurns([]); }}><option value="">All notes</option>{state.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <button className="icon-button" aria-label="Refresh local models" title="Refresh local models" disabled={busy || loadingModels} onClick={() => void refreshModels()}><RefreshCw size={16} /></button>
      </div>
      {mode !== "notes" && <div className="agent-settings">{mode === "plan" && <><label>Plan date<input aria-label="Plan date" type="date" value={date} disabled={busy || applying} onChange={e => setDate(e.target.value)} /></label><label>Available minutes<input aria-label="Available minutes" type="number" min={5} max={480} step={5} value={minutes} disabled={busy || applying} onChange={e => setMinutes(Number(e.target.value))} /></label></>}<label className="agent-preference">Session preference<input aria-label="Session preference" placeholder="For example: keep each session under 30 minutes" value={preference} maxLength={300} disabled={busy || applying} onChange={e => setPreference(e.target.value)} /></label><p>Plans existing tasks or drafts a checklist from your goal. New tasks require approval. No web browsing. “Search in” limits notes only. Preferences and plans stay in this session. Goal checklists start unscheduled in Later. You approve every addition or date change.</p></div>}
      {error && <p className="chat-error" role="alert">{error}</p>}
      {!embeddingModel && !loadingModels && <p className="chat-help">An embedding model is required. Install one in Ollama with <code>ollama pull nomic-embed-text</code>, then refresh the model list.</p>}
      <div className="chat-conversation" aria-label="Conversation">
        {!turns.length && <div className="chat-welcome"><MessageCircle size={30} strokeWidth={1.3} /><h2>{mode === "breakdown" ? "What goal would you like to break down?" : mode === "plan" ? "What would you like to work on?" : "What would you like to find?"}</h2><p>{mode === "breakdown" ? "Try: List the research tasks I need for my hackathon project." : mode === "plan" ? "Try: Check my unfinished work and relevant notes, then suggest a realistic plan." : "Try asking what a document requires, how two ideas relate, or for a summary of your notes."}</p><span>{mode === "breakdown" ? "Review suggested tasks and assumptions, then choose Add tasks to save them in Later." : mode === "plan" ? "The planner can read tasks and search notes. Nothing changes until you apply a proposal." : "Your first question prepares a local search index. Later questions reuse unchanged documents."}</span></div>}
        {turns.map((turn, index) => <article className="chat-turn" key={index}><div className="chat-question"><span>You</span><p>{turn.question}</p></div>{turn.error && <p className="chat-error" role="alert">{turn.error}</p>}{turn.reply && <div className="chat-answer"><span>NoteLah · {{ answer: "From your notes", inference: "Inferred from your notes", insufficient: "Not enough evidence", clarification: "Clarification needed" }[turn.reply.kind]}</span><p className="chat-answer-text">{turn.reply.answer.split(/(\[\d+\])/g).map((part, i) => { const label = /^\[(\d+)\]$/.exec(part); const passage = label && turn.reply!.sources.find((s) => s.label === Number(label[1])); return passage ? <button className="chat-citation" key={i} onClick={() => void openSource(passage)} aria-label={`Source ${passage.label}: ${passage.title}`}>{part}</button> : part.split(/(\*\*[^*]+\*\*)/g).map((text, j) => text.startsWith("**") && text.endsWith("**") ? <strong key={`${i}-${j}`}>{text.slice(2, -2)}</strong> : text); })}</p>
          <details className="chat-sources"><summary>Search details</summary><p>Question used for search: {turn.reply.trace.searchQuestion}</p><p>{turn.reply.trace.rewritten ? "A follow-up reference was resolved before searching." : "Searched using this question independently."}</p><p>Keyword query: {turn.reply.trace.keywordQuery}</p><p>Keyword candidates: {turn.reply.trace.keywordCandidates} · Meaning candidates: {turn.reply.trace.vectorCandidates} · Context: {turn.reply.trace.contextBytes} bytes · {(turn.reply.trace.elapsedMs / 1000).toFixed(1)} seconds</p></details>
          {!!turn.reply.warnings.length && <details className="chat-warnings"><summary>Indexing and answer notices ({turn.reply.warnings.length})</summary>{turn.reply.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
          {!!turn.reply.sources.length && <details className="chat-sources"><summary>Retrieved passages ({turn.reply.sources.length})</summary>{turn.reply.sources.map((passage) => <div className="chat-source" key={passage.id}><button className="text-button" onClick={() => void openSource(passage)}>[{passage.label}] {passage.title}{passage.page ? ` · page ${passage.page}` : ""}{passage.sectionHeading ? ` · ${passage.sectionHeading}` : ""}<ArrowUpRight size={12} /></button><p>{passage.text}</p><small>Keyword rank: {passage.bm25Rank ?? "—"} · Meaning rank: {passage.vectorRank ?? "—"} · RRF: {passage.score.toFixed(4)}</small></div>)}</details>}
        </div>}{turn.agent && <AgentPlan onAskNotes={() => { setMode("notes"); setQuestion(turn.question); setError(""); }} reply={turn.agent} receipt={turn.receipt} undone={turn.undone} disabled={busy || applying || !enabled} onSource={passage => void openSource(passage)} onApply={() => void planAction(index, "apply", turn.agent!.token!)} onUndo={() => void planAction(index, "undo", turn.receipt!.token)} onDismiss={() => setTurns(current => current.map((t, i) => i === index ? { ...t, agent: { ...t.agent!, token: null } } : t))} />}</article>)}
        {busy && <div className="chat-progress" role="status"><span className="saving-dot" />{progress?.message ?? "Working locally…"}{!!progress?.total && <span>{progress.completed}/{progress.total} {mode !== "notes" ? "steps" : "documents"}</span>}</div>}
        <div ref={end} />
      </div>
      <form className="chat-composer" onSubmit={ask}><label className="sr-only" htmlFor="chat-question">Ask your notes</label><textarea id="chat-question" placeholder={mode !== "notes" ? "Describe your goal, ask for a checklist, or plan existing tasks…" : "Ask something about your notes…"} value={question} maxLength={2000} disabled={busy} rows={3} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />{busy ? <button type="button" className="button secondary" onClick={() => void window.notelah!.chatCancel()}><Square size={13} />Stop</button> : <button className="button primary" disabled={applying || !enabled || !question.trim() || !chatModel || !embeddingModel || loadingModels}><Send size={14} />Ask</button>}</form>
      <div className="chat-footer"><p>Local models · Chats last until you close or reload the app · Answers can be wrong; check sources.</p><button className="text-button" disabled={busy} onClick={async () => { try { await window.notelah!.chatResetIndex(); setError("Search index cleared. Your next question will rebuild it. Your notes are kept."); } catch (e) { setError((e as Error).message); } }}>Rebuild search index</button></div>
    </>}
    <Modal open={!!source} onOpenChange={(open) => !open && setSource(null)} title={source?.note.title ?? "Source"} className="note-editor-modal">{source && <><p className="chat-source-label">Retrieved passage{source.passage.sectionHeading ? ` · ${source.passage.sectionHeading}` : ""}{source.passage.page ? ` · PDF page ${source.passage.page}` : ""}</p><pre className="chat-source-preview">{source.passage.text}</pre>{source.note.file?.extension === "pdf" ? <button className="button secondary" onClick={async () => { try { await window.notelah!.openNoteFile(source.note.id); } catch (e) { setError((e as Error).message); } }}>Open PDF<ArrowUpRight size={14} /></button> : <details className="chat-sources"><summary>Current note contents</summary><pre className="chat-source-preview">{source.note.body}</pre></details>}<p className="chat-help">The passage reflects the answer's search. Current document contents may have changed.</p></>}</Modal>
  </>;
}
