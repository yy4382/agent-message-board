import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.js';

const adminToken = 'a'.repeat(64);
const origin = 'http://localhost:3000';
const config = (databasePath = ':memory:') => ({ adminToken, publicOrigin: origin, databasePath, devHttp: true });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
type App = Awaited<ReturnType<typeof createApp>>;
type Member = { member: { id: string }; token: string };

async function channel(app: App, name = 'discussion') {
  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/channels', headers: auth(adminToken), payload: { name, description: 'Shared investigation' } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
async function member(app: App, channelId: string, name: string): Promise<Member> {
  const response = await app.inject({ method: 'POST', url: `/api/v1/admin/channels/${channelId}/members`, headers: auth(adminToken), payload: { display_name: name, platform_label: 'test' } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
function send(app: App, channelId: string, token: string, key: string, payload: object) {
  return app.inject({ method: 'POST', url: `/api/v1/channels/${channelId}/messages`, headers: { ...auth(token), 'idempotency-key': key }, payload });
}
async function fixture(t: any) {
  const app = await createApp(config());
  t.after(() => app.close());
  const ch = await channel(app);
  const a = await member(app, ch.id, 'A');
  const b = await member(app, ch.id, 'B');
  return { app, ch, a, b };
}
function error(response: any, status: number, code: string) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
}

test('concurrent ordinary sends serialize the freshness check and append', async (t) => {
  const { app, ch, a, b } = await fixture(t);
  const responses = await Promise.all([
    send(app, ch.id, a.token, 'concurrent-a', { body: 'A evidence', based_on_seq: 0 }),
    send(app, ch.id, b.token, 'concurrent-b', { body: 'B evidence', based_on_seq: 0 }),
  ]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409]);
  const loser = responses[0].statusCode === 409 ? a : b;
  const rejected = responses.find(r => r.statusCode === 409)!;
  assert.equal(rejected.json().error.code, 'stale_context');
  assert.deepEqual(rejected.json().error.details, { based_on_seq: 0, current_head_seq: 1, unseen_other_count: 1, read_after: 0 });
  const retry = await send(app, ch.id, loser.token, responses[0].statusCode === 409 ? 'concurrent-a' : 'concurrent-b', { body: responses[0].statusCode === 409 ? 'A evidence' : 'B evidence', based_on_seq: 1 });
  assert.equal(retry.statusCode, 201, retry.body);
  assert.equal(retry.json().message.seq, 2);
});

test('own messages do not gate; override preserves the actual stale context', async (t) => {
  const { app, ch, a, b } = await fixture(t);
  assert.equal((await send(app, ch.id, a.token, 'own-first', { body: 'one', based_on_seq: 0 })).statusCode, 201);
  const second = await send(app, ch.id, a.token, 'own-second', { body: 'two', based_on_seq: 0 });
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().message.stale_at_commit, false);
  error(await send(app, ch.id, b.token, 'other-stale', { body: 'three', based_on_seq: 0 }), 409, 'stale_context');
  const overridden = await send(app, ch.id, b.token, 'other-stale', { body: 'three', based_on_seq: 0, override: true, override_reason: 'Independent result' });
  assert.equal(overridden.statusCode, 201, overridden.body);
  assert.equal(overridden.json().message.based_on_seq, 0);
  assert.equal(overridden.json().message.head_seq_at_commit, 2);
  assert.equal(overridden.json().message.stale_at_commit, true);
  assert.equal(overridden.json().message.override_reason, 'Independent result');
  error(await send(app, ch.id, b.token, 'future-seq', { body: 'future', based_on_seq: 4, override: true, override_reason: 'Still invalid' }), 422, 'cursor_ahead');
});

test('idempotent concurrent retries commit once and replay before freshness checks', async (t) => {
  const { app, ch, a, b } = await fixture(t);
  const payload = { body: 'Original exact text ', based_on_seq: 0, mention_member_ids: [a.member.id, b.member.id, a.member.id] };
  const responses = await Promise.all(Array.from({ length: 6 }, () => send(app, ch.id, a.token, 'stable-key', payload)));
  assert.equal(responses.filter(r => r.statusCode === 201).length, 1);
  assert.ok(responses.every(r => [200, 201].includes(r.statusCode)));
  assert.equal(new Set(responses.map(r => r.json().message.id)).size, 1);
  await send(app, ch.id, b.token, 'stable-key', { body: 'Later evidence', based_on_seq: 1 });
  const replay = await send(app, ch.id, a.token, 'stable-key', { ...payload, mention_member_ids: [b.member.id, a.member.id], based_on_seq: 2, override: true, override_reason: 'Changed control only' });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().message.based_on_seq, 0);
  assert.equal(replay.json().message.override, false);
  error(await send(app, ch.id, a.token, 'stable-key', { ...payload, body: 'Original exact text' }), 409, 'idempotency_key_reused');
  const recovery = await app.inject({ url: `/api/v1/channels/${ch.id}/sends/stable-key`, headers: auth(a.token) });
  assert.equal(recovery.json().message.id, replay.json().message.id);
  error(await app.inject({ url: `/api/v1/channels/${ch.id}/sends/unknown-key`, headers: auth(a.token) }), 404, 'send_not_found');
  const page = (await app.inject({ url: `/api/v1/channels/${ch.id}/messages?after=0`, headers: auth(a.token) })).json();
  assert.deepEqual(page.messages.map((m: any) => m.seq), [1, 2]);
});

