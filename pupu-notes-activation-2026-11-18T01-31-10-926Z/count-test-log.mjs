import assert from 'node:assert/strict';
import { createReadStream, statSync, writeFileSync } from 'node:fs';

const path = 'D:/ProjectICreate/PuPuBot/pupu-notes/.test-data/local-model-requests.jsonl';
const reportPath = 'D:/ProjectICreate/PuPuBot/pupu_20260425_105129/operations/pupu-notes-activation-2026-11-18T01-31-10-926Z/test-log-statistics.json';
const before = statSync(path);
assert(before.isFile());
const header = Buffer.allocUnsafe(1024);
const sessions = new Set();
const purposes = {};
const largest = [];
const first = [], last = [];
const buckets = [
  { belowBytes: 64 * 1024, count: 0 },
  { belowBytes: 1024 * 1024, count: 0 },
  { belowBytes: 16 * 1024 * 1024, count: 0 },
  { belowBytes: 64 * 1024 * 1024, count: 0 },
  { belowBytes: 256 * 1024 * 1024, count: 0 },
  { belowBytes: null, count: 0 },
];
let bytesRead = 0, lineBytes = 0, headerBytes = 0, records = 0;
let backgroundRequests = 0, metadataErrors = 0, emptyLines = 0;
let firstTime = Infinity, lastTime = -Infinity;
let lastProgress = Date.now(), lastByte = null;
const startedAt = Date.now();

function append(chunk, start, end) {
  lineBytes += end - start;
  if (headerBytes < header.length) {
    const count = Math.min(end - start, header.length - headerBytes);
    chunk.copy(header, headerBytes, start, start + count);
    headerBytes += count;
  }
}
function finishRecord() {
  if (!lineBytes) { emptyLines++; headerBytes = 0; return; }
  records++;
  const text = header.subarray(0, headerBytes).toString('utf8');
  const boundary = text.indexOf(',"messages":');
  try {
    assert(boundary > 0);
    const metadata = JSON.parse(`${text.slice(0, boundary)}}`);
    const purpose = metadata.purpose ?? 'missing';
    purposes[purpose] = (purposes[purpose] ?? 0) + 1;
    if (metadata.sessionId === null) backgroundRequests++;
    else if (typeof metadata.sessionId === 'string') sessions.add(metadata.sessionId);
    if (Number.isFinite(metadata.time)) {
      firstTime = Math.min(firstTime, metadata.time);
      lastTime = Math.max(lastTime, metadata.time);
    }
  } catch { metadataErrors++; }
  buckets.find(bucket => bucket.belowBytes === null || lineBytes < bucket.belowBytes).count++;
  const entry = { record: records, bytes: lineBytes };
  if (largest.length < 10 || lineBytes > largest.at(-1).bytes) {
    largest.push(entry);
    largest.sort((a, b) => b.bytes - a.bytes);
    largest.length = Math.min(largest.length, 10);
  }
  if (first.length < 10) first.push(entry);
  last.push(entry);
  if (last.length > 10) last.shift();
  lineBytes = 0;
  headerBytes = 0;
}

for await (const chunk of createReadStream(path, { highWaterMark: 16 * 1024 * 1024 })) {
  let start = 0;
  while (start < chunk.length) {
    const end = chunk.indexOf(10, start);
    if (end < 0) { append(chunk, start, chunk.length); break; }
    append(chunk, start, end);
    finishRecord();
    start = end + 1;
  }
  bytesRead += chunk.length;
  lastByte = chunk.at(-1);
  if (Date.now() - lastProgress > 15_000) {
    console.log(JSON.stringify({ progressPercent: +(bytesRead / before.size * 100).toFixed(1), records }));
    lastProgress = Date.now();
  }
}
const unterminatedLastRecord = lineBytes > 0;
if (unterminatedLastRecord) finishRecord();
const after = statSync(path);
assert.equal(after.size, before.size, 'Log changed while counting');
assert.equal(after.mtimeMs, before.mtimeMs, 'Log changed while counting');
assert.equal(bytesRead, before.size);
const result = {
  path, fileBytes: before.size, fileGiB: before.size / 2 ** 30,
  records, emptyLines, metadataErrors, terminatedWithNewline: lastByte === 10, unterminatedLastRecord,
  uniqueNonNullSessions: sessions.size, backgroundRequests, purposes,
  firstRequestAt: Number.isFinite(firstTime) ? new Date(firstTime).toISOString() : null,
  lastRequestAt: Number.isFinite(lastTime) ? new Date(lastTime).toISOString() : null,
  meanRecordBytes: (bytesRead - records + Number(unterminatedLastRecord)) / records,
  largestRecords: largest, sizeBuckets: buckets, firstTenRecords: first, lastTenRecords: last,
  countedAt: new Date().toISOString(), elapsedSeconds: (Date.now() - startedAt) / 1000,
  unchangedWhileCounting: true,
};
writeFileSync(reportPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
