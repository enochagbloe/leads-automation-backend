import { AppError } from "../../utils/errors";

export const KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARACTERS = 1_400;
export const KNOWLEDGE_DOCUMENT_CHUNK_OVERLAP_CHARACTERS = 160;
export const KNOWLEDGE_DOCUMENT_CHUNK_LIMIT = 80;

type ChunkSource = {
  text: string;
  sourceLabel: string | null;
  pageNumber: number | null;
};

export type KnowledgeDocumentChunkInput = {
  normalizedText: string;
  sections: ChunkSource[];
};

export type KnowledgeDocumentChunkData = {
  chunkText: string;
  pageNumber: number | null;
  tokenCount: number;
};

function normalize(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function splitText(value: string) {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length && chunks.length < KNOWLEDGE_DOCUMENT_CHUNK_LIMIT) {
    const hardEnd = Math.min(value.length, start + KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARACTERS);
    const slice = value.slice(start, hardEnd);
    const breakAt = hardEnd < value.length
      ? Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "))
      : -1;
    const end = breakAt > KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARACTERS * 0.55
      ? start + breakAt + 1
      : hardEnd;
    const chunk = value.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= value.length) break;
    start = Math.max(start + 1, end - KNOWLEDGE_DOCUMENT_CHUNK_OVERLAP_CHARACTERS);
  }
  return chunks;
}

export function buildKnowledgeDocumentChunks(input: KnowledgeDocumentChunkInput): KnowledgeDocumentChunkData[] {
  const groups: Array<{ text: string; pageNumber: number | null }> = [];
  for (const section of input.sections) {
    const text = normalize(section.text);
    if (!text) continue;
    const labeled = section.sourceLabel ? `${section.sourceLabel}\n${text}` : text;
    const previous = groups.at(-1);
    if (
      previous
      && previous.pageNumber === section.pageNumber
      && previous.text.length + labeled.length + 2 <= KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARACTERS
    ) {
      previous.text = `${previous.text}\n\n${labeled}`;
    } else {
      groups.push({ text: labeled, pageNumber: section.pageNumber });
    }
  }

  if (!groups.length) {
    const fallback = normalize(input.normalizedText);
    if (fallback) groups.push({ text: fallback, pageNumber: null });
  }

  const chunks: KnowledgeDocumentChunkData[] = [];
  for (const group of groups) {
    for (const chunkText of splitText(group.text)) {
      chunks.push({
        chunkText,
        pageNumber: group.pageNumber,
        tokenCount: estimateTokens(chunkText),
      });
      if (chunks.length >= KNOWLEDGE_DOCUMENT_CHUNK_LIMIT) return chunks;
    }
  }
  if (!chunks.length) {
    throw new AppError(
      422,
      "The extracted document did not contain content that can be indexed.",
      "KNOWLEDGE_DOCUMENT_CHUNK_BUILD_FAILED",
    );
  }
  return chunks;
}