test('pagination does not skip backlog and reads only advance on explicit confirmation', async (t) => {
  const { app, ch, a, b } = await fixture(t);
  for (let i = 1; i <= 7; i++) assert.equal((await send(app, ch.id, a.token, `page-key-${i}`, { body: `message ${i}`, based_on_seq: 0 })).statusCode, 201);
  const get = (path: string) => app.inject({ url: `/api/v1/channels/${ch.id}/${path}`, headers: auth(b.token) });
  const context = (await get('context?limit=3')).json();
  assert.equal(context.snapshot_seq, 7);
  assert.equal(context.history_start_seq, 5);
  assert.equal(context.history_truncated, true);
  assert.equal(context.self.read_seq, 0);
  assert.equal(context.self.context_initialized, false);
  let after = 0;
  const seqs: number[] = [];
  for (;;) {
    const page = (await get(`messages?after=${after}&limit=2`)).json();
    assert.equal(page.snapshot_seq, 7);
    seqs.push(...page.messages.map((m: any) => m.seq));
    after = page.next_after;
    if (!page.has_more) break;
    assert.ok(after < page.snapshot_seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal((await get('context')).json().self.read_seq, 0);
  const history = (await get('messages?before=5&limit=2')).json();
  assert.deepEqual(history.messages.map((m: any) => m.seq), [3, 4]);
  assert.equal(history.next_before, 3);
  assert.equal(history.has_more, true);
  const confirm = (read_seq: number) => app.inject({ method: 'PUT', url: `/api/v1/channels/${ch.id}/read-position`, headers: auth(b.token), payload: { read_seq } });
  assert.deepEqual((await confirm(5)).json(), { read_seq: 5, context_initialized: true });
  assert.equal((await confirm(2)).json().read_seq, 5);
  error(await confirm(8), 422, 'cursor_ahead');
  error(await get('messages?after=8'), 422, 'cursor_ahead');
});

test('empty-channel confirmation initializes context and descriptions do not append messages', async (t) => {
  const { app, ch, a } = await fixture(t);
  const response = await app.inject({ method: 'PUT', url: `/api/v1/channels/${ch.id}/read-position`, headers: auth(a.token), payload: { read_seq: 0 } });
  assert.deepEqual(response.json(), { read_seq: 0, context_initialized: true });
  const changed = await app.inject({ method: 'PATCH', url: `/api/v1/admin/channels/${ch.id}`, headers: auth(adminToken), payload: { description: 'Revised goal' } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().head_seq, 0);
  const context = (await app.inject({ url: `/api/v1/channels/${ch.id}/context`, headers: auth(a.token) })).json();
  assert.equal(context.self.context_initialized, true);
  assert.equal(context.history_start_seq, null);
  assert.equal(context.history_truncated, false);
  assert.equal(context.channel.description, 'Revised goal');
});

test('channel-bound credentials cannot switch identities, references, or mentions', async (t) => {
  const { app, ch, a, b } = await fixture(t);
  const other = await channel(app, 'private other');
  const outsider = await member(app, other.id, 'Outside');
  const outsideMessage = await send(app, other.id, outsider.token, 'outside-msg', { body: 'secret', based_on_seq: 0 });
  error(await app.inject({ url: `/api/v1/channels/${other.id}/context`, headers: auth(a.token) }), 404, 'channel_not_found');
  error(await app.inject({ url: '/api/v1/channels/nonexistent/context', headers: auth(a.token) }), 404, 'channel_not_found');
  error(await app.inject({ url: `/api/v1/channels/${ch.id}/context`, headers: auth('bad') }), 401, 'invalid_token');
  error(await send(app, ch.id, adminToken, 'admin-send', { body: 'no', based_on_seq: 0 }), 401, 'invalid_token');
  error(await send(app, ch.id, a.token, 'forged-id', { body: 'no', based_on_seq: 0, author_member_id: b.member.id }), 422, 'validation_error');
  error(await send(app, ch.id, a.token, 'wrong-ref', { body: 'no', based_on_seq: 0, reply_to_message_id: outsideMessage.json().message.id }), 422, 'invalid_reference');
  error(await send(app, ch.id, a.token, 'wrong-tag', { body: 'no', based_on_seq: 0, mention_member_ids: [outsider.member.id] }), 422, 'invalid_mention');
  const listing = await app.inject({ url: `/api/v1/channels/${ch.id}/members`, headers: auth(a.token) });
  for (const item of listing.json().items) {
    for (const field of ['token', 'token_digest', 'read_seq', 'last_request_at']) assert.equal(field in item, false);
  }
  assert.equal(listing.headers['cache-control'], 'no-store');
});

test('request validation bounds UTF-8 messages, JSON bodies and control fields', async (t) => {
  const { app, ch, a } = await fixture(t);
  error(await send(app, ch.id, a.token, 'blank-key', { body: ' \n\t', based_on_seq: 0 }), 422, 'validation_error');
  error(await send(app, ch.id, a.token, 'fractional-key', { body: 'text', based_on_seq: 0.5 }), 422, 'validation_error');
  error(await send(app, ch.id, a.token, 'override-key', { body: 'text', based_on_seq: 0, override: true }), 422, 'validation_error');
  error(await send(app, ch.id, a.token, 'reason-key', { body: 'text', based_on_seq: 0, override_reason: 'Unrequested override' }), 422, 'validation_error');
  error(await send(app, ch.id, a.token, 'oversize-key', { body: '你'.repeat(11000), based_on_seq: 0 }), 413, 'request_too_large');
  error(await send(app, ch.id, a.token, 'body-limit-key', { body: 'x'.repeat(70000), based_on_seq: 0 }), 413, 'request_too_large');
  error(await app.inject({ method: 'POST', url: `/api/v1/channels/${ch.id}/messages`, headers: { ...auth(a.token), 'content-type': 'application/json', 'idempotency-key': 'malformed-key' }, payload: '{' }), 400, 'invalid_json');
  const max = await send(app, ch.id, a.token, 'max-body-key', { body: 'x'.repeat(32768), based_on_seq: 0 });
  assert.equal(max.statusCode, 201, max.body);
  for (const query of ['after=0&wait=31', 'after=0&limit=101', 'after=0&before=1', 'before=1&wait=0']) {
    error(await app.inject({ url: `/api/v1/channels/${ch.id}/messages?${query}`, headers: auth(a.token) }), 422, 'validation_error');
  }
});

test('cookie admin sessions enforce Origin while bearer administration is independent', async (t) => {
  const { app } = await fixture(t);
  const login = (requestOrigin?: string) => app.inject({ method: 'POST', url: '/api/v1/admin/session', headers: requestOrigin ? { origin: requestOrigin } : {}, payload: { token: adminToken } });
  error(await login(), 403, 'origin_rejected');
  error(await login('https://evil.example'), 403, 'origin_rejected');
  const logged = await login(origin);
  assert.equal(logged.statusCode, 200, logged.body);
  const rawCookie = String(logged.headers['set-cookie']);
  assert.match(rawCookie, /HttpOnly/i);
  assert.match(rawCookie, /SameSite=Strict/i);
  const cookie = rawCookie.split(';')[0];
  assert.equal((await app.inject({ url: '/api/v1/admin/channels', headers: { cookie } })).statusCode, 200);
  error(await app.inject({ url: '/api/v1/admin/channels', headers: { cookie, origin: 'https://evil.example' } }), 403, 'origin_rejected');
  error(await app.inject({ method: 'POST', url: '/api/v1/admin/channels', headers: { cookie }, payload: { name: 'blocked', description: '' } }), 403, 'origin_rejected');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/channels', headers: { cookie, origin }, payload: { name: 'allowed', description: '' } })).statusCode, 201);
  const logout = await app.inject({ method: 'DELETE', url: '/api/v1/admin/session', headers: { cookie, origin } });
  assert.equal(logout.statusCode, 204);
  error(await app.inject({ url: '/api/v1/admin/channels', headers: { cookie } }), 401, 'admin_unauthorized');
});

test('production session cookies are Secure and independent of proxy request headers', async (t) => {
  const app = await createApp({ ...config(), publicOrigin: 'https://board.example.com', devHttp: false });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/session', headers: { origin: 'https://board.example.com', 'x-forwarded-proto': 'http' }, payload: { token: adminToken } });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['set-cookie']), /; Secure/i);
});

test('restart preserves identities, messages, read cursors and idempotent recovery', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'amb-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'board.sqlite');
  let app = await createApp(config(databasePath));
  const ch = await channel(app);
  const a = await member(app, ch.id, 'A');
  const original = await send(app, ch.id, a.token, 'persist-key', { body: 'persisted evidence', based_on_seq: 0 });
  await app.inject({ method: 'PUT', url: `/api/v1/channels/${ch.id}/read-position`, headers: auth(a.token), payload: { read_seq: 1 } });
  await app.close();
  app = await createApp(config(databasePath));
  t.after(() => app.close());
  const context = (await app.inject({ url: `/api/v1/channels/${ch.id}/context`, headers: auth(a.token) })).json();
  assert.equal(context.self.read_seq, 1);
  assert.equal(context.self.context_initialized, true);
  assert.equal(context.messages[0].id, original.json().message.id);
  const retry = await send(app, ch.id, a.token, 'persist-key', { body: 'persisted evidence', based_on_seq: 0 });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().message.seq, 1);
});

async function start(app: App) {
  return app.listen({ port: 0, host: '127.0.0.1' });
}
async function waitUntil(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for lifecycle condition');
    await delay(10);
  }
}
function waiterCount(app: App) {
  const board = (app as any).board;
  assert.ok(board, 'app.board must expose long-poll lifecycle diagnostics');
  return typeof board.waiterCount === 'function' ? board.waiterCount() : board.waiterCount;
}

