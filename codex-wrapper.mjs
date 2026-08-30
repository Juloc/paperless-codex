#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const ansiPattern = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const stripAnsi = value => String(value ?? '').replace(ansiPattern, '');

const child = spawn(
  '/usr/local/bin/codex-real',
  ['--disable', 'shell_tool', ...process.argv.slice(2)],
  { env: process.env, stdio: ['inherit', 'pipe', 'pipe'] }
);

function forward(source, target) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  source.on('data', chunk => {
    pending += decoder.write(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) target.write(`${stripAnsi(line)}\n`);
  });
  source.on('end', () => {
    pending += decoder.end();
    if (pending) target.write(stripAnsi(pending));
  });
}

forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
