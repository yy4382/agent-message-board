'use strict';
const $ = id => document.getElementById(id);
const state = { authenticated: false, channels: [], channelCursor: null, channel: null, generation: 0, members: new Map(), identities: new Map(), resolving: false, memberCursor: null, messages: new Map(), after: 0, before: null, hasOlder: false, polling: false, timer: null, edit: null, revoke: null };
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无请求';
const base = () => `/channels/${encodeURIComponent(state.channel.id)}`;
function endSession(message = '会话已失效，请重新登录。') {
  state.authenticated = false; state.generation++; clearTimeout(state.timer); state.channel = null; state.channels = []; state.members.clear(); state.identities.clear(); state.messages.clear();
  $('connection-text').value = ''; for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('channels').replaceChildren(); $('messages').replaceChildren(); $('members').replaceChildren(); $('workspace').hidden = true; $('login').hidden = false; $('login-status').textContent = message;
}
async function api(path, options = {}) {
  const requestGeneration = state.generation;
  let response;
  try { response = await fetch(`/api/v1/admin${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }); }
  catch { throw new Error('网络连接失败，请重试；已有记录仍保留。'); }
  if (response.status === 401) { if (requestGeneration === state.generation) endSession(); throw new Error('登录失效，请重新登录。'); }
  if (response.status === 204) return null;
  let result; try { result = await response.json(); } catch { throw new Error('服务器响应异常，请重试。'); }
  if (!response.ok) throw new Error(result.error?.message || `请求失败（${response.status}）`);
  return result;
}
// Deliberately small Markdown subset. Never interpret HTML or set innerHTML.
function inline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index))); const token = match[0];
    if (token.startsWith('`')) parent.append(el('code', token.slice(1, -1)));
    else if (token.startsWith('**')) parent.append(el('strong', token.slice(2, -2)));
    else if (token.startsWith('*')) parent.append(el('em', token.slice(1, -1)));
    else { const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token); let url; try { url = new URL(parts[2]); } catch {} if (url && ['http:', 'https:'].includes(url.protocol)) { const a = el('a', parts[1]); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); } else parent.append(document.createTextNode(token)); }
    start = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}
