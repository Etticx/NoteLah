import { z } from "zod";

const tools = z.enum(["list_tasks", "get_task", "search_notes", "propose_plan", "propose_tasks", "ask_user"]);
const item = z.object({ taskId: z.string().uuid(), minutes: z.number().int().min(5).max(480), reason: z.string().trim().min(1).max(400) }).strict();
const draft = z.object({ title: z.string().trim().min(1).max(160), note: z.string().trim().max(700) }).strict();
const envelope = z.object({ tool: tools, query: z.unknown().optional(), taskId: z.unknown().optional(), summary: z.unknown().optional(), items: z.unknown().optional(), drafts: z.unknown().optional(), assumptions: z.unknown().optional() }).strict();

export function wantsTaskBreakdown(question: string): boolean {
  if (/\b(?:my|our|existing|unfinished|current|pending|open)\s+(?:unfinished\s+)?tasks?\b/i.test(question)
    && !/\b(?:new tasks?|break\s*down|what tasks?|checklist for)\b/i.test(question)) return false;
  return /\b(?:break\s*down|checklist|to-?do list|action (?:items|steps)|what (?:tasks?|steps?))\b|\b(?:list|suggest|create|draft|generate|add|give)\b[\s\S]{0,200}\b(?:tasks?|steps?|checklist)\b/i.test(question);
}

export function selectedGoalDomain(question: string): number | null {
  const match = /\b(?:on|in|selected|chosen|chose|picked|focus(?:ing)? on)\s+(?:the\s+)?(?:(first|second|third|[1-9])\s+domain|domain\s*(first|second|third|[1-9]))\b/i.exec(question);
  const value = match?.[1] ?? match?.[2];
  const ordinals: Record<string, number> = { first: 1, second: 2, third: 3 };
  return value ? (ordinals[value.toLowerCase()] ?? Number(value)) : null;
}

export function mixesDomains(text: string): boolean {
  return /\b(?:both domains|two domains|each domain|per domain|connecting (?:your )?(?:two|both) domains|intersection of (?:your )?(?:two|both) domains)\b/i.test(text);
}

export function planningClarification(question: string): string | null {
  if (wantsTaskBreakdown(question)) return null;
  // A conservative English scope check, not a general intent classifier. Ask rather than invent a schedule.
  const exploration = /\b(research|brainstorm|ideas?|themes?|tracks?|requirements?)\b|\bwhat (?:to do|can (?:i|we) (?:build|make))\b/i.test(question);
  const scheduling = /\b(plan|planning|schedule|scheduling|prioriti[sz]e|replan|allocate|organize|organise|timebox|minutes?|hours?)\b|\bwork on\b/i.test(question);
  return exploration && !scheduling ? "Would you like to explore this topic or schedule an existing task? Plan my day schedules unfinished tasks; it doesn't research project ideas or verify event rules. Use Ask my notes for documents you've imported, or name an existing task and ask me to plan time for it. Neither mode browses the web." : null;
}

export function parseAgentAction(content: string) {
  const raw = envelope.parse(JSON.parse(content));
  // Unused fields cannot authorize anything. Validate only the arguments of the selected tool.
  const result = { tool: raw.tool, query: "", taskId: "", summary: "", items: [] as z.infer<typeof item>[], drafts: [] as z.infer<typeof draft>[], assumptions: [] as string[] };
  switch (raw.tool) {
    case "list_tasks": result.query = z.string().max(300).parse(raw.query ?? ""); break;
    case "search_notes": result.query = z.string().trim().min(1).max(300).parse(raw.query); break;
    case "get_task": result.taskId = z.string().uuid().parse(raw.taskId); break;
    case "ask_user": result.summary = z.string().trim().min(1).max(1000).parse(raw.summary); break;
    case "propose_plan":
      result.summary = z.string().max(1000).parse(raw.summary ?? "");
      result.items = z.array(item).min(1).max(8).parse(raw.items);
      break;
    case "propose_tasks":
      result.summary = z.string().trim().min(1).max(1000).parse(raw.summary);
      result.drafts = z.array(draft).min(1).max(6).parse(raw.drafts);
      result.assumptions = z.array(z.string().trim().min(1).max(200)).max(5).parse(raw.assumptions ?? []);
      break;
  }
  return result;
}

export function breakdownToolFormat(allowed: string[]) {
  return { type: "object", additionalProperties: false, required: ["tool", "query", "summary", "drafts", "assumptions"], properties: {
    tool: { type: "string", enum: allowed }, query: { type: "string", maxLength: 300 }, summary: { type: "string", maxLength: 1000 },
    drafts: { type: "array", maxItems: allowed.includes("propose_tasks") ? 6 : 0, items: { type: "object", additionalProperties: false, required: ["title", "note"], properties: { title: { type: "string", minLength: 1, maxLength: 160 }, note: { type: "string", maxLength: 700 } } } },
    assumptions: { type: "array", maxItems: 5, items: { type: "string", maxLength: 200 } },
  } };
}

export function agentToolFormat(allowed: string[], taskIds: string[], minutes: number) {
  return { type: "object", additionalProperties: false, required: ["tool", "query", "taskId", "summary", "items"], properties: {
    tool: { type: "string", enum: allowed }, query: { type: "string", maxLength: 300 },
    taskId: { type: "string", enum: ["", ...taskIds] }, summary: { type: "string", maxLength: 1000 },
    items: { type: "array", maxItems: Math.min(8, taskIds.length), items: { type: "object", additionalProperties: false, required: ["taskId", "minutes", "reason"], properties: {
      taskId: taskIds.length ? { type: "string", enum: taskIds } : { type: "string" }, minutes: { type: "integer", minimum: 5, maximum: minutes }, reason: { type: "string", minLength: 1, maxLength: 400 },
    } } },
  } };
}
