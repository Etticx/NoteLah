// Repeatable retrieval evaluation with real local embeddings and synthetic notes.
// Does not load or write the user's workspace. Run: npx tsx scripts/evaluate-rag.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { Ollama } from "../electron/ollama";
import { structuredChunks } from "../electron/chunking";
import { rankCandidates, selectContext, type Chunk, type RetrievalMode } from "../electron/retrieval";

const documents = [
  { id: "resume", title: "Candidate resume", text: "# Education\nBachelor of Information Systems, specializing in Intelligent Systems Engineering, at Example University.\n# Skills\nPython, TypeScript, SQL, FastAPI and XGBoost.\n# Projects\nDeveloped a credit risk prediction system with machine learning and SHAP explanations. Built a personal desktop task tracker." },
  { id: "hackathon", title: "SDC Hackathon", text: "# Deliverables\nTeams must submit a working prototype and a slide deck.\n# Deadline\nSubmissions close on Friday at noon.\n# Teams\nEach team may have up to four members." },
  { id: "meeting", title: "Supervisor meeting", text: "# Next steps\nPrepare the research proposal and review three related papers before the next meeting.\n# Schedule\nThe next meeting is Tuesday at 10 AM." },
  { id: "travel", title: "Trip checklist", text: "# Deadline\nRenew the travel card by Monday.\n# Packing\nBring a charger, umbrella, and water bottle." },
  { id: "cooking", title: "Dinner plans", text: "# Ingredients\nBuy rice, eggs, apples, and vegetables.\n# Schedule\nCook at 7 PM." },
  { id: "library", title: "Library information", text: "# Membership\nUniversity library membership requires a student card.\n# Deadline\nBooks are due on Wednesday." },
  { id: "workshop", title: "Presentation workshop", text: "# Requirements\nBring an existing slide deck for feedback.\n# Schedule\nAttend the workshop on Saturday morning." },
  { id: "reading", title: "Machine learning reading list", text: "# Topics\nRead about clustering, neural networks, feature engineering, and model evaluation.\n# Qualifications\nThis reading list does not award a degree or certification." },
];
const cases = [
  { question: "What do I study?", relevant: ["resume:Education"] },
  { question: "Which university is listed for my degree?", relevant: ["resume:Education"] },
  { question: "What programming languages and tools do I know?", relevant: ["resume:Skills"] },
  { question: "What experience do I have building prediction systems?", relevant: ["resume:Projects"] },
  { question: "What does the SDC team need to hand in?", relevant: ["hackathon:Deliverables"] },
  { question: "When does SDC close submissions?", relevant: ["hackathon:Deadline"] },
  { question: "How many people can join an SDC team?", relevant: ["hackathon:Teams"] },
  { question: "What should I prepare for my supervisor?", relevant: ["meeting:Next steps"] },
  { question: "When is the next supervisor meeting?", relevant: ["meeting:Schedule"] },
  { question: "What ingredients do I need for dinner?", relevant: ["cooking:Ingredients"] },
];

async function main() {
  const ollama = new Ollama(); const model = "nomic-embed-text:latest";
  const available = await ollama.models();
  if (!available.some((item) => item.name === model && item.embedding)) throw new Error("Install nomic-embed-text in local Ollama first.");
  const chunks: Chunk[] = documents.flatMap((doc) => structuredChunks([{ text: doc.text, page: null }]).map((piece, index) => ({ ...piece, id: `${doc.id}-${index}`, noteId: doc.id, title: doc.title, folderId: null, vector: [] })));
  const embeddingStart = performance.now();
  for (let start = 0; start < chunks.length; start += 8) {
    console.log(`Embedding evaluation fixtures ${start + 1}/${chunks.length}`);
    const batch = chunks.slice(start, start + 8);
    const vectors = await ollama.embed(model, batch.map((chunk) => `search_document: ${chunk.title}\n${chunk.sectionHeading ?? ""}\n${chunk.text}`));
    batch.forEach((chunk, i) => { chunk.vector = vectors[i]; });
  }
  const vectors = await ollama.embed(model, cases.map((item) => `search_query: ${item.question}`));
  const embeddingMs = Math.round(performance.now() - embeddingStart);
  const section = (chunk: Pick<Chunk, "noteId" | "sectionHeading">) => `${chunk.noteId}:${chunk.sectionHeading}`;
  const modes: RetrievalMode[] = ["keyword", "vector", "hybrid"];
  const rows = cases.map((item, index) => ({ question: item.question, expectedSections: item.relevant, results: modes.map((mode) => {
    const started = performance.now();
    const ranked = rankCandidates(chunks, item.question, vectors[index], mode);
    const ids = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const sections = ranked.candidates.map((candidate) => section(ids.get(candidate.id)!));
    const firstRelevant = sections.findIndex((name) => item.relevant.includes(name));
    const found = new Set(sections.slice(0, 3).filter((name) => item.relevant.includes(name)));
    const context = selectContext(chunks, ranked.candidates);
    return { mode, recallAt3: found.size / item.relevant.length, reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1), contextHasExpectedEvidence: item.relevant.every((name) => context.some((source) => section(source) === name)), topSections: sections.slice(0, 3), rankingMs: Math.round((performance.now() - started) * 100) / 100 };
  }) }));
  const summary = modes.map((mode) => {
    const results = rows.map((row) => row.results.find((result) => result.mode === mode)!);
    return { mode, meanRecallAt3: results.reduce((sum, row) => sum + row.recallAt3, 0) / rows.length, mrr: results.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length, contextEvidenceCoverage: results.filter((row) => row.contextHasExpectedEvidence).length / rows.length };
  });
  await fs.mkdir('work', { recursive: true });
  const report = path.resolve('work', `rag-evaluation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(report, JSON.stringify({ model, modelDigest: available.find((item) => item.name === model)!.digest, corpus: "Synthetic fixture notes; not a production-quality benchmark", questions: cases.length, chunks: chunks.length, embeddingMs, summary, rows }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ report, embeddingMs, summary }, null, 2));
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
