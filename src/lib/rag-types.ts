export type ChatModels = { name: string; digest: string; embedding: boolean; chat: boolean }[];
export type RagSource = { id: string; noteId: string; title: string; folderId: string | null; page: number | null; text: string; bm25Rank: number | null; vectorRank: number | null; score: number; label: number };
export type RagReply = { answer: string; sources: RagSource[]; warnings: string[]; indexedChunks: number };
export type RagStatus = { busy: boolean; message: string; completed: number; total: number };
export type RagRequest = { question: string; folderId: string | null; chatModel: string; embeddingModel: string; history: { question: string; answer: string }[] };