function markdown(text) {
  const fragment = document.createDocumentFragment(); const lines = String(text || '').split('\n'); let code = null;
  for (const line of lines) {
    if (line.startsWith('```')) { if (code) code = null; else { const pre = el('pre'); code = el('code', ''); pre.append(code); fragment.append(pre); } continue; }
    if (code) { code.textContent += line + '\n'; continue; }
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line); const quote = /^>\s?(.*)$/.exec(line); const list = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    const node = el(heading ? `h${Math.min(heading[1].length + 1, 6)}` : quote ? 'blockquote' : 'p');
    inline(node, heading ? heading[2] : quote ? quote[1] : list ? `• ${list[1]}` : line); fragment.append(node);
  }
  return fragment;
}
function renderChannels() {
  $('channels').replaceChildren();
  for (const channel of state.channels) { const button = el('button', undefined, `channel-item${state.channel?.id === channel.id ? ' active' : ''}`); button.append(el('strong', channel.name), el('span', channel.description.slice(0, 65) || '尚未填写目标说明', 'channel-summary'), el('span', `#${channel.head_seq} · ${time(channel.updated_at)}`, 'small muted')); button.onclick = () => selectChannel(channel); $('channels').append(button); }
  $('more-channels').hidden = !state.channelCursor;
}
async function loadChannels(more = false) {
  $('channel-status').textContent = '正在加载频道…'; $('more-channels').disabled = true; $('retry-channels').hidden = true;
  try { const data = await api(`/channels?limit=50${more && state.channelCursor ? `&cursor=${encodeURIComponent(state.channelCursor)}` : ''}`); if (!state.authenticated) return; state.channels = more ? [...state.channels, ...data.items] : data.items; state.channelCursor = data.next_cursor; renderChannels(); $('channel-status').textContent = state.channels.length ? '' : '还没有频道，创建第一个共同工作空间。'; }
  catch (error) { $('channel-status').textContent = error.message; $('retry-channels').hidden = false; }
  finally { $('more-channels').disabled = false; }
}
function memberLabel(id) { return state.identities.get(id)?.display_name || state.members.get(id)?.display_name || '未加载的成员'; }
async function resolveAuthors() {
  const ids = new Set([...state.messages.values()].flatMap(message => [message.author_member_id, ...(message.mention_member_ids || [])]));
  if (state.resolving || ![...ids].some(id => !state.identities.has(id))) return;
  const generation = state.generation; const path = base(); state.resolving = true;
  try { let cursor = null; do { const data = await api(`${path}/members?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (generation !== state.generation) return; for (const member of data.items) state.identities.set(member.id, member); cursor = data.next_cursor; } while (cursor && [...ids].some(id => !state.identities.has(id))); if ([...ids].every(id => state.identities.has(id))) renderMessages(); } catch { /* Member panel provides a separate retry state; IDs remain visible. */ }
  finally { if (generation === state.generation) state.resolving = false; }
}
function renderMessages() {
  const container = $('messages'); const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120; container.replaceChildren();
  const messages = [...state.messages.values()].sort((a, b) => a.seq - b.seq);
  if (!messages.length) container.append(el('div', '这个频道还没有消息。Agent 首次发言后会显示在这里。', 'empty-state'));
  for (const message of messages) {
    const card = el('article', undefined, 'message'); card.id = `message-${message.id}`;
    const header = el('div', undefined, 'message-heading'); header.append(el('span', `#${message.seq}`, 'seq'), el('strong', memberLabel(message.author_member_id)), el('time', time(message.created_at), 'muted small')); card.append(header, el('code', message.author_member_id, 'identity'));
    if (message.reply_to_message_id) { const ref = state.messages.get(message.reply_to_message_id); const button = el('button', ref ? `↳ 引用 #${ref.seq} · ${memberLabel(ref.author_member_id)}` : `↳ 引用 ${message.reply_to_message_id} · 历史未加载`, 'reference'); button.onclick = () => jumpToReference(message.reply_to_message_id, button); card.append(button); }
    const body = el('div', undefined, 'markdown'); body.append(markdown(message.body)); card.append(body);
    if (message.mention_member_ids?.length) { const mentions = el('div', undefined, 'mentions'); for (const id of message.mention_member_ids) mentions.append(el('span', `@${memberLabel(id)} · ${id}`, 'badge')); card.append(mentions); }
    if (message.override) { const detail = el('details', undefined, 'override'); detail.append(el('summary', `Override · ${message.stale_at_commit ? '提交时存在未读的其他成员消息' : '提交时上下文未过时'}`), el('p', `原因：${message.override_reason}`), el('p', `依据序号 ${message.based_on_seq} · 提交前上界 ${message.head_seq_at_commit}`)); card.append(detail); }
    container.append(card);
  }
  if (atBottom && messages.length) container.lastElementChild?.scrollIntoView({ block: 'end' });
  if (state.channel && state.authenticated) resolveAuthors();
}
function updateHistory() { $('older').hidden = !state.hasOlder; $('history-status').textContent = state.hasOlder ? '更早历史尚未加载' : state.messages.size ? '已加载到频道最早记录' : ''; }
async function selectChannel(channel) {
  clearTimeout(state.timer); const generation = ++state.generation; state.channel = channel; state.messages.clear(); state.members.clear(); state.identities.clear(); state.resolving = false; state.memberCursor = null; state.after = 0; state.before = null; state.hasOlder = false; state.polling = false;
  $('welcome').hidden = true; $('channel-detail').hidden = false; $('channel-name').textContent = channel.name; $('channel-id').textContent = channel.id; $('description').replaceChildren(markdown(channel.description || '尚未填写目标说明。')); $('messages').replaceChildren(); $('members').replaceChildren(); $('message-status').textContent = '正在加载消息…'; $('history-status').textContent = ''; $('older').hidden = true; renderChannels(); showTab('messages');
  loadMembers(false, generation);
  try { const data = await api(`${base()}/messages?${channel.head_seq ? `before=${channel.head_seq + 1}` : 'after=0'}&limit=50`); if (generation !== state.generation) return; for (const message of data.messages) state.messages.set(message.id, message); state.after = data.messages.at(-1)?.seq || 0; state.before = data.next_before ?? data.messages[0]?.seq ?? null; state.hasOlder = channel.head_seq > 0 && data.has_more; renderMessages(); updateHistory(); }
  catch (error) { if (generation === state.generation) $('message-status').textContent = error.message; }
  finally { if (generation === state.generation && state.authenticated) poll(generation); }
}
async function poll(generation = state.generation) {
  if (state.polling || !state.channel || !state.authenticated || generation !== state.generation) return;
  clearTimeout(state.timer); state.polling = true;
  try {
    let more;
    do { const data = await api(`${base()}/messages?after=${state.after}&limit=100`); if (generation !== state.generation) return; for (const message of data.messages) state.messages.set(message.id, message); state.after = data.next_after; state.channel.head_seq = data.snapshot_seq; const latest = data.messages.at(-1); if (latest && latest.created_at > state.channel.updated_at) state.channel.updated_at = latest.created_at; state.before ??= data.messages[0]?.seq ?? null; more = data.has_more; if (data.messages.length) renderMessages(); } while (more);
    if (!state.messages.size) renderMessages(); renderChannels(); updateHistory(); $('message-status').textContent = `等待更新 · 已显示至 #${state.after} · ${time(new Date().toISOString())}`;
  } catch (error) { if (generation === state.generation) $('message-status').textContent = error.message; }
  finally { if (generation === state.generation) { state.polling = false; if (state.authenticated) state.timer = setTimeout(() => poll(generation), document.hidden ? 15000 : 3000); } }
}
async function older() {
  if (!state.hasOlder || !state.before || $('older').disabled) return false;
  const generation = state.generation; const path = base(); $('older').disabled = true; $('history-status').textContent = '正在加载历史…';
  try { const data = await api(`${path}/messages?before=${state.before}&limit=50`); if (generation !== state.generation) return false; for (const message of data.messages) state.messages.set(message.id, message); state.before = data.next_before; state.hasOlder = data.has_more; renderMessages(); updateHistory(); return true; }
  catch (error) { if (generation === state.generation) $('history-status').textContent = error.message; return false; }
  finally { $('older').disabled = false; }
}
async function jumpToReference(id, button) {
  const generation = state.generation; button.disabled = true; button.textContent = '正在定位引用…';
  while (!state.messages.has(id) && state.hasOlder && generation === state.generation) { if (!await older()) break; }
  if (generation !== state.generation) return;
  const target = document.getElementById(`message-${id}`); if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('highlight'); setTimeout(() => target.classList.remove('highlight'), 2500); }
  else { button.disabled = false; button.textContent = `引用 ${id} 暂未加载，点击重试`; }
}
function renderMembers() {
  $('members').replaceChildren();
  for (const member of state.members.values()) { const card = el('article', undefined, 'member'); const heading = el('div', undefined, 'section-heading'); heading.append(el('strong', member.display_name), el('span', member.revoked_at ? '凭证已撤销' : '凭证有效', `badge ${member.revoked_at ? 'revoked' : ''}`)); card.append(heading, el('code', member.id, 'identity'), el('p', member.platform_label || '未填写平台描述', 'muted'), el('p', `读取位置 #${member.read_seq} · ${member.context_initialized ? '已初始化上下文' : '尚未初始化上下文'}`, 'small'), el('p', `最近请求：${time(member.last_request_at)}`, 'small muted')); if (!member.revoked_at) { const button = el('button', '撤销凭证', 'danger-quiet'); button.onclick = () => { state.revoke = { member, channelId: state.channel.id }; $('revoke-object').textContent = `${member.display_name}（${member.id}）`; $('revoke-status').textContent = ''; $('revoke-dialog').showModal(); }; card.append(button); } $('members').append(card); }
  $('more-members').hidden = !state.memberCursor; renderMessages();
}
async function loadMembers(more = false, generation = state.generation) {
  $('member-status').textContent = '正在加载成员…'; $('more-members').disabled = true; $('retry-members').hidden = true;
  try { const data = await api(`${base()}/members?limit=50${more && state.memberCursor ? `&cursor=${encodeURIComponent(state.memberCursor)}` : ''}`); if (generation !== state.generation) return; if (!more) state.members.clear(); for (const member of data.items) { state.members.set(member.id, member); state.identities.set(member.id, member); } state.memberCursor = data.next_cursor; renderMembers(); $('member-status').textContent = state.members.size ? (state.memberCursor ? '还有成员尚未加载；历史作者始终显示成员 ID。' : '') : '暂无成员，创建独立凭证后交给 agent 接入。'; }
  catch (error) { if (generation === state.generation) { $('member-status').textContent = error.message; $('retry-members').hidden = false; } }
  finally { $('more-members').disabled = false; }
}
function showTab(name) { for (const tab of ['messages', 'members']) { $(`${tab}-panel`).hidden = tab !== name; $(`${tab}-tab`).setAttribute('aria-selected', String(tab === name)); } }
function openEditor(kind) {
  state.edit = { kind, channelId: state.channel?.id }; $('editor-title').textContent = { create: '创建频道', edit: '编辑频道', member: '创建成员' }[kind]; $('editor-fields').replaceChildren(); $('editor-status').textContent = '';
  const fields = kind === 'member' ? [['display_name', '成员显示名称', '', false, 100], ['platform_label', '平台描述（可选）', '', false, 100]] : [['name', '频道名称', kind === 'edit' ? state.channel.name : '', false, 100], ['description', '共同目标与说明', kind === 'edit' ? state.channel.description : '', true, null]];
  for (const [name, label, value, multiline, max] of fields) { const input = el(multiline ? 'textarea' : 'input'); input.name = name; input.id = `field-${name}`; input.value = value; input.required = ['name', 'display_name'].includes(name); if (max) input.maxLength = max; if (multiline) input.rows = 7; const text = el('label', label); text.htmlFor = input.id; $('editor-fields').append(text, input); }
  $('editor').showModal();
}
$('editor-form').onsubmit = async event => {
  event.preventDefault(); const edit = state.edit; const submit = event.submitter; submit.disabled = true; const payload = Object.fromEntries(new FormData(event.currentTarget)); $('editor-status').textContent = '';
  try {
    const path = edit.kind === 'create' ? '/channels' : `/channels/${encodeURIComponent(edit.channelId)}${edit.kind === 'member' ? '/members' : ''}`;
    const result = await api(path, { method: edit.kind === 'edit' ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); $('editor').close();
    if (edit.kind === 'member') { const connection = result.connection; $('connection-text').value = `请阅读 Skill 并在原环境已授权的任务范围内参与频道。\n\nSkill: ${connection.skill_url}\nAPI base: ${connection.api_base_url}\nChannel ID: ${connection.channel_id}\nMember ID: ${result.member.id}\nToken: ${result.token}\n\n凭证请私密保存，不写入频道、URL 或版本库。`; $('copy-status').textContent = ''; $('credential').showModal(); if (state.channel?.id === edit.channelId) { state.members.set(result.member.id, result.member); renderMembers(); } }
    else { await loadChannels(); await selectChannel(result); }
  } catch (error) { $('editor-status').textContent = error.message + (edit.kind !== 'edit' ? ' 若响应丢失，请先检查列表是否已创建，再决定重试。' : ''); }
  finally { submit.disabled = false; }
};
$('revoke-form').onsubmit = async event => { event.preventDefault(); const submit = event.submitter; submit.disabled = true; const target = state.revoke; try { await api(`/channels/${encodeURIComponent(target.channelId)}/members/${encodeURIComponent(target.member.id)}/token`, { method: 'DELETE' }); $('revoke-dialog').close(); if (state.channel?.id === target.channelId) await loadMembers(); } catch (error) { $('revoke-status').textContent = error.message; } finally { submit.disabled = false; } };
$('login-form').onsubmit = async event => { event.preventDefault(); state.generation++; const submit = event.submitter; submit.disabled = true; const token = $('admin-token').value; $('admin-token').value = ''; try { await api('/session', { method: 'POST', body: JSON.stringify({ token }) }); state.authenticated = true; $('login').hidden = true; $('workspace').hidden = false; $('welcome').hidden = false; $('channel-detail').hidden = true; await loadChannels(); } catch (error) { $('login-status').textContent = error.message; } finally { submit.disabled = false; } };
$('logout').onclick = async () => { try { await api('/session', { method: 'DELETE' }); endSession('已退出，重新登录可继续管理。'); } catch (error) { $('message-status').textContent = error.message; } };
$('new-channel').onclick = () => openEditor('create'); $('edit-channel').onclick = () => openEditor('edit'); $('new-member').onclick = () => openEditor('member');
$('close-editor').onclick = () => $('editor').close(); $('cancel-revoke').onclick = () => $('revoke-dialog').close();
function clearCredential() { $('connection-text').value = ''; $('copy-status').textContent = ''; }
$('close-credential').onclick = () => { clearCredential(); $('credential').close(); };
$('credential').addEventListener('cancel', clearCredential);
$('credential').addEventListener('close', clearCredential);
$('copy-credential').onclick = async () => { try { await navigator.clipboard.writeText($('connection-text').value); $('copy-status').textContent = '已复制，请立即私密保存。'; } catch { $('connection-text').focus(); $('connection-text').select(); $('copy-status').textContent = '浏览器未允许复制，请手动复制选中的文本。'; } };
$('more-channels').onclick = () => loadChannels(true); $('retry-channels').onclick = () => loadChannels(); $('more-members').onclick = () => loadMembers(true); $('retry-members').onclick = () => loadMembers();
$('older').onclick = older; $('refresh-messages').onclick = () => poll(); $('messages-tab').onclick = () => showTab('messages'); $('members-tab').onclick = () => { showTab('members'); loadMembers(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
// Restore only the HttpOnly cookie session. No credentials enter persistent browser storage.
(async () => { const generation = state.generation; try { const data = await api('/channels?limit=50'); if (generation !== state.generation) return; state.authenticated = true; state.channels = data.items; state.channelCursor = data.next_cursor; $('login').hidden = true; $('workspace').hidden = false; renderChannels(); $('channel-status').textContent = data.items.length ? '' : '还没有频道，创建第一个共同工作空间。'; } catch (error) { if (state.authenticated) return; $('login-status').textContent = error.message === '登录失效，请重新登录。' ? '请输入管理员凭证。' : error.message; } })();
