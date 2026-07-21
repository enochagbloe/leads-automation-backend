export type CustomerMemoryExtractionMessage = {
  id: string;
  createdAt: Date;
  text: string;
};

const EXTRACTION_MESSAGE_TEXT_BUDGET = 8_000;

function truncateMessageText(text: string, limit: number) {
  if (text.length <= limit) return text;
  const marker = "\n...[message truncated]...\n";
  if (limit <= marker.length + 2) return text.slice(0, limit);
  const available = limit - marker.length;
  const headLength = Math.ceil(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-(available - headLength))}`;
}

export function packCustomerMemoryExtractionMessages(
  messages: CustomerMemoryExtractionMessage[],
  textBudget = EXTRACTION_MESSAGE_TEXT_BUDGET,
) {
  const chronological = [...messages].sort((left, right) => (
    left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
  ));
  const selected: CustomerMemoryExtractionMessage[] = [];
  let remaining = Math.max(0, textBudget);

  // Select newest messages first so old backlog cannot displace the latest correction.
  for (const message of [...chronological].reverse()) {
    if (remaining === 0) break;
    const text = message.text.trim();
    if (!text) continue;
    const packedText = truncateMessageText(text, remaining);
    selected.push({ ...message, text: packedText });
    remaining -= packedText.length;
    if (packedText.length < text.length) break;
  }

  // The provider still receives selected messages in conversation order.
  return selected.reverse();
}
