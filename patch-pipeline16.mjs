import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 16 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'paperless transient retry setting',
  "const queueInterScanDelayMs = Math.max(0, Math.min(60000, Number(process.env.QUEUE_INTER_SCAN_DELAY_MS || 3000)));",
  "const queueInterScanDelayMs = Math.max(0, Math.min(60000, Number(process.env.QUEUE_INTER_SCAN_DELAY_MS || 3000)));\nconst paperlessTransientRetryMs = Math.max(10000, Math.min(600000, Number(process.env.PAPERLESS_TRANSIENT_RETRY_MS || 60000)));"
);

replaceOnce(
  'paperless transient helper',
  "function usagePublic() {",
  [
    "function isPaperlessTransientError(error) {",
    "  const text = String(error?.message || error || '').toLowerCase();",
    "  return /paperless .* failed: 5(?:00|02|03|04)|backend unavailable|fetch failed|econnrefused|econnreset|etimedout|socket hang up|network error/.test(text);",
    "}",
    "",
    "function usagePublic() {"
  ].join('\n')
);

replaceOnce(
  'pause queue on paperless outage',
  [
    "        if (isUsageLimitError(error)) {",
    "          const retryAt = new Date(Date.now() + usageLimitRetryMs).toISOString();",
    "          usageLimitState = { paused: true, detectedAt: new Date().toISOString(), retryAt, lastError: job.error };",
    "          job.status = 'waiting-usage-limit';",
    "          job.nextRetryAt = retryAt;",
    "          job.attempt = Math.max(0, job.attempt - 1);",
    "          log('usage', 'Codex usage/rate limit reached; queue paused without failing document.', { documentId, retryAt, error: job.error });",
    "          await new Promise(resolve => setTimeout(resolve, usageLimitRetryMs));",
    "          usageLimitState = { paused: false, detectedAt: usageLimitState.detectedAt, retryAt: null, lastError: null };",
    "          continue;",
    "        }",
    "        if (job.attempt <= maxRetries) {"
  ].join('\n'),
  [
    "        if (isUsageLimitError(error)) {",
    "          const retryAt = new Date(Date.now() + usageLimitRetryMs).toISOString();",
    "          usageLimitState = { paused: true, detectedAt: new Date().toISOString(), retryAt, lastError: job.error };",
    "          job.status = 'waiting-usage-limit';",
    "          job.nextRetryAt = retryAt;",
    "          job.attempt = Math.max(0, job.attempt - 1);",
    "          log('usage', 'Codex usage/rate limit reached; queue paused without failing document.', { documentId, retryAt, error: job.error });",
    "          await new Promise(resolve => setTimeout(resolve, usageLimitRetryMs));",
    "          usageLimitState = { paused: false, detectedAt: usageLimitState.detectedAt, retryAt: null, lastError: null };",
    "          continue;",
    "        }",
    "        if (isPaperlessTransientError(error)) {",
    "          const retryAt = new Date(Date.now() + paperlessTransientRetryMs).toISOString();",
    "          job.status = 'waiting-paperless';",
    "          job.nextRetryAt = retryAt;",
    "          job.attempt = Math.max(0, job.attempt - 1);",
    "          log('paperless', 'Paperless temporarily unavailable; queue paused without failing document.', { documentId, retryAt, delay: paperlessTransientRetryMs, error: job.error });",
    "          await new Promise(resolve => setTimeout(resolve, paperlessTransientRetryMs));",
    "          continue;",
    "        }",
    "        if (job.attempt <= maxRetries) {"
  ].join('\n')
);

replaceOnce(
  'reduce metadata patch concurrency',
  "  const chunkSize = 6;",
  "  const chunkSize = 2;"
);

await writeFile(file, source);
