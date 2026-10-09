import { performance } from 'node:perf_hooks';
import { parsePatchFiles } from '@pierre/diffs';

const lineCount = 20_000;
const patch = `diff --git a/src/generated.ts b/src/generated.ts\nindex 0000000..1111111 100644\n--- a/src/generated.ts\n+++ b/src/generated.ts\n@@ -0,0 +1,${lineCount} @@\n${Array.from({ length: lineCount }, (_, index) => `+export const item${index} = ${index};`).join('\n')}\n`;
const before = process.memoryUsage().heapUsed;
const started = performance.now();
const parsed = parsePatchFiles(patch);
const parseMs = performance.now() - started;
const heapDeltaMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
console.log(JSON.stringify({ changedLines: lineCount, parsedFiles: parsed.length, patchBytes: Buffer.byteLength(patch), parseMs: Number(parseMs.toFixed(1)), heapDeltaMb: Number(heapDeltaMb.toFixed(1)) }, null, 2));
