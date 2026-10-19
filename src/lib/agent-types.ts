import type { RagSource } from "./rag-types";

export type AgentRequest = { question: string; intent?: "plan" | "breakdown"; chatModel: string; embeddingModel: string; folderId: string | null; date: string; minutes: number; preference: string; history: { question: string; summary: string }[] };
export type AgentStep = { tool: string; detail: string };
export type PlanItem = { taskId: string; title: string; previousDate: string | null; minutes: number; reason: string };
export type AgentDraftTask = { id: string; title: string; note: string };
export type AgentReply = { kind: "plan" | "task_draft" | "clarification"; summary: string; token: string | null; date: string; minutes: number; items: PlanItem[]; draftTasks?: AgentDraftTask[]; assumptions?: string[]; constraints?: string[]; sources: RagSource[]; steps: AgentStep[]; warnings: string[]; expiresAt: string | null };
export type AgentReceipt = { token: string; appliedAt: string; date: string; tasks: number; action?: "schedule" | "create" };
