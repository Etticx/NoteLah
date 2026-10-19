export type ChatModels = { name: string; digest: string; embedding: boolean; chat: boolean }[];
export type RagSource = { id: string; noteId: string; title: string; folderId: string | null; page: number | null; text: string; sectionHeading: string | null; chunkIndex: number; startOffset: number; endOffset: number; bm25Rank: number | null; vectorRank: number | null; score: number; label: number };
export type RagTrace = { originalQuestion: string; searchQuestion: string; keywordQuery: string; rewritten: boolean; keywordCandidates: number; vectorCandidates: number; contextBytes: number; elapsedMs: number };
export type RagReply = { answer: string; sources: RagSource[]; warnings: string[]; indexedChunks: number; kind: "answer" | "inference" | "insufficient" | "clarification"; trace: RagTrace };
export type RagStatus = { busy: boolean; message: string; completed: number; total: number };
export type RagRequest = { question: string; folderId: string | null; chatModel: string; embeddingModel: string; history: { question: string; answer: string }[] };
