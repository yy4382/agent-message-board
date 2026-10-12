import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, request as httpRequest } from 'node:http';

// Exercise the compiled service through real curl requests. Credentials travel
// over stdin, never curl argv or printed test output.
const directory = await mkdtemp(join(tmpdir(), 'amb-e2e-'));
const admin = randomBytes(32).toString('hex');
const port = 20000 + Math.floor(Math.random() * 20000);
const origin = `http://localhost:${port}`;
let server;
let logs = '';
const secrets = [admin];

async function request(method, path, token, body, extraHeaders = [], requestOrigin = origin) {
  const config = [
    `url = ${JSON.stringify(requestOrigin + path)}`,
    `request = ${JSON.stringify(method)}`,
    'silent', 'show-error', 'max-time = 40',
    ...(token ? [`header = ${JSON.stringify(`Authorization: Bearer ${token}`)}`] : []),
    ...extraHeaders.map(header => `header = ${JSON.stringify(header)}`),
    ...(body === undefined ? [] : [
      'header = "Content-Type: application/json"',
      `data = ${JSON.stringify(JSON.stringify(body))}`,
    ]),
  ].join('\n');
  const child = spawn('curl', ['--config', '-', '--write-out', '\n%{http_code}']);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(config + '\n');
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`curl failed (${code}): ${stderr}`)));
  });
  const newline = stdout.lastIndexOf('\n');
  const raw = stdout.slice(0, newline);
  return { status: Number(stdout.slice(newline + 1)), body: raw ? JSON.parse(raw) : null };
}

