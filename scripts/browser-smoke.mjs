import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const { chromium } = createRequire(import.meta.url)('playwright');
const directory = await mkdtemp(join(tmpdir(), 'amb-browser-'));
const token = randomBytes(32).toString('hex');
const port = 40000 + Math.floor(Math.random() * 15000);
const origin = `http://localhost:${port}`;
const server = spawn(process.execPath, ['dist/server.js'], { env: { ...process.env,
  AMB_ADMIN_TOKEN: token, AMB_PUBLIC_ORIGIN: origin, AMB_DATABASE_PATH: join(directory, 'board.sqlite'),
  AMB_DEV_HTTP: 'true', PORT: String(port) }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Server exited before browser smoke test');
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    await delay(100);
  }
  const executablePath = process.env.AMB_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#workspace').isVisible(), false);
  await page.locator('#admin-token').fill(token);
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#admin-token').inputValue(), '');
  await page.locator('#new-channel').click();
  await page.locator('#field-name').fill('浏览器验收');
  await page.locator('#field-description').fill('**共同目标**：可验证的协作。');
  await page.locator('#editor-form button[type=submit]').click();
  await page.locator('#channel-name').filter({ hasText: '浏览器验收' }).waitFor();
  const channelId = (await page.locator('#channel-id').textContent()).trim();
  await page.locator('#edit-channel').click();
  await page.locator('#field-description').fill('**目标已更新**：验证引用和安全渲染。');
  await page.locator('#editor-form button[type=submit]').click();
  await page.locator('#description strong').filter({ hasText: '目标已更新' }).waitFor();

  async function createMember(name) {
    await page.locator('#members-tab').click();
    await page.locator('#new-member').click();
    await page.locator('#field-display_name').fill(name);
    await page.locator('#field-platform_label').fill('浏览器测试');
    await page.locator('#editor-form button[type=submit]').click();
    await page.locator('#credential').waitFor({ state: 'visible' });
    const text = await page.locator('#connection-text').inputValue();
    const memberToken = /^Token: (.+)$/m.exec(text)[1];
    const id = /^Member ID: (.+)$/m.exec(text)[1];
    await page.locator('#copy-credential').click();
    await page.waitForFunction(() => document.getElementById('copy-status').textContent.includes('已复制'));
    assert.ok(await page.evaluate(() => navigator.clipboard.readText()) === text, 'Clipboard differs from connection text');
    await page.locator('#close-credential').click();
    await page.waitForFunction(() => document.getElementById('connection-text').value === '');
    return { id, token: memberToken };
  }
  const a = await createMember('Agent A');
  const b = await createMember('Agent B');
  async function send(who, body, based_on_seq, options = {}) {
    const response = await fetch(`${origin}/api/v1/channels/${channelId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() }, body: JSON.stringify({ body, based_on_seq, ...options }) });
    assert.equal(response.status, 201);
    return (await response.json()).message;
  }
  const first = await send(a, 'First source **evidence**', 0);
  for (let i = 2; i <= 60; i++) await send(a, `Backlog ${i}`, 0);
  await send(b, 'Agent B evidence', 60);
  const malicious = '<img src=x onerror="window.__attack=true"> <script>window.__attack=true</script> [danger](javascript:alert(1)) **Safe bold** [source](https://example.com)';
  const last = await send(a, malicious, 0, { override: true, override_reason: 'Independent validated result',
    reply_to_message_id: first.id, mention_member_ids: [b.id] });
  // Re-select to verify the first recent window intentionally omits old history.
  await page.locator('#channels .channel-item').click();
  await page.locator('#messages-tab').click();
  await page.locator(`#message-${last.id}`).waitFor();
  const lastCard = page.locator(`#message-${last.id}`);
  assert.equal(await lastCard.locator('img,script').count(), 0);
  assert.equal(await lastCard.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__attack), undefined);
  assert.equal(await lastCard.locator('strong').filter({ hasText: 'Safe bold' }).count(), 1);
  assert.equal(await lastCard.locator('a').getAttribute('rel'), 'noopener noreferrer');
  assert.ok((await lastCard.locator('.mentions').textContent()).includes('Agent B'));
  await lastCard.locator('summary').click();
  assert.ok((await lastCard.locator('.override').textContent()).includes('Independent validated result'));
  // A sidebar refresh updates the persisted head, so recent-window behavior can be re-tested after reload.
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#channels .channel-item').click();
  await page.locator(`#message-${last.id}`).waitFor();
  assert.equal(await page.locator('#older').isVisible(), true);
  assert.equal(await page.locator(`#message-${first.id}`).count(), 0);
  await page.locator(`#message-${last.id} .reference`).click();
  await page.locator(`#message-${first.id}`).waitFor();
  const seqs = await page.locator('#messages .seq').allTextContents();
  assert.deepEqual(seqs, Array.from({ length: 62 }, (_, i) => `#${i + 1}`));
  const newest = await send(b, 'Live update after reload', 62);
  await page.locator(`#message-${newest.id}`).waitFor({ timeout: 10000 });
  // Network failure keeps already-loaded records and recovers from their cursor.
  await context.setOffline(true);
  await page.locator('#refresh-messages').click();
  await page.waitForFunction(() => document.getElementById('message-status').textContent.includes('网络'));
  assert.equal(await page.locator(`#message-${newest.id}`).count(), 1);
  await context.setOffline(false);
  await page.locator('#refresh-messages').click();
  await page.waitForFunction(() => document.getElementById('message-status').textContent.includes('等待更新'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: join(directory, 'mobile.png'), fullPage: true });
  await page.locator('#members-tab').click();
  const memberCard = page.locator('.member').filter({ hasText: b.id });
  await memberCard.getByRole('button', { name: '撤销凭证' }).click();
  await page.locator('#revoke-dialog').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#revoke-object').textContent()).includes(b.id));
  await page.locator('#revoke-form button[type=submit]').click();
  await memberCard.locator('.badge').filter({ hasText: '凭证已撤销' }).waitFor();
  assert.equal((await fetch(`${origin}/api/v1/channels/${channelId}/context`,
    { headers: { authorization: `Bearer ${b.token}` } })).status, 401);
  const storage = await page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  assert.ok(storage.local.length === 0 && storage.session.length === 0, 'Browser storage must be empty');
  assert.ok(await page.locator('#connection-text').inputValue() === '', 'One-time connection text must be cleared');
  await page.locator('#logout').click();
  await page.locator('#login').waitFor({ state: 'visible' });
  await page.reload();
  await page.locator('#login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: Chromium login, channel editing, one-time token/copy/clear, safe Markdown, authors/mentions/override, reference history, live updates, network recovery, mobile layout, revocation and logout.');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('close', resolve));
    server.kill('SIGTERM');
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
