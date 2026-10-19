import { z } from "zod";
import type { ChatModels } from "../src/lib/rag-types";

// Only the local Ollama service can receive library text; no renderer-supplied URLs.
export class Ollama {
  constructor(private readonly base = "http://127.0.0.1:11434") {
    const url = new URL(base);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Ollama must run locally.");
  }
  async request(endpoint: string, body?: unknown, signal?: AbortSignal) {
    try {
      const response = await fetch(`${this.base}/api/${endpoint}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(body ? 240000 : 10000), ...(signal ? [signal] : [])]) });
      if (!response.ok) throw new Error((await response.text()).slice(0, 400));
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw new Error("Stopped.");
      const message = (error as Error).message;
      if (message === "fetch failed") throw new Error("Cannot reach Ollama. Open Ollama, then try again.");
      throw new Error(`Ollama: ${message}`);
    }
  }
  async models(signal?: AbortSignal): Promise<ChatModels> {
    const tags = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string() })) }).parse(await this.request("tags", undefined, signal));
    const models: ChatModels = [];
    for (const model of tags.models) {
      const details = z.object({ capabilities: z.array(z.string()).default([]), remote_host: z.string().optional(), remote_model: z.string().optional() }).parse(await this.request("show", { model: model.name }, signal));
      if (details.remote_host || details.remote_model || /cloud/i.test(model.name)) continue;
      models.push({ ...model, embedding: details.capabilities.includes("embedding"), chat: details.capabilities.includes("completion") });
    }
    return models;
  }
  async embed(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const response = z.object({ embeddings: z.array(z.array(z.number().finite()).min(1).max(8192)) }).parse(await this.request("embed", { model, input: texts, truncate: false, keep_alive: "0" }, signal));
    if (response.embeddings.length !== texts.length || response.embeddings.some((v) => !v.some((n) => n !== 0) || v.length !== response.embeddings[0].length)) throw new Error("Ollama returned invalid embeddings.");
    return response.embeddings;
  }
}
