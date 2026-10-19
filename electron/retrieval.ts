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
  const docs = chunks.map((chunk) => tokenize(`${chunk.title}\n${chunk.sectionHeading ?? ""}\n${chunk.text}`));
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

export type Candidate = ReturnType<typeof fuse>[number];
export type RetrievalMode = "hybrid" | "keyword" | "vector";
// Small, transparent English query expansion for common field names. This adds
// vocabulary, not user facts or previous conversation, and does not affect vectors.
export function keywordQuery(question: string) {
  const aliases: string[] = [];
  if (/\b(study|studying|studies|education|degree|qualification|university|college)\b/i.test(question)) aliases.push("education degree qualifications university");
  if (/\b(skills|tools|languages|programming)\b/i.test(question)) aliases.push("skills tools languages technical");
  if (/\b(specialty|speciality|strengths|expertise|specialization)\b/i.test(question)) aliases.push("skills projects specialization");
  return [question, ...aliases].join(" ");
}
export function rankCandidates(chunks: Chunk[], question: string, vector: number[], mode: RetrievalMode = "hybrid") {
  const keyword = bm25(chunks, keywordQuery(question)).slice(0, 20);
  const semantic = chunks.map((chunk) => ({ id: chunk.id, score: cosine(chunk.vector, vector) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 20);
  return { candidates: fuse(mode === "vector" ? [] : keyword, mode === "keyword" ? [] : semantic), keywordCount: keyword.length, vectorCount: semantic.length };
}

export function sourceContext(sources: RagSource[]) {
  return sources.map((source) => ({ source: source.label, title: source.title, page: source.page, heading: source.sectionHeading, passage: source.text }));
}
export function contextBytes(sources: RagSource[]) { return new TextEncoder().encode(JSON.stringify(sourceContext(sources))).length; }

function asSource(chunk: Chunk, candidate: Candidate): RagSource {
  const { vector: _, ...source } = chunk;
  return { ...source, ...candidate, label: 0 };
}
function labelled(sources: RagSource[]) { return sources.map((source, i) => ({ ...source, label: i + 1 })); }
function mergeSources(sources: RagSource[]): RagSource[] {
  const groups: RagSource[] = [];
  for (const source of [...sources].sort((a, b) => a.noteId.localeCompare(b.noteId) || a.chunkIndex - b.chunkIndex)) {
    const previous = groups.at(-1);
    if (previous && previous.noteId === source.noteId && previous.page === source.page && previous.sectionHeading === source.sectionHeading && source.startOffset <= previous.endOffset + 1 && source.startOffset >= previous.startOffset) {
      const overlap = Math.max(0, previous.endOffset - source.startOffset);
      previous.text += (overlap ? "" : "\n") + source.text.slice(overlap);
      previous.endOffset = Math.max(previous.endOffset, source.endOffset);
      previous.id += `:${source.id}`;
      previous.score = Math.max(previous.score, source.score);
      const rank = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.min(a, b);
      previous.bm25Rank = rank(previous.bm25Rank, source.bm25Rank); previous.vectorRank = rank(previous.vectorRank, source.vectorRank);
    } else groups.push({ ...source });
  }
  return groups;
}

export function selectContext(chunks: Chunk[], candidates: Candidate[], budgetBytes = 5500): RagSource[] {
  if (!candidates.length) return [];
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const ranks = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = new Map<string, RagSource>();
  const finalize = (items: RagSource[]) => labelled(mergeSources(items).sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId) || a.chunkIndex - b.chunkIndex));
  const fits = (items: RagSource[]) => { const result = finalize(items); return result.length <= 16 && contextBytes(result) <= budgetBytes; };
  const best = byId.get(candidates[0].id);
  // Full short documents are useful when this is the only document in scope,
  // or both retrieval methods agree on a leading result. Never override folder scope.
  if (best) {
    const document = chunks.filter((chunk) => chunk.noteId === best.noteId);
    const consensus = candidates[0].bm25Rank !== null && candidates[0].bm25Rank <= 3 && candidates[0].vectorRank !== null && candidates[0].vectorRank <= 3;
    const uniqueNotes = new Set(chunks.map((chunk) => chunk.noteId)).size;
    const whole = document.map((chunk) => asSource(chunk, ranks.get(chunk.id) ?? { id: chunk.id, score: candidates[0].score / 2, bm25Rank: null, vectorRank: null }));
    if ((uniqueNotes === 1 || consensus) && document.length <= 20 && fits(whole)) {
      for (const source of whole) selected.set(source.id, source);
    }
  }
  const seen = new Set([...selected.values()].map((source) => source.text.replace(/\s+/g, " ")));
  for (const candidate of candidates) {
    if (selected.has(candidate.id)) continue;
    const chunk = byId.get(candidate.id);
    if (!chunk) continue;
    const key = chunk.text.replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    const source = asSource(chunk, candidate);
    if (!fits([...selected.values(), source])) continue;
    selected.set(source.id, source); seen.add(key);
  }
  // After ranked evidence, fill remaining space with adjacent context from the
  // same section. Unrelated sections/documents cannot sneak in as neighbours.
  for (const primary of [...selected.values()]) {
    if (!primary.sectionHeading) continue;
    for (const neighbour of chunks.filter((chunk) => chunk.noteId === primary.noteId && chunk.page === primary.page && chunk.sectionHeading === primary.sectionHeading && Math.abs(chunk.chunkIndex - primary.chunkIndex) === 1)) {
      if (selected.has(neighbour.id)) continue;
      const source = asSource(neighbour, ranks.get(neighbour.id) ?? { id: neighbour.id, score: primary.score / 2, bm25Rank: null, vectorRank: null });
      if (fits([...selected.values(), source])) selected.set(source.id, source);
    }
  }
  return finalize([...selected.values()]);
}

export function retrieve(chunks: Chunk[], question: string, vector: number[]): RagSource[] {
  return selectContext(chunks, rankCandidates(chunks, question, vector).candidates);
}