test('long poll wakes on commits, times out with 200 and releases aborted waiters', async (t) => {
  const { app, ch, a, b } = await fixture(t);
  const base = await start(app);
  const url = `${base}/api/v1/channels/${ch.id}/messages`;
  const pending = fetch(`${url}?after=0&wait=5`, { headers: auth(b.token) });
  await waitUntil(() => waiterCount(app) === 1);
  const sent = await send(app, ch.id, a.token, 'wake-poll', { body: 'Wake up', based_on_seq: 0 });
  assert.equal(sent.statusCode, 201);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).messages[0].seq, 1);
  await waitUntil(() => waiterCount(app) === 0);
  const began = Date.now();
  const timed = await fetch(`${url}?after=1&wait=1`, { headers: auth(b.token) });
  assert.equal(timed.status, 200);
  assert.deepEqual((await timed.json()).messages, []);
  assert.ok(Date.now() - began >= 800);
  const disconnected = request(`${url}?after=1&wait=30`, { headers: auth(b.token) });
  disconnected.on('error', () => {});
  disconnected.end();
  await waitUntil(() => waiterCount(app) === 1);
  disconnected.destroy();
  await waitUntil(() => waiterCount(app) === 0);
});

test('revocation wakes pending long polls, denies replay and preserves historical authors', async (t) => {
  const { app, ch, a, b } = await fixture(t);
  await send(app, ch.id, b.token, 'before-revoke', { body: 'Historical evidence', based_on_seq: 0 });
  const base = await start(app);
  const pending = fetch(`${base}/api/v1/channels/${ch.id}/messages?after=1&wait=30`, { headers: auth(b.token) });
  await waitUntil(() => waiterCount(app) === 1);
  const revoke = () => app.inject({ method: 'DELETE', url: `/api/v1/admin/channels/${ch.id}/members/${b.member.id}/token`, headers: auth(adminToken) });
  assert.equal((await revoke()).statusCode, 204);
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'invalid_token');
  assert.equal((await revoke()).statusCode, 204);
  error(await send(app, ch.id, b.token, 'before-revoke', { body: 'Historical evidence', based_on_seq: 0 }), 401, 'invalid_token');
  const members = (await app.inject({ url: `/api/v1/channels/${ch.id}/members`, headers: auth(a.token) })).json();
  assert.ok(members.items.find((m: any) => m.id === b.member.id).revoked_at);
  const messages = (await app.inject({ url: `/api/v1/channels/${ch.id}/messages?after=0`, headers: auth(a.token) })).json();
  assert.equal(messages.messages[0].author_member_id, b.member.id);
  await waitUntil(() => waiterCount(app) === 0);
});

test('graceful shutdown releases active long polls with a retryable response', async (t) => {
  const { app, ch, a } = await fixture(t);
  const base = await start(app);
  const pending = fetch(`${base}/api/v1/channels/${ch.id}/messages?after=0&wait=30`, { headers: { ...auth(a.token), connection: 'close' } });
  await waitUntil(() => waiterCount(app) === 1);
  const closing = app.close();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'temporarily_unavailable');
  await closing;
  assert.equal(waiterCount(app), 0);
});
