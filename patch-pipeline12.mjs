import { readFile, writeFile } from 'node:fs/promises';

const file = '/app/server.mjs';
let source = await readFile(file, 'utf8');

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`Pipeline 12 patch failed: ${label} anchor not found`);
  source = source.replace(before, after);
}

replaceOnce(
  'spawnCapture stdin support',
`async function spawnCapture(command, args, { cwd = workRoot, timeoutMs = 60000, env = process.env } = {}) {
  return await new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let done = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    child.stdout.on('data', x => stdout.push(Buffer.from(x)));
    child.stderr.on('data', x => stderr.push(Buffer.from(x)));
    child.on('error', error => { stderr.push(Buffer.from(error.message)); finish(-1); });
    child.on('close', finish);
  });
}`,
`async function spawnCapture(command, args, { cwd = workRoot, timeoutMs = 60000, env = process.env, stdinData = null } = {}) {
  return await new Promise(resolve => {
    const hasStdin = stdinData !== null && stdinData !== undefined;
    const child = spawn(command, args, { cwd, env, stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let done = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeoutMs);
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    child.stdout.on('data', x => stdout.push(Buffer.from(x)));
    child.stderr.on('data', x => stderr.push(Buffer.from(x)));
    child.on('error', error => { stderr.push(Buffer.from(error.message)); finish(-1); });
    if (hasStdin) {
      child.stdin.on('error', error => {
        if (error?.code !== 'EPIPE') stderr.push(Buffer.from(String(error?.message || error)));
      });
      child.stdin.end(String(stdinData));
    }
    child.on('close', finish);
  });
}`
);

replaceOnce(
  'scanner prompt via stdin',
  "  args.push('--output-schema', schemaPath, '--output-last-message', outputPath); if (configuredModel) args.push('--model', configuredModel); args.push(prompt);\n  const execution = await spawnCapture('codex', args, { cwd: runDir, timeoutMs: codexTimeoutMs, env: { ...process.env, CODEX_HOME: codexHome } });",
  "  args.push('--output-schema', schemaPath, '--output-last-message', outputPath); if (configuredModel) args.push('--model', configuredModel); args.push('-');\n  const execution = await spawnCapture('codex', args, { cwd: runDir, timeoutMs: codexTimeoutMs, env: { ...process.env, CODEX_HOME: codexHome }, stdinData: prompt });"
);

replaceOnce(
  'assistant prompt via stdin',
  "    if (configuredModel) args.push('--model', configuredModel);\n    args.push(prompt);\n    const execution = await spawnCapture('codex', args, { cwd: runDir, timeoutMs, env: { ...process.env, CODEX_HOME: codexHome } });",
  "    if (configuredModel) args.push('--model', configuredModel);\n    args.push('-');\n    const execution = await spawnCapture('codex', args, { cwd: runDir, timeoutMs, env: { ...process.env, CODEX_HOME: codexHome }, stdinData: prompt });"
);

replaceOnce(
  'structured assistant prompt via stdin',
  "    if (configuredModel) args.push('--model', configuredModel);\n    args.push(prompt);\n    const execution = await spawnCapture('codex', args, { cwd: runDir, timeoutMs, env: { ...process.env, CODEX_HOME: codexHome } });",
  "    if (configuredModel) args.push('--model', configuredModel);\n    args.push('-');\n    const execution = await spawnCapture('codex', args, { cwd: runDir, timeoutMs, env: { ...process.env, CODEX_HOME: codexHome }, stdinData: prompt });"
);

await writeFile(file, source);
