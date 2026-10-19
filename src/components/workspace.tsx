"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Circle, MessageCircle, FileText, Folder, HardDrive, Inbox, Leaf, Menu, MoreHorizontal, Pencil, Plus, Search, Settings2, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import Modal from "./dialog";
import ActivityGrid from "./activity-grid";
import ChatWorkspace from "./chat-workspace";
import NotesWorkspace, { formatBytes } from "./notes-workspace";
import { createTask, emptyWorkspace, type RestorePreview, type StorageInfo, type Task, type WorkspaceState } from "@/lib/model";
import { backupWorkspace, exportWorkspace, importBrowserFile, loadWorkspace, restoreBrowser, saveWorkspace } from "@/lib/storage";
import { completionDay, friendlyDay, localDate, parseDay, shiftDay } from "@/lib/dates";

type View = "today" | "later" | "notes" | "chat" | "profile" | "settings";
type Status = "loading" | "saved" | "saving" | "error";
const navigation: { id: View; label: string; icon: typeof CalendarDays }[] = [
  { id: "today", label: "Today", icon: CalendarDays }, { id: "later", label: "Later", icon: Inbox }, { id: "notes", label: "Notes", icon: FileText }, { id: "chat", label: "Chat", icon: MessageCircle }, { id: "profile", label: "My profile", icon: UserRound }, { id: "settings", label: "Settings", icon: Settings2 },
];

