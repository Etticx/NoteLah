import type { RagSource } from "../src/lib/rag-types";

export type Chunk = Omit<RagSource, "bm25Rank" | "vectorRank" | "score" | "label"> & { vector: number[] };
export function tokenize(text: string): string[] { return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }

// Character-bounded, word-boundary chunks with overlap; never joins separate PDF pages.
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  if (size < 2 || overlap < 0 || overlap >= size) throw new Error("Invalid chunk settings");
  const clean = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf("\n", end), clean.lastIndexOf(" ", end));
      if (boundary > start + size / 2) end = boundary;
    }
    const part = clean.slice(start, end).trim();
    if (part) chunks.push(part);
    if (end === clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) throw new Error("Embedding dimensions changed. Rebuild the search index.");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function bm25(chunks: Chunk[], question: string): { id: string; score: number }[] {
  const terms = [...new Set(tokenize(question))];
  const docs = chunks.map((chunk) => tokenize(`${chunk.title}\n${chunk.text}`));
  const average = docs.reduce((sum, words) => sum + words.length, 0) / (docs.length || 1);
  const frequency = new Map(terms.map((term) => [term, docs.reduce((sum, words) => sum + Number(words.includes(term)), 0)]));
  return docs.map((words, index) => {
    let score = 0;
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      const df = frequency.get(term)!;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * words.length / (average || 1)));
    }
    return { id: chunks[index].id, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function fuse(keyword: { id: string }[], semantic: { id: string }[], k = 60) {
  const scores = new Map<string, { id: string; score: number; bm25Rank: number | null; vectorRank: number | null }>();
  for (const [list, key] of [[keyword, "bm25Rank"], [semantic, "vectorRank"]] as const) {
    list.forEach((item, index) => {
      const row = scores.get(item.id) ?? { id: item.id, score: 0, bm25Rank: null, vectorRank: null };
      if (row[key] !== null) return;
      row[key] = index + 1; row.score += 1 / (k + index + 1); scores.set(item.id, row);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function retrieve(chunks: Chunk[], question: string, vector: number[]): RagSource[] {
  const keyword = bm25(chunks, question).slice(0, 20);
  const semantic = chunks.map((chunk) => ({ id: chunk.id, score: cosine(chunk.vector, vector) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 20);
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const selected: RagSource[] = [];
  const seen = new Set<string>();
  let characters = 0;
  for (const row of fuse(keyword, semantic)) {
    const { vector: _, ...chunk } = byId.get(row.id)!;
    const key = chunk.text.replace(/\s+/g, " ");
    if (seen.has(key) || selected.filter((source) => source.noteId === chunk.noteId).length >= 3 || characters + chunk.text.length > 5500) continue;
    seen.add(key); characters += chunk.text.length;
    selected.push({ ...chunk, ...row, label: selected.length + 1 });
    if (selected.length >= 6) break;
  }
  return selected;
}
