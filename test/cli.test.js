'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { mkdtemp, readFile, rm, writeFile, chmod } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'cli.js');
const node = process.execPath;

async function startApi() {
  const links = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/links' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { url: original } = JSON.parse(raw);
      const link = {
        code: 'abc123',
        url: original,
        shortUrl: `http://short.test/abc123`,
        hits: 0,
        createdAt: new Date().toISOString(),
      };
      links.push(link);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(link));
      return;
    }
    if (url.pathname === '/api/links') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(links));
      return;
    }
    if (url.pathname === '/missing') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.pathname === '/abc123') {
      res.writeHead(302, { location: links[0]?.url || 'https://example.com/path' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

test('help prints usage without contacting the API', async () => {
  const result = await run(['help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /snip add <url>/);
  assert.equal(result.stderr, '');
});

test('add validates URLs, posts link, and prints its short URL', async (t) => {
  const api = await startApi();
  t.after(api.close);

  const invalid = await run(['add', 'javascript:alert(1)'], { SNIP_API: api.base });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Only http and https/);

  const result = await run(['add', 'https://example.com/path'], { SNIP_API: api.base });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'http://short.test/abc123\n');
});

test('ls displays the empty message and aligned link details', async (t) => {
  const api = await startApi();
  t.after(api.close);
  const env = { SNIP_API: api.base };

  const empty = await run(['ls'], env);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, 'No links yet.\n');

  await run(['add', 'https://example.com'], env);
  const result = await run(['ls'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CODE\s+HITS\s+URL/);
  assert.match(result.stdout, /abc123\s+0\s+https:\/\/example\.com/);
});

test('open follows redirect manually and launches the original URL', {
  skip: process.platform === 'win32' ? 'Unix opener shim is used for this integration test' : false,
}, async (t) => {
  const api = await startApi();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'snip-cli-test-'));
  t.after(async () => {
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const captured = path.join(tempDir, 'opened-url');
  const openerName = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const opener = path.join(tempDir, openerName);
  await writeFile(opener, `#!/bin/sh\nprintf '%s' \"$1\" > \"${captured}\"\n`);
  await chmod(opener, 0o755);
  const result = await run(['open', 'abc123'], {
    SNIP_API: api.base,
    PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stderr);
  let openedUrl;
  for (let attempt = 0; attempt < 40 && openedUrl === undefined; attempt += 1) {
    try {
      openedUrl = await readFile(captured, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.equal(openedUrl, 'https://example.com/path');
});

test('bad arguments, unknown codes, and unreachable API fail with exit 1', async (t) => {
  const api = await startApi();
  t.after(api.close);

  const badArgs = await run(['open'], { SNIP_API: api.base });
  assert.equal(badArgs.status, 1);
  assert.match(badArgs.stderr, /Usage: snip open/);

  const missing = await run(['open', 'missing'], { SNIP_API: api.base });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Unknown short code: missing/);

  const unreachable = await run(['ls'], { SNIP_API: 'http://127.0.0.1:1' });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, /Could not reach the Snip API/);
});
