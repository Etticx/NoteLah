import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentService } from "../electron/agent";
import { DatabaseStore } from "../electron/database";
import { Ollama } from "../electron/ollama";
import { createNote, createTask } from "../src/lib/model";
import type { AgentRequest } from "../src/lib/agent-types";
import { agentToolFormat, parseAgentAction, planningClarification, selectedGoalDomain, wantsTaskBreakdown } from "../electron/agent-tools";

const tool = (name: string, fields = {}) => ({ tool: name, query: "", taskId: "", summary: "A realistic plan", items: [], ...fields });
class Planner extends Ollama {
  actions: unknown[] = [];
  prompts: unknown[] = [];
  delay = false;
  override async models() { return [{ name: "chat", digest: "1", chat: true, embedding: false }]; }
  override async request(_endpoint: string, body?: unknown, signal?: AbortSignal) {
    this.prompts.push(structuredClone(body));
    if (this.delay) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 1000); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Stopped")); }, { once: true }); });
    return { message: { content: JSON.stringify(this.actions.shift() ?? tool("list_tasks")) } };
  }
}
async function setup() {
  const root = path.resolve("work", `agent-test-${crypto.randomUUID()}`), store = new DatabaseStore(root);
  await store.initialize(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const state = store.load();
  const task = createTask("Prepare hackathon prototype", null, "Do not change this note");
  state.tasks.push(task, { ...createTask("Already finished", "2026-10-18"), completedAt: new Date().toISOString() });
  state.profile.name = "Test person"; state.notes.push(createNote("Brief", "Finish a prototype.", null)); await store.save(state);
  const llm = new Planner(); let searches = 0;
  const agent = new AgentService(store, { search: async () => { searches++; return { sources: [], warnings: [] }; }, cancel() {} }, llm);
  const request: AgentRequest = { question: "Plan my work using the notes", chatModel: "chat", embeddingModel: "embed", folderId: null, date: "2026-10-20", minutes: 60, preference: "Short sessions", history: [] };
  const propose = (minutes = 30, taskId = task.id) => tool("propose_plan", { items: [{ taskId, minutes, reason: "Work on the prototype" }] });
  return { root, store, task, state, llm, agent, request, propose, get searches() { return searches; }, async cleanup() { agent.clear(); store.close(); assert.ok(root.startsWith(path.resolve("work") + path.sep)); await fs.rm(root, { recursive: true, force: true }); } };
}

test("agent reads tasks and notes without writes; approval changes only dates and undo restores the workspace", async () => {
  const f = await setup();
  try {
    const original = await fs.readFile(f.store.databasePath);
    f.llm.actions = [tool("list_tasks"), tool("get_task", { taskId: f.task.id }), tool("search_notes", { query: "prototype" }), f.propose()];
    const reply = await f.agent.plan(f.request);
    assert.equal(reply.kind, "plan"); assert.equal(reply.items[0].title, f.task.title); assert.equal(f.searches, 1);
    assert.deepEqual(await fs.readFile(f.store.databasePath), original, "Planning cannot change any source database bytes");
    const saved = await f.agent.apply(reply.token!);
    assert.equal(saved.state.tasks[0].plannedDate, "2026-10-20");
    assert.equal(saved.state.tasks[0].note, f.task.note); assert.deepEqual(saved.state.notes, f.state.notes);
    assert.deepEqual(saved.state.profile, f.state.profile); assert.deepEqual(saved.state.tasks[1], f.state.tasks[1]);
    await assert.rejects(() => f.agent.apply(reply.token!), /expired|already/);
    assert.deepEqual(await f.agent.undo(saved.receipt.token), f.state);
    await assert.rejects(() => f.agent.undo(saved.receipt.token), /expired|already/);
  } finally { await f.cleanup(); }
});

test("agent rejects invented tools, uninspected IDs, duplicate tasks, and excessive time", async () => {
  const f = await setup();
  try {
    for (const actions of [
      [tool("delete_all_tasks")], [f.propose()], [tool("list_tasks"), f.propose(30, crypto.randomUUID())],
      [tool("list_tasks"), f.propose(65)], [tool("list_tasks"), tool("propose_plan", { items: [f.propose().items[0], f.propose().items[0]] })],
    ]) {
      f.llm.actions = actions; await assert.rejects(() => f.agent.plan(f.request)); assert.deepEqual(f.store.load(), f.state);
    }
  } finally { await f.cleanup(); }
});

test("stale proposals and undo cannot overwrite newer task or note edits", async () => {
  const f = await setup();
  try {
    f.llm.actions = [tool("list_tasks"), f.propose()]; const plan = await f.agent.plan(f.request);
    const edited = f.store.load(); edited.tasks[0].note = "Newer work"; await f.store.save(edited);
    await assert.rejects(() => f.agent.apply(plan.token!), /workspace changed/);
    f.llm.actions = [tool("list_tasks"), f.propose()]; const next = await f.agent.plan(f.request); const receipt = await f.agent.apply(next.token!);
    const after = f.store.load(); after.notes[0].body = "New content"; await f.store.save(after);
    await assert.rejects(() => f.agent.undo(receipt.receipt.token), /workspace changed/);
    assert.deepEqual(f.store.load(), after);
  } finally { await f.cleanup(); }
});

test("agent enforces tool-loop and search limits and allows clarification without any write", async () => {
  const f = await setup();
  try {
    await assert.rejects(() => f.agent.plan(f.request), /8-step limit/);
    f.llm.actions = [tool("search_notes", { query: "prototype" }), tool("search_notes", { query: "again" })];
    await assert.rejects(() => f.agent.plan(f.request), /search limit/);
    f.llm.actions = [tool("ask_user", { summary: "Which task matters most?" })];
    const answer = await f.agent.plan(f.request); assert.equal(answer.kind, "clarification"); assert.equal(answer.token, null);
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

test("Stop cancels the tool loop, prevents simultaneous requests, and leaves no approval token", async () => {
  const f = await setup();
  try {
    f.llm.delay = true; const run = f.agent.plan(f.request);
    await assert.rejects(() => f.agent.plan(f.request), /already running/);
    f.agent.cancel(); await assert.rejects(() => run, /Stopped/);
    assert.equal(f.agent.status.busy, false); assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

test("expired approvals and cleared sessions cannot be applied", async () => {
  const f = await setup();
  try {
    f.llm.actions = [tool("list_tasks"), f.propose()]; const reply = await f.agent.plan(f.request);
    const now = Date.now;
    try { Date.now = () => now() + 31 * 60_000; await assert.rejects(() => f.agent.apply(reply.token!), /expired/); }
    finally { Date.now = now; }
    f.llm.actions = [tool("list_tasks"), f.propose()]; const second = await f.agent.plan(f.request); f.agent.clear();
    await assert.rejects(() => f.agent.apply(second.token!), /expired/);
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

test("failed recovery backup blocks applying a plan without changing any task", async () => {
  const f = await setup();
  try {
    f.llm.actions = [tool("list_tasks"), f.propose()]; const reply = await f.agent.plan(f.request);
    const backup = f.store.backupBeforeRestore;
    f.store.backupBeforeRestore = async () => { throw new Error("Backup unavailable"); };
    try { await assert.rejects(() => f.agent.apply(reply.token!), /Backup unavailable/); }
    finally { f.store.backupBeforeRestore = backup; }
    assert.deepEqual(f.store.load(), f.state);
    assert.equal((await f.agent.apply(reply.token!)).state.tasks[0].plannedDate, f.request.date);
  } finally { await f.cleanup(); }
});

test("a task edit during inference rejects the proposal and preserves the newer edit", async () => {
  const f = await setup();
  try {
    f.llm.actions = [tool("list_tasks"), f.propose()];
    const generate = f.llm.request.bind(f.llm);
    let calls = 0;
    f.llm.request = async (...args) => {
      if (++calls === 2) { const edited = f.store.load(); edited.tasks[0].note = "Changed during planning"; await f.store.save(edited); }
      return generate(...args);
    };
    await assert.rejects(() => f.agent.plan(f.request), /workspace changed while planning/);
    assert.equal(f.store.load().tasks[0].note, "Changed during planning");
    assert.equal(f.store.load().tasks[0].plannedDate, null);
  } finally { await f.cleanup(); }
});

test("clarifications validate their own arguments and discard unused malformed plan fields", () => {
  const action = parseAgentAction(JSON.stringify({ tool: "ask_user", summary: "Please import the hackathon brief or use Ask my notes.", query: null, taskId: "not-a-task-id", items: [{ taskId: "", minutes: 0, reason: "" }] }));
  assert.equal(action.tool, "ask_user"); assert.deepEqual(action.items, []); assert.equal(action.taskId, "");
  assert.throws(() => parseAgentAction(JSON.stringify({ tool: "get_task", taskId: "invented" })));
  assert.throws(() => parseAgentAction(JSON.stringify({ tool: "search_notes", query: null })));
  assert.throws(() => parseAgentAction(JSON.stringify({ tool: "propose_plan", summary: "Bad IDs", items: [{ taskId: "invented", minutes: 10, reason: "x" }] })));
  assert.throws(() => parseAgentAction(JSON.stringify({ tool: "delete_all_tasks" })));
  const id = crypto.randomUUID(), format = agentToolFormat(["propose_plan", "ask_user"], [id], 30);
  assert.deepEqual(format.properties.taskId.enum, ["", id]);
  assert.deepEqual(format.properties.items.items.properties.taskId.enum, [id]);
  assert.equal(format.properties.items.items.properties.minutes.maximum, 30);
});

test("one invalid model response can be corrected without executing it", async () => {
  const f = await setup();
  try {
    f.llm.actions = [{ tool: "delete_all_tasks" }, tool("ask_user", { summary: "Use Ask my notes to explore your imported brief." })];
    const reply = await f.agent.plan({ ...f.request, question: "Plan time for my existing hackathon research task." });
    assert.equal(reply.kind, "clarification"); assert.equal(reply.token, null); assert.equal(f.llm.prompts.length, 2);
    assert.equal(reply.steps.filter(s => s.tool === "validation").length, 1);
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

test("repeated malformed model output returns a helpful clarification without a write token", async () => {
  const f = await setup();
  try {
    f.llm.actions = [{ tool: "unknown" }, { tool: "unknown" }];
    const reply = await f.agent.plan(f.request);
    assert.equal(reply.kind, "clarification"); assert.equal(reply.token, null); assert.equal(f.llm.prompts.length, 2);
    assert.match(reply.summary, /Ask my notes/); assert.match(reply.summary, /can't browse the web/);
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

test("broad hackathon research asks for scope clarification before model calls or scheduling unrelated tasks", async () => {
  const f = await setup();
  try {
    const question = "i wanna research about what to do on SDC Hackathon it has 2 theme, many track of SDG it must use replit and repod";
    const reply = await f.agent.plan({ ...f.request, question });
    assert.equal(reply.kind, "clarification"); assert.equal(reply.token, null); assert.deepEqual(reply.items, []);
    assert.equal(f.llm.prompts.length, 0); assert.match(reply.summary, /Ask my notes/);
    assert.equal(planningClarification("Plan 30 minutes for my hackathon research task"), null);
    assert.equal(planningClarification("Research my notes and plan my day"), null);
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

const breakdownQuestion = "so can u list down if i wanna research about my SDC hackathon project, what task i need to do? i have 2 domains im on second domain and has many SDG tracks";
const proposeTasks = (drafts = [{ title: "Compare research problems in the selected domain", note: "Compare impact and feasibility for the second domain before choosing a problem." }, { title: "Verify the official brief and track requirements", note: "Read the organiser's brief; confirm eligible SDG tracks and tools." }]) => ({ tool: "propose_tasks", summary: "Suggested research checklist for your selected domain", query: "", drafts, assumptions: ["The official track names and rules still need to be verified."] });

test("task-breakdown wording bypasses the overbroad research gate and drafts new unscheduled tasks with review and undo", async () => {
  const f = await setup();
  try {
    assert.equal(wantsTaskBreakdown(breakdownQuestion), true); assert.equal(planningClarification(breakdownQuestion), null);
    assert.equal(wantsTaskBreakdown("List my tasks and search my hackathon notes. Propose a 60-minute plan for the hackathon prototype and slides."), false);
    assert.equal(wantsTaskBreakdown("List unfinished tasks and plan my day"), false);
    const original = await fs.readFile(f.store.databasePath);
    f.llm.actions = [tool("list_tasks"), proposeTasks()];
    const reply = await f.agent.plan({ ...f.request, question: breakdownQuestion });
    assert.equal(reply.kind, "task_draft"); assert.equal(reply.items.length, 0); assert.equal(reply.draftTasks?.length, 2);
    const prompt = f.llm.prompts[0] as { messages: { content: string }[] };
    const userContext = JSON.parse(prompt.messages[1].content);
    assert.equal("timeBudgetMinutes" in userContext, false); assert.equal("date" in userContext, false);
    assert.equal(userContext.selectedDomain, 2); assert.match(reply.constraints!.join(" "), /domain 2/);
    assert.ok(reply.assumptions?.length); assert.deepEqual(await fs.readFile(f.store.databasePath), original);
    const added = await f.agent.apply(reply.token!); assert.equal(added.receipt.action, "create");
    assert.deepEqual(added.state.tasks.slice(0, f.state.tasks.length), f.state.tasks);
    assert.equal(added.state.tasks.length, f.state.tasks.length + 2);
    assert.ok(added.state.tasks.slice(f.state.tasks.length).every(t => t.plannedDate === null && !t.completedAt && t.note.includes(breakdownQuestion)));
    assert.deepEqual(added.state.notes, f.state.notes); assert.deepEqual(added.state.profile, f.state.profile);
    await assert.rejects(() => f.agent.apply(reply.token!), /already|expired/);
    assert.deepEqual(await f.agent.undo(added.receipt.token), f.state);
  } finally { await f.cleanup(); }
});

test("explicit breakdown mode works without keyword routing and removes duplicate task titles before review", async () => {
  const f = await setup();
  try {
    f.llm.actions = [tool("list_tasks"), proposeTasks([{ title: f.task.title.toUpperCase(), note: "Existing task" }, { title: "Read background research", note: "Find evidence for the selected problem." }, { title: "Read background research", note: "Duplicate" }])];
    const reply = await f.agent.plan({ ...f.request, intent: "breakdown", question: "Help me get started with the selected domain." });
    assert.equal(reply.kind, "task_draft"); assert.equal(reply.draftTasks?.length, 1); assert.match(reply.warnings.join(" "), /Duplicate/);
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

test("new-task drafts remain stale-protected and cannot use scheduling tools in breakdown mode", async () => {
  const f = await setup();
  try {
    f.llm.actions = [tool("list_tasks"), proposeTasks()];
    const reply = await f.agent.plan({ ...f.request, question: breakdownQuestion });
    const next = f.store.load(); next.tasks[0].note = "Newer work"; await f.store.save(next);
    await assert.rejects(() => f.agent.apply(reply.token!), /workspace changed/); assert.deepEqual(f.store.load(), next);
    f.llm.actions = [tool("list_tasks"), f.propose(), f.propose()];
    const stopped = await f.agent.plan({ ...f.request, intent: "breakdown", question: "Help me start" });
    assert.equal(stopped.kind, "clarification"); assert.equal(stopped.token, null); assert.deepEqual(f.store.load(), next);
    assert.throws(() => parseAgentAction(JSON.stringify(proposeTasks([{ title: "", note: "Invalid task" }]))));
  } finally { await f.cleanup(); }
});

test("a selected-domain goal rejects cross-domain drafts and permits one corrected checklist", async () => {
  const f = await setup();
  try {
    assert.equal(selectedGoalDomain(breakdownQuestion), 2); assert.equal(selectedGoalDomain("I chose domain 3"), 3);
    f.llm.actions = [tool("list_tasks"), proposeTasks([{ title: "Combine both domains", note: "Research both domains." }]), proposeTasks()];
    const reply = await f.agent.plan({ ...f.request, question: breakdownQuestion });
    assert.equal(reply.kind, "task_draft"); assert.equal(reply.steps.filter(step => step.tool === "validation").length, 1);
    assert.ok(reply.draftTasks?.every(t => !/both domains/.test(t.title + t.note)));
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});

test("an over-budget day plan can use one correction attempt while the original is never approved", async () => {
  const f = await setup();
  try {
    f.llm.actions = [tool("list_tasks"), f.propose(65), f.propose(30)];
    const reply = await f.agent.plan(f.request);
    assert.equal(reply.kind, "plan"); assert.equal(reply.items.reduce((sum, i) => sum + i.minutes, 0), 30);
    assert.equal(reply.steps.filter(step => step.tool === "validation").length, 1);
    assert.deepEqual(f.store.load(), f.state);
  } finally { await f.cleanup(); }
});
