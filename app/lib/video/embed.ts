import { createHash } from "node:crypto";

// Deterministic content embedding — TS mirror of modal/enrich_video.py
// _text_embedding. Same sha256 seed + LCG + L2-norm, so MCP query vectors
// rank against stored video vectors with pgvector cosine (<=>).
export function textEmbedding(text: string, dim = 1024): number[] {
  const digest = createHash("sha256").update(text).digest();
  let x = digest.readUInt32LE(0) || 1;
  const vals: number[] = [];
  for (let i = 0; i < dim; i++) {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    vals.push((x / 4294967296) * 2 - 1);
  }
  const norm = Math.sqrt(vals.reduce((s, v) => s + v * v, 0)) || 1;
  return vals.map((v) => v / norm);
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.map((n) => n.toFixed(6)).join(",")}]`;
}
