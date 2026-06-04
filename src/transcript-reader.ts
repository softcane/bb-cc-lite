import { open, stat } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 512 * 1024;

export interface ReadTranscriptTailOptions {
  maxBytes?: number;
}

export interface TranscriptTail {
  pathReadable: boolean;
  bytesRead: number;
  tailTruncated: boolean;
  lines: string[];
}

export async function readTranscriptTail(
  transcriptPath: string | undefined,
  options: ReadTranscriptTailOptions = {}
): Promise<TranscriptTail> {
  if (!transcriptPath) {
    return unreadableTail();
  }

  try {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const fileStat = await stat(transcriptPath);
    const bytesRead = Math.min(fileStat.size, maxBytes);
    const start = Math.max(0, fileStat.size - bytesRead);
    const handle = await open(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(bytesRead);
      await handle.read(buffer, 0, bytesRead, start);
      const text = buffer.toString("utf8");
      return {
        pathReadable: true,
        bytesRead,
        tailTruncated: start > 0,
        lines: trimPartialFirstLine(text, start).split(/\r?\n/).filter(Boolean)
      };
    } finally {
      await handle.close();
    }
  } catch {
    return unreadableTail();
  }
}

function unreadableTail(): TranscriptTail {
  return {
    pathReadable: false,
    bytesRead: 0,
    tailTruncated: false,
    lines: []
  };
}

function trimPartialFirstLine(text: string, start: number): string {
  if (start === 0) {
    return text;
  }
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1);
}