export default function Workspace() {
  const [state, setState] = useState<WorkspaceState>(emptyWorkspace);
  const stateRef = useRef(state);
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("today");
  const [selectedDay, setSelectedDay] = useState("2000-01-01");
  const [today, setToday] = useState("2000-01-01");
  const [entry, setEntry] = useState("");
  const [editing, setEditing] = useState<Task | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [restore, setRestore] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [deleteTask, setDeleteTask] = useState<Task | null>(null);
  const [isSample, setIsSample] = useState(false);
  const sampleRef = useRef(false);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const statusRef = useRef(status);
  const addInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const noteDraftDirty = useRef(false);
  const setNoteDraftDirty = useCallback((dirty: boolean) => { noteDraftDirty.current = dirty; window.notelah?.setDirty(dirty || statusRef.current === "saving" || statusRef.current === "error"); }, []);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => {
    let mounted = true;
    setToday(localDate()); setSelectedDay(localDate());
    loadWorkspace().then((result) => { if (mounted) { stateRef.current = result.state; setState(result.state); setInfo(result.info); setStatus("saved"); } }).catch((error: Error) => { if (mounted) { setError(error.message); setStatus("error"); } });
    const syncView = () => { const hash = window.location.hash.slice(1); if (navigation.some((item) => item.id === hash)) { if (noteDraftDirty.current && hash !== "notes" && !window.confirm("Discard unsaved note changes?")) { window.history.replaceState(null, "", "#notes"); return; } setView(hash as View); } };
    syncView(); window.addEventListener("hashchange", syncView);
    const interval = window.setInterval(() => setToday(localDate()), 30000);
    const unload = (event: BeforeUnloadEvent) => { if (noteDraftDirty.current || statusRef.current === "saving" || statusRef.current === "error") { event.preventDefault(); } };
    window.addEventListener("beforeunload", unload);
    return () => { mounted = false; clearInterval(interval); window.removeEventListener("hashchange", syncView); window.removeEventListener("beforeunload", unload); };
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen((open) => !open); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); if (noteDraftDirty.current && !window.confirm("Discard unsaved note changes?")) return; setView("today"); setSelectedDay(localDate()); setTimeout(() => addInput.current?.focus(), 0); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(""), 5500); return () => clearTimeout(timeout); }, [notice]);

  const go = useCallback((target: View) => { setView(target); window.history.replaceState(null, "", `#${target}`); setMobileNav(false); if (target === "today") setSelectedDay(localDate()); setEntry(""); }, []);

  const persist = useCallback((next: WorkspaceState) => {
    if (sampleRef.current) { stateRef.current = next; setState(next); return; }
    stateRef.current = next; setState(next); statusRef.current = "saving"; setStatus("saving"); setError(""); window.notelah?.setDirty(true);
    const currentRevision = ++revision.current;
    queue.current = queue.current.catch(() => undefined).then(() => saveWorkspace(next)).then((storageInfo) => {
      if (currentRevision === revision.current) { setInfo(storageInfo); statusRef.current = "saved"; setStatus("saved"); window.notelah?.setDirty(noteDraftDirty.current); }
    }).catch((error: Error) => { if (currentRevision === revision.current) { statusRef.current = "error"; setStatus("error"); setError(error.message); } });
  }, []);

  const updateTask = (id: string, fields: Partial<Task>) => persist({ ...stateRef.current, tasks: stateRef.current.tasks.map((task) => task.id === id ? { ...task, ...fields, updatedAt: new Date().toISOString() } : task) });
  const toggle = (task: Task) => updateTask(task.id, { completedAt: task.completedAt ? null : new Date().toISOString() });
  const addTask = (event: React.FormEvent) => {
    event.preventDefault();
    if (!entry.trim() || !info) return;
    const task = createTask(entry, view === "later" ? null : selectedDay);
    persist({ ...stateRef.current, tasks: [...stateRef.current.tasks, task] }); setEntry(""); addInput.current?.focus();
  };

  const unfinished = state.tasks.filter((task) => !task.completedAt);
  const laterCount = unfinished.filter((task) => !task.plannedDate).length;
  const dayTasks = state.tasks.filter((task) => task.plannedDate === selectedDay || (!!task.completedAt && completionDay(task.completedAt) === selectedDay));
  const visible = view === "later" ? state.tasks.filter((task) => task.plannedDate === null) : dayTasks;
  const pending = visible.filter((task) => !task.completedAt);
  const completed = visible.filter((task) => !!task.completedAt);
  const overdue = unfinished.filter((task) => task.plannedDate && task.plannedDate < today);
  const weekStart = shiftDay(selectedDay, -((parseDay(selectedDay).getDay() - state.settings.weekStartsOn + 7) % 7));
  const week = Array.from({ length: 7 }, (_, index) => shiftDay(weekStart, index));
  const selectedIsToday = selectedDay === today;
  const currentNavigation = navigation.find((item) => item.id === view)!;
  const completedAll = state.tasks.filter((task) => task.completedAt);
  const activeDays = new Set(completedAll.map((task) => completionDay(task.completedAt!))).size;
  const thisMonth = completedAll.filter((task) => completionDay(task.completedAt!).slice(0, 7) === today.slice(0, 7)).length;
  const initials = state.profile.name ? state.profile.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() : "N";
  const searchResults = useMemo(() => query.trim() ? state.tasks.filter((task) => `${task.title} ${task.note}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30) : [...state.tasks].reverse().slice(0, 6), [query, state.tasks]);

  async function action(operation: () => Promise<void>) {
    setBusy(true);
    try { if (sampleRef.current) throw new Error("Leave the sample workspace to manage your own backups and exports."); await queue.current; if (statusRef.current === "error") throw new Error("Save your changes before continuing. Use Retry in the save message."); await operation(); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  async function doBackup() { await action(async () => { const result = await backupWorkspace(stateRef.current); if (!result.canceled) { setNotice("Backup saved."); setInfo((current) => current ? { ...current, lastBackup: new Date().toISOString() } : current); } }); }
  async function doExport(format: "json" | "csv") { await action(async () => { const result = await exportWorkspace(stateRef.current, format); if (!result.canceled) setNotice(`${format.toUpperCase()} export saved.`); }); }
  async function chooseRestore() { await action(async () => { if (window.notelah) setRestore(await window.notelah.selectRestore()); else importInput.current?.click(); }); }
  async function confirmRestore() {
    if (!restore) return;
    await action(async () => {
      if (window.notelah) { const result = await window.notelah.restore(restore.token); stateRef.current = result.state; setState(result.state); setInfo(result.info); }
      else { await restoreBrowser(restore.state); stateRef.current = restore.state; setState(restore.state); }
      setStatus("saved"); setRestore(null); setNotice("Your workspace has been restored.");
    });
  }

  function sampleWorkspace() {
    if (state.tasks.length) return;
    const titles = ["Outline the first chapter", "Read a little, take a few notes", "Make time for a walk", "Finish the project proposal", "Tidy up the desk"];
    const tasks = titles.map((title, index) => ({ ...createTask(title, today, index === 0 ? "Start with the main idea. The details can follow." : ""), completedAt: index >= 3 ? new Date().toISOString() : null }));
    tasks.push(createTask("Try that idea for the weekend", null));
    for (let offset = 1; offset < 100; offset++) if (offset % 4 !== 0 && offset % 7 !== 0) for (let i = 0; i < offset % 5 + 1; i++) {
      const date = shiftDay(today, -offset);
      const at = new Date(`${date}T12:00:00`).toISOString();
      tasks.push({ ...createTask(["Worked on my project", "Reviewed my notes", "Read a chapter", "Cleared a small task", "Practised something new"][i], date), completedAt: at, createdAt: at, updatedAt: at });
    }
    const sample = { ...stateRef.current, tasks, profile: { name: "Alex", role: "Student · making a little progress every day", bio: "A place for the things I want to do, and the things I've done." } };
    sampleRef.current = true; setIsSample(true); stateRef.current = sample; setState(sample);
    setNotice("You're exploring a sample. Your own workspace stays separate.");
  }

  async function leaveSample() {
    try { const result = await loadWorkspace(); sampleRef.current = false; setIsSample(false); stateRef.current = result.state; setState(result.state); setInfo(result.info); setNotice(""); }
    catch (error) { setNotice((error as Error).message); }
  }

  function TaskList({ items, done = false }: { items: Task[]; done?: boolean }) {
    return <div className="task-list">{items.map((task) => <div className={`task-row${done ? " is-complete" : ""}`} key={task.id}>
      <button className="task-check" role="checkbox" aria-checked={done} aria-label={`${done ? "Reopen" : "Complete"} ${task.title}`} onClick={() => toggle(task)}>{done && <Check size={13} strokeWidth={2.4} />}</button>
      <button className="task-copy" onClick={() => setEditing(task)}><span className="task-title">{task.title}</span>{task.note && <span className="task-note">{task.note.split("\n")[0]}</span>}</button>
      {task.note && <FileText className="note-indicator" size={14} aria-label="Has notes" />}
      {done && task.completedAt && completionDay(task.completedAt) !== selectedDay && view === "today" && <span className="task-date">Done {friendlyDay(completionDay(task.completedAt), { day: "numeric", month: "short" })}</span>}
      <Dropdown.Root><Dropdown.Trigger className="icon-button task-menu" aria-label={`Options for ${task.title}`}><MoreHorizontal size={18} /></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown" align="end" sideOffset={6}>
        <Dropdown.Item onSelect={() => setEditing(task)}><Pencil size={14} />Edit task</Dropdown.Item>
        {!task.completedAt && <><Dropdown.Item onSelect={() => updateTask(task.id, { plannedDate: today })}><CalendarDays size={14} />Move to today</Dropdown.Item><Dropdown.Item onSelect={() => updateTask(task.id, { plannedDate: shiftDay(today, 1) })}><ArrowRight size={14} />Move to tomorrow</Dropdown.Item>{task.plannedDate && <Dropdown.Item onSelect={() => updateTask(task.id, { plannedDate: null })}><Inbox size={14} />Move to Later</Dropdown.Item>}</>}
        <Dropdown.Separator /><Dropdown.Item className="danger" onSelect={() => setDeleteTask(task)}><Trash2 size={14} />Delete task</Dropdown.Item>
      </Dropdown.Content></Dropdown.Portal></Dropdown.Root>
    </div>)}</div>;
  }

  return <div className="app-shell">
    <aside className={`sidebar${mobileNav ? " is-open" : ""}`}>
      <button className="brand" onClick={() => go("today")} aria-label="NoteLah home"><span className="brand-icon"><FileText size={20} strokeWidth={1.7} /></span><span>NoteLah<span className="brand-dot">.</span></span></button>
      <button className="workspace-label" onClick={() => go("profile")}><span className="workspace-avatar">{initials}</span><span>{state.profile.name ? `${state.profile.name.split(" ")[0]}'s workspace` : "Your workspace"}</span><ChevronDown size={13} /></button>
      <button className="sidebar-search" onClick={() => setSearchOpen(true)}><Search size={16} /><span>Quick search</span><kbd>Ctrl K</kbd></button>
      <p className="nav-caption">WORKSPACE</p>
      <nav aria-label="Main navigation">{navigation.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item${view === id ? " selected" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => go(id)}><Icon size={17} strokeWidth={1.65} /><span>{label}</span>{id === "later" && laterCount > 0 && <span className="nav-count">{laterCount}</span>}</button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-note"><Leaf size={18} strokeWidth={1.5} /><p>A place for your everyday.</p><span>One thing at a time.</span></div>
      <div className="sidebar-footer"><span className="status-dot" /><span>{info?.mode === "desktop" ? "On your laptop" : "Saved in this browser"}</span><button className="icon-button" aria-label="Storage settings" onClick={() => go("settings")}><HardDrive size={14} /></button></div>
    </aside>
    {mobileNav && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={19} /></button><span className="breadcrumb-workspace">Workspace</span><span className="breadcrumb-divider">/</span><currentNavigation.icon size={14} /><span>{currentNavigation.label}</span></div><div className={`save-status ${status}`} role="status" aria-live="polite">{status === "saved" ? <Check size={13} /> : status === "error" ? <Circle size={11} /> : <span className="saving-dot" />}<span>{isSample ? "Sample workspace" : status === "saved" ? "All changes saved" : status === "saving" ? "Saving…" : status === "loading" ? "Opening workspace…" : "Changes not saved"}</span></div></header>
      {isSample && <div className="sample-banner"><span>Sample workspace · changes here aren't saved</span><button className="text-button" onClick={leaveSample}>Back to my workspace<ArrowRight size={13} /></button></div>}
      {status === "error" && <div className="error-banner" role="alert"><span>{error || "Your changes couldn't be saved."}</span><button className="text-button" onClick={() => info ? persist(stateRef.current) : window.location.reload()}>{info ? "Retry save" : "Try again"}</button></div>}
      <main className={`content content-${view}`}>
        <div hidden={view !== "chat"}><ChatWorkspace state={state} enabled={info?.mode === "desktop" && !isSample && status === "saved"} visible={view === "chat"} /></div>
        {status === "loading" ? <div className="loading-state"><FileText size={28} /><p>Opening your workspace…</p></div> : view === "chat" ? null : (view === "today" || view === "later") ? <>
          <div className="page-heading"><div><div className="page-eyebrow">{view === "today" ? friendlyDay(selectedDay, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "A little space for what's next"}</div><h1>{view === "later" ? "Later" : selectedIsToday ? "Today" : friendlyDay(selectedDay, { weekday: "long" })}<span className="heading-period">.</span></h1><p className="page-subtitle">{view === "later" ? "Catch a thought. Give it a day when you're ready." : visible.length ? `${completed.length} of ${visible.length} tasks completed${pending.length === 0 ? " · You're all done for this day." : ""}` : "What would you like to get done?"}</p></div>{view === "today" && <div className="date-actions"><button className="icon-button" aria-label="Previous day" onClick={() => setSelectedDay(shiftDay(selectedDay, -1))}><ChevronLeft size={17} /></button><label className="date-picker"><CalendarDays size={15} /><input type="date" aria-label="Choose a day" value={selectedDay} onChange={(event) => event.target.value && setSelectedDay(event.target.value)} /></label><button className="icon-button" aria-label="Next day" onClick={() => setSelectedDay(shiftDay(selectedDay, 1))}><ChevronRight size={17} /></button></div>}</div>
          {view === "today" && <div className="week-strip" aria-label="Week overview">{week.map((day) => {
            const scheduled = state.tasks.filter((task) => task.plannedDate === day);
            const count = scheduled.filter((task) => task.completedAt).length;
            return <button key={day} onClick={() => setSelectedDay(day)} className={`week-day${day === selectedDay ? " active" : ""}${day === today ? " today" : ""}`} aria-pressed={day === selectedDay} aria-label={`${friendlyDay(day)}, ${scheduled.length} planned tasks`}><span>{friendlyDay(day, { weekday: "short" })}</span><strong>{parseDay(day).getDate()}</strong><div className="week-marks">{scheduled.length ? <><span className={count > 0 ? "has-completed" : "has-tasks"} /><span className="week-task-count">{scheduled.length}</span></> : <span className="no-tasks" />}</div></button>;
          })}</div>}
          {view === "today" && selectedIsToday && overdue.length > 0 && <div className="carryover"><div><ArrowRight size={15} /><span>{overdue.length} unfinished task{overdue.length === 1 ? "" : "s"} from earlier days</span></div><button className="text-button" onClick={() => persist({ ...stateRef.current, tasks: stateRef.current.tasks.map((task) => overdue.some((old) => old.id === task.id) ? { ...task, plannedDate: today, updatedAt: new Date().toISOString() } : task) })}>Bring to today</button></div>}
          <section className="tasks-section"><div className="section-heading"><h2>{view === "later" ? "Ideas & things to do" : "To do"}<span className="section-count">{pending.length}</span></h2><span className="section-hint">{view === "later" ? "No date needed" : "Keep it manageable"}</span></div>
            <TaskList items={pending} />
            <form className="add-task" onSubmit={addTask}><Plus size={19} strokeWidth={1.65} /><input ref={addInput} aria-label={view === "later" ? "Add an idea for later" : "Add a task"} placeholder={view === "later" ? "Something on your mind?" : "Add something to do…"} value={entry} maxLength={500} disabled={!info || busy} onChange={(event) => setEntry(event.target.value)} /><button type="submit" disabled={!entry.trim() || !info} className={entry.trim() ? "add-submit" : "add-key"} aria-label="Add task">{entry.trim() ? <ArrowRight size={16} /> : <kbd>↵</kbd>}</button></form>
            {!visible.length && <div className="empty-note"><span className="empty-rule" /><p>{view === "later" ? "A thought doesn't need a plan yet." : "Start with one thing. The rest can follow."}</p></div>}
          </section>
          {completed.length > 0 && <section className="completed-section"><div className="section-heading"><h2><CheckCheck size={16} />Completed<span className="section-count">{completed.length}</span></h2></div><TaskList items={completed} done /></section>}
          {view === "today" && <footer className="day-footer"><Leaf size={15} /><span>{completed.length ? "Every finished task leaves a little green." : "Your progress will find a home on your profile."}</span><button className="text-button" onClick={() => go("profile")}>View activity<ArrowUpRight size={13} /></button></footer>}
          {!state.tasks.length && info && <button className="sample-link" onClick={sampleWorkspace}>Want to look around first? Try a sample workspace <ArrowUpRight size={12} /></button>}
        </> : view === "notes" ? <NotesWorkspace state={state} info={info} busy={busy} onChange={(update) => persist(update(stateRef.current))} onDraftDirty={setNoteDraftDirty} onImport={(folderId) => action(async () => { const result = await window.notelah!.importNotes(folderId); if (result) { stateRef.current = result.state; setState(result.state); setInfo(result.info); setNotice("Files copied into your library."); } })} onDropFiles={(folderId, files) => action(async () => { const result = await window.notelah!.importDroppedNotes(folderId, files); stateRef.current = result.state; setState(result.state); setInfo(result.info); setNotice("Files copied into your library."); })} onOpenFile={(id) => action(async () => { await window.notelah!.openNoteFile(id); })} /> : view === "profile" ? <>
          <div className="profile-cover"><div className="cover-lines" aria-hidden="true"><span /><span /><span /><span /><span /></div><span className="cover-label">THE DAYS ADD UP</span></div>
          <div className="profile-heading"><div className="profile-avatar">{initials}</div><button className="button secondary" onClick={() => setProfileOpen(true)}><Pencil size={14} />Edit profile</button></div>
          <h1 className="profile-name">{state.profile.name || "Your everyday"}<span className="heading-period">.</span></h1><p className="profile-role">{state.profile.role || "A small record of the things you do."}</p>{state.profile.bio && <p className="profile-bio">{state.profile.bio}</p>}
          <div className="profile-stats"><div><strong>{completedAll.length}</strong><span>Tasks completed</span></div><div><strong>{activeDays}</strong><span>Days with progress</span></div><div><strong>{thisMonth}</strong><span>This month</span></div></div>
          <ActivityGrid tasks={state.tasks} weekStartsOn={state.settings.weekStartsOn} onDay={(day) => { go("today"); setSelectedDay(day); }} />
          <section className="recent-section"><div className="section-heading"><h2>Recently finished</h2><span className="section-hint">The little wins</span></div>{completedAll.length ? [...completedAll].sort((a, b) => b.completedAt!.localeCompare(a.completedAt!)).slice(0, 5).map((task) => <button className="recent-row" key={task.id} onClick={() => setEditing(task)}><span className="recent-check"><Check size={12} /></span><span>{task.title}</span><time>{friendlyDay(completionDay(task.completedAt!), { day: "numeric", month: "short" })}</time></button>) : <p className="quiet-empty">Your finished tasks will appear here.</p>}</section>
        </> : <>
          <div className="page-heading"><div><div className="page-eyebrow">Make yourself at home</div><h1>Settings<span className="heading-period">.</span></h1><p className="page-subtitle">Your workspace, your data.</p></div></div>
          <section className="settings-section"><h2>Workspace</h2><div className="setting-row"><div><h3>Start the week on</h3><p>Used in your planner and activity grid.</p></div><select aria-label="Start the week on" value={state.settings.weekStartsOn} disabled={!info} onChange={(event) => persist({ ...stateRef.current, settings: { ...stateRef.current.settings, weekStartsOn: Number(event.target.value) as 0 | 1 } })}><option value={1}>Monday</option><option value={0}>Sunday</option></select></div><div className="setting-row"><div><h3>Your profile</h3><p>A name, a few words, and your progress.</p></div><button className="button secondary" onClick={() => setProfileOpen(true)}>Edit profile</button></div></section>
          <section className="settings-section"><h2>Storage & backups</h2><div className="storage-notice"><HardDrive size={20} strokeWidth={1.5} /><div><strong>{info?.mode === "desktop" ? "Your work stays on this laptop" : "You're using the browser version"}</strong><p>{info?.mode === "desktop" ? "Saved in a local SQLite database. No account or internet needed." : "Saved in this browser's local storage. The Windows app uses SQLite and can back up to a folder."}</p></div></div><div className="setting-row"><div><h3>Automatic backups</h3><p>{info?.mode === "desktop" ? "One snapshot each day you open the app. The latest seven are kept." : "Keeps up to seven daily snapshots in this browser. Export a file for a separate copy."}</p></div><button className="switch" role="switch" aria-checked={state.settings.automaticBackups} aria-label="Automatic backups" disabled={!info} onClick={() => persist({ ...stateRef.current, settings: { ...stateRef.current.settings, automaticBackups: !stateRef.current.settings.automaticBackups } })}><span /></button></div>
          {info?.backupError && <p className="backup-warning" role="alert">{info.backupError} Choose an available backup folder below.</p>}
          {info?.mode === "desktop" && <div className="setting-row"><div><h3>Imported files</h3><p>{formatBytes(info.filesBytes ?? 0)} in your library. Written notes are saved in the database.</p><p className="storage-path">{info.filesLocation}</p></div><button className="button secondary" disabled={busy} onClick={() => action(async () => { await window.notelah!.openNotesFolder(); })}><Folder size={14} />Open folder</button></div>}
          {info?.mode === "desktop" && <div className="setting-row"><div><h3>Backup folder</h3><p className="storage-path">{info.backupFolder}</p></div><button className="button secondary" disabled={busy} onClick={() => action(async () => { const result = await window.notelah!.chooseBackupFolder(); if (result) { setInfo(result); setNotice("Backup folder updated."); } })}><Folder size={14} />Choose folder</button></div>}
          <div className="setting-row"><div><h3>Back up now</h3><p>{info?.lastBackup ? `Last backup: ${new Date(info.lastBackup).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : "Save a separate copy somewhere you trust."}</p></div><button className="button secondary" disabled={busy || !info} onClick={doBackup}><ShieldCheck size={14} />Create backup</button></div><div className="setting-row"><div><h3>Restore a backup</h3><p>Preview a backup before replacing this workspace.</p></div><button className="button secondary" disabled={busy || !info} onClick={chooseRestore}><ArrowLeft size={14} />Restore</button></div></section>
          <section className="settings-section"><h2>Take your work with you</h2><div className="setting-row"><div><h3>Export everything</h3><p>Tasks, notes, folders, and imported files. A complete copy you can restore.</p></div><button className="button secondary" disabled={busy || !info} onClick={() => doExport("json")}><ArrowDownToLine size={14} />Export JSON</button></div><div className="setting-row"><div><h3>Export task list</h3><p>Open your tasks in Excel or another spreadsheet app.</p></div><button className="button secondary" disabled={busy || !info} onClick={() => doExport("csv")}><ArrowDownToLine size={14} />Export CSV</button></div></section>
          <footer className="settings-footer"><FileText size={16} /><span>NoteLah · version 0.1.0</span><span>Made for the everyday.</span></footer>
        </>}
      </main>
    </div>
    <input className="sr-only" ref={importInput} type="file" accept=".json,application/json" aria-label="Choose JSON backup" onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { const imported = await importBrowserFile(file); setRestore({ token: "browser", state: imported, date: null, fileName: file.name }); } catch (error) { setNotice((error as Error).message); } }} />
    <Modal open={!!editing} onOpenChange={(open) => !open && setEditing(null)} title="A little more detail" description="Add a note or choose when you want to work on this.">{editing && <TaskEditor key={editing.id} task={editing} onSave={(fields) => { updateTask(editing.id, fields); setEditing(null); }} onCancel={() => setEditing(null)} />}</Modal>
    <Modal open={profileOpen} onOpenChange={setProfileOpen} title="Make it yours" description="A few words for your corner of NoteLah."><ProfileEditor profile={state.profile} onSave={(profile) => { persist({ ...stateRef.current, profile }); setProfileOpen(false); }} onCancel={() => setProfileOpen(false)} /></Modal>
    <Modal open={searchOpen} onOpenChange={(open) => { setSearchOpen(open); if (!open) setQuery(""); }} title="Find something" className="search-modal"><div className="search-field"><Search size={18} /><input aria-label="Search tasks and notes" placeholder="Search tasks and notes…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus /></div><p className="search-caption">{query ? "MATCHING TASKS" : "RECENT TASKS"}</p><div className="search-results">{searchResults.length ? searchResults.map((task) => <button key={task.id} className="search-result" onClick={() => { setSearchOpen(false); setEditing(task); }}><span>{task.completedAt ? <Check size={15} /> : <Circle size={13} />}</span><div><strong>{task.title}</strong><small>{task.plannedDate ? friendlyDay(task.plannedDate, { day: "numeric", month: "short", year: "numeric" }) : "Later"}{task.note ? ` · ${task.note.slice(0, 60)}` : ""}</small></div><ArrowUpRight size={14} /></button>) : <p className="quiet-empty">{query ? "Nothing matches that search." : "Add a task and you'll be able to find it here."}</p>}</div></Modal>
    <Modal open={!!restore} onOpenChange={(open) => !busy && !open && setRestore(null)} title="Restore this workspace?" description="This replaces tasks, notes, folders, imported files, profile, and settings. A complete backup is saved first.">{restore && <><div className="restore-summary"><FileText size={22} /><div><strong>{restore.fileName}</strong><p>{restore.state.tasks.length} tasks · {restore.state.notes.length} notes · {restore.state.folders.length} folders</p>{restore.date && <p>Saved {new Date(restore.date).toLocaleString("en-GB")}</p>}</div></div><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setRestore(null)}>Cancel</button><button className="button primary" disabled={busy} onClick={confirmRestore}>{busy ? "Restoring…" : "Restore workspace"}</button></div></>}</Modal>
    <Modal open={!!deleteTask} onOpenChange={(open) => !open && setDeleteTask(null)} title="Delete this task?" description="This will also remove it from your activity history.">{deleteTask && <><p className="delete-title">{deleteTask.title}</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleteTask(null)}>Keep task</button><button className="button destructive" onClick={() => { persist({ ...stateRef.current, tasks: stateRef.current.tasks.filter((task) => task.id !== deleteTask.id) }); setDeleteTask(null); }}>Delete task</button></div></>}</Modal>
    {notice && <div className="toast" role="status" aria-live="polite"><span>{notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice("")}><X size={15} /></button></div>}
  </div>;
}

function TaskEditor({ task, onSave, onCancel }: { task: Task; onSave: (fields: Partial<Task>) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note);
  const [date, setDate] = useState(task.plannedDate ?? "");
  return <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) onSave({ title: title.trim(), note, plannedDate: date || null }); }}><label className="field-label" htmlFor="task-title">Task</label><input id="task-title" className="field-input" value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} required autoFocus /><label className="field-label" htmlFor="task-note">Notes<span>Optional</span></label><textarea id="task-note" className="field-input note-input" placeholder="A thought, a link, or where to start…" value={note} maxLength={20000} onChange={(event) => setNote(event.target.value)} /><label className="field-label" htmlFor="task-date">Planned for<span>Leave empty to keep in Later</span></label><div className="date-field"><input id="task-date" className="field-input" type="date" value={date} onChange={(event) => setDate(event.target.value)} />{date && <button type="button" className="text-button" onClick={() => setDate("")}>Clear date</button>}</div><div className="modal-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button className="button primary" type="submit" disabled={!title.trim()}>Save task</button></div></form>;
}

function ProfileEditor({ profile, onSave, onCancel }: { profile: WorkspaceState["profile"]; onSave: (profile: WorkspaceState["profile"]) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(profile);
  return <form onSubmit={(event) => { event.preventDefault(); onSave(draft); }}><label className="field-label" htmlFor="profile-name">Your name</label><input id="profile-name" className="field-input" placeholder="What should we call you?" value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus /><label className="field-label" htmlFor="profile-role">A line about you<span>Optional</span></label><input id="profile-role" className="field-input" placeholder="Student, maker, figuring things out…" value={draft.role} maxLength={160} onChange={(event) => setDraft({ ...draft, role: event.target.value })} /><label className="field-label" htmlFor="profile-bio">A few words<span>Optional</span></label><textarea id="profile-bio" className="field-input note-input" placeholder="What are you working towards?" value={draft.bio} maxLength={1000} onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /><div className="modal-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button className="button primary" type="submit">Save profile</button></div></form>;
}
