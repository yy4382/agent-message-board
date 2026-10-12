import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { validateConfig } from '../src/config.js';

const token = 'admin-credential-with-at-least-32-bytes';
const origin = 'https://board.example.com';
const auth = { authorization: `Bearer ${token}` };

async function setup(t: any) {
  const app = createApp({ adminToken: token, publicOrigin: origin, databasePath: ':memory:' });
  t.after(() => app.close());
  const channel = (await app.inject({ method: 'POST', url: '/api/v1/admin/channels', headers: auth,
    payload: { name: 'boundaries', description: '' } })).json();
  const created = (await app.inject({ method: 'POST', url: `/api/v1/admin/channels/${channel.id}/members`,
    headers: auth, payload: { display_name: 'reader' } })).json();
  return { app, channel, memberToken: created.token, memberId: created.member.id,
    base: `/api/v1/channels/${channel.id}` };
}

test('production cookie security and expired sessions', async t => {
  const { app } = await setup(t);
  const login = await app.inject({ method: 'POST', url: '/api/v1/admin/session',
    headers: { origin }, payload: { token } });
  assert.equal(login.statusCode, 200);
  const raw = String(login.headers['set-cookie']);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) assert.ok(raw.includes(attribute));
  const cookie = raw.split(';')[0];
  assert.equal((await app.inject({ url: '/api/v1/admin/channels', headers: { cookie } })).statusCode, 200);
  app.board.store.run("UPDATE admin_sessions SET expires_at='2000-01-01T00:00:00.000Z'");
  assert.equal((await app.inject({ url: '/api/v1/admin/channels', headers: { cookie } })).statusCode, 401);
});

test('configuration rejects public insecure origins and missing admin credentials', () => {
  const valid = { adminToken: token, publicOrigin: origin, databasePath: ':memory:' };
  assert.throws(() => validateConfig({ ...valid, adminToken: '' }));
  assert.throws(() => validateConfig({ ...valid, publicOrigin: 'http://board.example.com', devHttp: true }));
  assert.throws(() => validateConfig({ ...valid, publicOrigin: 'https://board.example.com/path' }));
  assert.throws(() => validateConfig({ ...valid, publicOrigin: 'https://user:pass@board.example.com' }));
  assert.throws(() => validateConfig({ ...valid, port: -1 }));
  assert.doesNotThrow(() => validateConfig({ ...valid, publicOrigin: 'http://localhost:3000', devHttp: true }));
});

test('strict input validation covers null control fields, empty references and unsafe cursors', async t => {
  const { app, base, memberToken } = await setup(t);
  const headers = { authorization: `Bearer ${memberToken}`, 'idempotency-key': 'boundary-key' };
  for (const extra of [{ override: null }, { mention_member_ids: null }, { based_on_seq: 0.5 },
    { based_on_seq: Number.MAX_SAFE_INTEGER + 1 }, { author_member_id: 'forged' }]) {
    const result = await app.inject({ method: 'POST', url: `${base}/messages`, headers,
      payload: { body: 'valid text', based_on_seq: 0, ...extra } });
    assert.equal(result.statusCode, 422, JSON.stringify(extra));
    assert.equal(result.json().error.code, 'validation_error');
  }
  const reference = await app.inject({ method: 'POST', url: `${base}/messages`, headers,
    payload: { body: 'valid text', based_on_seq: 0, reply_to_message_id: '' } });
  assert.equal(reference.statusCode, 422);
  assert.equal(reference.json().error.code, 'invalid_reference');
  for (const query of ['after=0&before=1', 'before=1&wait=0', 'after=0&wait=31',
    'after=0&limit=101', 'after=-1', 'after=0&author=other', 'after=0&after=1']) {
    assert.equal((await app.inject({ url: `${base}/messages?${query}`, headers })).statusCode, 422, query);
  }
  assert.equal((await app.inject({ url: `${base}/members?cursor=not-json`, headers })).statusCode, 422);
  assert.equal((await app.inject({ url: `${base}/context`, headers })).json().snapshot_seq, 0);
});

test('HTTP and UTF-8 message limits return structured errors without reserving a send key', async t => {
  const { app, base, memberToken } = await setup(t);
  const headers = { authorization: `Bearer ${memberToken}`, 'idempotency-key': 'size-limit-key' };
  for (const body of ['a'.repeat(32769), '界'.repeat(10923)]) {
    const response = await app.inject({ method: 'POST', url: `${base}/messages`, headers,
      payload: { body, based_on_seq: 0 } });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, 'request_too_large');
  }
  const huge = await app.inject({ method: 'POST', url: `${base}/messages`, headers,
    payload: { body: 'a'.repeat(65536), based_on_seq: 0 } });
  assert.equal(huge.statusCode, 413);
  assert.equal((await app.inject({ url: `${base}/sends/size-limit-key`, headers })).statusCode, 404);
  const invalidJson = await app.inject({ method: 'POST', url: `${base}/messages`,
    headers: { ...headers, 'content-type': 'application/json' }, payload: '{' });
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidJson.json().error.code, 'invalid_json');
  const valid = await app.inject({ method: 'POST', url: `${base}/messages`, headers,
    payload: { body: 'a'.repeat(32768), based_on_seq: 0 } });
  assert.equal(valid.statusCode, 201);
});

test('replay precedes future-cursor and freshness checks but preserves original control data', async t => {
  const { app, base, memberToken } = await setup(t);
  const headers = { authorization: `Bearer ${memberToken}`, 'idempotency-key': 'replay-control-key' };
  const original = await app.inject({ method: 'POST', url: `${base}/messages`, headers,
    payload: { body: 'unchanged', based_on_seq: 0 } });
  assert.equal(original.statusCode, 201);
  const replay = await app.inject({ method: 'POST', url: `${base}/messages`, headers,
    payload: { body: 'unchanged', based_on_seq: 999, override: true, override_reason: 'Changed attempt' } });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json().message, original.json().message);
});

test('long polling rechecks the database when a commit occurs before waiter registration without a signal', async t => {
  const { app, base, channel, memberToken, memberId } = await setup(t);
  const store = app.board.store;
  const original = store.snapshot;
  let inserted = false;
  store.snapshot = function<T>(fn: () => T): T {
    const result = original.call(this, fn) as T;
    if (!inserted && Array.isArray((result as any).messages) && (result as any).messages.length === 0) {
      inserted = true;
      // Inject the exact race between an empty database check and registration.
      // There is deliberately no notification; the database remains the truth.
      this.transaction(() => {
        this.run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', 'msg_registration_race',
          channel.id, 1, memberId, 'Committed during registration', null, 0, 0, null, 0, 0,
          new Date().toISOString());
        this.run('UPDATE channels SET head_seq=1 WHERE id=?', channel.id);
      });
    }
    return result;
  };
  const began = Date.now();
  const response = await app.inject({ url: `${base}/messages?after=0&wait=3`,
    headers: { authorization: `Bearer ${memberToken}` } });
  store.snapshot = original;
  assert.equal(inserted, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().messages[0].id, 'msg_registration_race');
  assert.ok(Date.now() - began < 1000, 'Commit must be found before the wait timeout');
  assert.equal(app.board.waiterCount, 0);
});