async function start() {
  server = spawn(process.execPath, ['dist/server.js'], {
    env: { ...process.env, PORT: String(port), AMB_ADMIN_TOKEN: admin,
      AMB_PUBLIC_ORIGIN: origin, AMB_DATABASE_PATH: join(directory, 'board.sqlite'), AMB_DEV_HTTP: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Service exited (${server.exitCode}) before ready`);
    try { if ((await request('GET', '/healthz')).status === 200) return; } catch {}
    await delay(100);
  }
  throw new Error('Service did not become ready');
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  const closed = new Promise(resolve => server.once('close', resolve));
  server.kill('SIGTERM');
  await Promise.race([closed, delay(5000, undefined, { ref: false }).then(() => server.kill('SIGKILL'))]);
  await closed;
}

const ok = (response, status = 200) => { assert.equal(response.status, status); return response.body; };
try {
  await start();
  assert.equal((await request('GET', '/api/v1/admin/channels')).status, 401);
  const channel = ok(await request('POST', '/api/v1/admin/channels', admin,
    { name: 'curl acceptance', description: 'Real HTTP integration' }), 201);
  const other = ok(await request('POST', '/api/v1/admin/channels', admin,
    { name: 'isolated', description: '' }), 201);
  async function member(channelId, display_name) {
    const created = ok(await request('POST', `/api/v1/admin/channels/${channelId}/members`, admin,
      { display_name, platform_label: 'curl' }), 201);
    secrets.push(created.token);
    return created;
  }
  const a = await member(channel.id, 'A');
  const b = await member(channel.id, 'B');
  const c = await member(other.id, 'C');
  // Actually discard a committed HTTP response at a proxy, then recover its key.
  const lostKey = randomUUID();
  const lostPayload = { body: 'Response discarded after commit', based_on_seq: 0 };
  const proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest(origin + incoming.url, { method: incoming.method, headers: incoming.headers }, response => {
      response.resume();
      outgoing.destroy();
    });
    upstream.on('error', () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
    await assert.rejects(request('POST', `/api/v1/channels/${other.id}/messages`, c.token,
      lostPayload, [`Idempotency-Key: ${lostKey}`], proxyOrigin), /curl failed/);
  } finally { await new Promise(resolve => proxy.close(resolve)); }
  const recovered = ok(await request('GET', `/api/v1/channels/${other.id}/sends/${lostKey}`, c.token));
  const retried = ok(await request('POST', `/api/v1/channels/${other.id}/messages`, c.token,
    lostPayload, [`Idempotency-Key: ${lostKey}`]));
  assert.equal(retried.replayed, true);
  assert.equal(retried.message.id, recovered.message.id);
  assert.equal(ok(await request('GET', `/api/v1/channels/${other.id}/messages?after=0`, c.token)).messages.length, 1);
  const base = `/api/v1/channels/${channel.id}`;
  const context = ok(await request('GET', `${base}/context`, a.token));
  assert.equal(context.self.id, a.member.id);
  assert.equal(context.self.context_initialized, false);
  assert.equal(context.snapshot_seq, 0);
  assert.equal((await request('GET', `${base}/context`, c.token)).status, 404);
  assert.equal(ok(await request('PUT', `${base}/read-position`, a.token, { read_seq: 0 })).context_initialized, true);
  const send = (who, key, payload) => request('POST', `${base}/messages`, who.token,
    payload, [`Idempotency-Key: ${key}`]);
  const keyA = randomUUID(), keyB = randomUUID();
  const payloadA = { body: 'first A', based_on_seq: 0 };
  const payloadB = { body: 'first B', based_on_seq: 0 };
  const race = await Promise.all([send(a, keyA, payloadA), send(b, keyB, payloadB)]);
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  const winner = race[0].status === 201 ? a : b;
  const loser = winner === a ? b : a;
  const winnerKey = winner === a ? keyA : keyB;
  const winnerPayload = winner === a ? payloadA : payloadB;
  const first = race.find(r => r.status === 201).body.message;
  const stale = race.find(r => r.status === 409);
  assert.equal(stale.body.error.code, 'stale_context');
  const second = ok(await send(loser, randomUUID(), { body: 'Reviewed first', based_on_seq: 1,
    reply_to_message_id: first.id, mention_member_ids: [winner.member.id] }), 201).message;
  assert.equal(second.seq, 2);
  // Treat the first successful response as lost, then query/retry its exact key.
  assert.equal(ok(await request('GET', `${base}/sends/${winnerKey}`, winner.token)).message.id, first.id);
  assert.equal(ok(await send(winner, winnerKey, winnerPayload)).message.id, first.id);
  assert.equal((await send(winner, winnerKey, { ...winnerPayload, body: 'different' })).status, 409);
  // Own newer messages cannot make this member stale.
  ok(await send(loser, randomUUID(), { body: 'Own message allowed', based_on_seq: 1 }), 201);
  const override = ok(await send(winner, randomUUID(), { body: 'Independent result', based_on_seq: 1,
    override: true, override_reason: 'Independent work remains useful' }), 201).message;
  assert.equal(override.stale_at_commit, true);
  assert.equal(override.head_seq_at_commit, 3);
  let after = 0;
  const sequences = [];
  while (true) {
    const page = ok(await request('GET', `${base}/messages?after=${after}&limit=1`, a.token));
    sequences.push(...page.messages.map(message => message.seq));
    after = page.next_after;
    if (!page.has_more) break;
  }
  assert.deepEqual(sequences, [1, 2, 3, 4]);
  assert.equal(ok(await request('GET', `${base}/context`, a.token)).self.read_seq, 0);
  ok(await request('PUT', `${base}/read-position`, a.token, { read_seq: 4 }));
  assert.equal(ok(await request('PUT', `${base}/read-position`, a.token, { read_seq: 1 })).read_seq, 4);
  const waiting = request('GET', `${base}/messages?after=4&wait=10`, b.token);
  await delay(150);
  const fifthKey = randomUUID();
  const fifthPayload = { body: 'Wake waiter', based_on_seq: 4 };
  const fifth = ok(await send(a, fifthKey, fifthPayload), 201).message;
  assert.equal(ok(await waiting).messages[0].id, fifth.id);
  const revokedWait = request('GET', `${base}/messages?after=5&wait=10`, b.token);
  await delay(150);
  ok(await request('DELETE', `/api/v1/admin/channels/${channel.id}/members/${b.member.id}/token`, admin), 204);
  assert.equal((await revokedWait).status, 401);
  assert.equal((await request('GET', `${base}/context`, b.token)).status, 401);
  await stop();
  await start();
  assert.equal(ok(await request('GET', `${base}/context`, a.token)).self.read_seq, 4);
  assert.equal(ok(await request('GET', `${base}/messages?after=0`, a.token)).messages.length, 5);
  assert.equal(ok(await send(a, fifthKey, fifthPayload)).message.id, fifth.id);
  // If B won the race its revoked token cannot recover sends; inspect A's surviving send instead.
  const persisted = ok(await request('GET', `${base}/messages?after=0`, a.token));
  assert.equal(persisted.messages[0].id, first.id);
  const members = ok(await request('GET', `/api/v1/admin/channels/${channel.id}/members`, admin));
  assert.equal(JSON.stringify(members).includes('token_digest'), false);
  for (const secret of secrets) assert.equal(logs.includes(secret), false, 'Credential appeared in logs');
  console.log('PASS: curl onboarding, isolation, concurrent gating, idempotent recovery, references, mentions, override, pagination, read confirmation, long polling, revocation and restart.');
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
