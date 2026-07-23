import fs from "node:fs";

export interface JsonlRecord {
  event: Record<string, any>;
  raw: string;
}

export interface JsonlRead {
  offset: number;
  records: JsonlRecord[];
}

export function jsonlTailOffset(
  file: string,
  size: number,
  maxBytes: number | null,
): number {
  if (!maxBytes || size <= maxBytes) return 0;
  let preliminary = size - maxBytes;
  let buffer = readBuffer(file, preliminary, size);
  if (!buffer) return preliminary;
  let newline = buffer.indexOf(10);
  return newline < 0 ? size : preliminary + newline + 1;
}

export function readJsonlAppend(
  file: string,
  offset: number,
  size: number,
): JsonlRead {
  let buffer = readBuffer(file, offset, size);
  if (!buffer?.length) return { offset, records: [] };
  let records: JsonlRecord[] = [];
  let lineStart = 0;
  let committed = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue;
    appendRecord(records, buffer.subarray(lineStart, index).toString("utf8"));
    lineStart = index + 1;
    committed = lineStart;
  }

  if (lineStart < buffer.length) {
    let raw = buffer.subarray(lineStart).toString("utf8");
    if (appendRecord(records, raw)) committed = buffer.length;
  }

  return { offset: offset + committed, records };
}

function appendRecord(records: JsonlRecord[], raw: string): boolean {
  if (!raw.trim()) return true;
  try {
    let parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return true;
    records.push({ event: parsed as Record<string, any>, raw });
    return true;
  } catch {
    return false;
  }
}

function readBuffer(file: string, offset: number, size: number): Buffer | null {
  let length = Math.max(0, size - offset);
  if (!length) return Buffer.alloc(0);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "r");
    let buffer = Buffer.alloc(length);
    let bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
