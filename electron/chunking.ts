export type TextPage = { text: string; page: number | null; headingHints?: string[] };
export type TextPiece = { text: string; page: number | null; sectionHeading: string | null; chunkIndex: number; startOffset: number; endOffset: number };

export function normalizedText(text: string) { return text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim(); }

function heading(line: string, hints: Set<string>, precededByBlank: boolean): string | null {
  const markdown = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
  if (markdown) return markdown[1].trim();
  if (!line || line.length > 85 || line.split(/\s+/).length > 9) return null;
  const name = line.replace(/:$/, "").trim();
  const common = /^(education|academic (background|qualifications)|qualifications|skills|technical skills|experience|(?:professional|work) experience|projects|(?:personal|academic|selected) projects|certifications?|achievements?|awards?|summary|profile|publications?|references|requirements|deliverables|deadlines?|submission|introduction|conclusions?|next steps|meeting notes|extracurricular|activities|leadership)$/i;
  const compound = name.split(/\s*[&/]\s*/);
  if (common.test(name) || compound.length > 1 && compound.every((part) => common.test(part)) || hints.has(line) || (precededByBlank && /[A-Z]/.test(name) && name === name.toUpperCase() && !/[.!?]$/.test(name)) || /:$/.test(line)) return name;
  return null;
}

export function structuredChunks(pages: TextPage[], size = 1000, overlap = 120): TextPiece[] {
  if (size < 2 || overlap < 0 || overlap >= size) throw new Error("Invalid chunk settings");
  const pieces: TextPiece[] = [];
  let inheritedHeading: string | null = null;
  for (const page of pages) {
    const text = normalizedText(page.text);
    if (!text) continue;
    const hints = new Set(page.headingHints ?? []);
    const sections: { start: number; end: number; heading: string | null }[] = [];
    let start = 0, offset = 0;
    let active: string | null = inheritedHeading;
    let previousBlank = true;
    for (const line of text.split("\n")) {
      const found = heading(line.trim(), hints, previousBlank);
      if (found) {
        if (offset > start && text.slice(start, offset).trim()) sections.push({ start, end: offset, heading: active });
        start = offset; active = found;
      }
      offset += line.length + 1;
      previousBlank = !line.trim();
    }
    sections.push({ start, end: text.length, heading: active }); inheritedHeading = active;
    for (const section of sections) {
      let cursor = section.start;
      while (cursor < section.end) {
        while (cursor < section.end && /\s/.test(text[cursor])) cursor++;
        if (cursor >= section.end) break;
        let end = Math.min(cursor + size, section.end);
        if (end < section.end) {
          const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
          if (boundary > cursor + size / 2) end = boundary;
        }
        while (end > cursor && /\s/.test(text[end - 1])) end--;
        pieces.push({ text: text.slice(cursor, end), page: page.page, sectionHeading: section.heading, chunkIndex: pieces.length, startOffset: cursor, endOffset: end });
        if (end >= section.end || !text.slice(end, section.end).trim()) break;
        let next = Math.max(cursor + 1, end - overlap);
        while (next < end && next > 0 && !/\s/.test(text[next - 1])) next++;
        cursor = next;
      }
    }
  }
  return pieces;
}

type PdfItem = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };
// Preserve PDF.js stream order (including column order). Geometry prevents
// adjacent columns from becoming a single line; this is not a full layout/OCR engine.
export function pdfPageText(items: PdfItem[]): Omit<TextPage, "page"> {
  const lines: { text: string; height: number }[] = [];
  let text = "", last: PdfItem | null = null, lineHeight = 0;
  const flush = () => { if (text.trim()) lines.push({ text: text.trim(), height: lineHeight }); text = ""; lineHeight = 0; };
  for (const item of items) {
    const height = Math.max(item.height || Math.abs(item.transform[3]), 1);
    if (last) {
      const gap = item.transform[4] - (last.transform[4] + last.width);
      const sameLine = Math.abs(item.transform[5] - last.transform[5]) <= Math.max(2, height * 0.25);
      if (!sameLine || gap > Math.max(24, height * 3) || gap < -Math.max(3, height)) flush();
      else if (gap > height * 0.15 && text && !/\s$/.test(text)) text += " ";
    }
    text += item.str; lineHeight = Math.max(lineHeight, height);
    if (item.hasEOL) { flush(); last = null; } else last = item;
  }
  flush();
  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 12;
  return { text: lines.map((line) => line.text).join("\n"), headingHints: lines.filter((line) => line.height > median * 1.2 && line.text.length < 85).map((line) => line.text) };
}
