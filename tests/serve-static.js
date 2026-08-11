'use strict';

const http = require('node:http');
const { readFileSync, existsSync, statSync } = require('node:fs');
const { extname, join, normalize } = require('node:path');
const { randomUUID } = require('node:crypto');

const root = join(__dirname, '..');
const port = Number(process.env.PORT || 4187);
const fakeSdk = readFileSync(join(__dirname, 'fixtures', 'fake-supabase.js'));

function freshState() {
  return {
    report: { id: '11111111-1111-4111-8111-111111111111', legacyFileId: 'browser-report', title: '瀏覽器協作測試', date: '2026-08-10', period: { startM: '8', startD: '1', endM: '8', endD: '31' }, revision: 1, settings: {} },
    modules: [
      { id: '22222222-2222-4222-8222-222222222221', legacyItemId: '101', sortRank: 1, revision: 1, payload: { id: 101, icon: 'fas fa-edit', iconColor: '#64748b', title: 'A 原始項目', colLayout: '1', colCount: 1, columns: ['A 內容'], attachments: [], selectedForPdf: true, pdfOrder: 1 } },
      { id: '22222222-2222-4222-8222-222222222222', legacyItemId: '102', sortRank: 2, revision: 1, payload: { id: 102, icon: 'fas fa-edit', iconColor: '#64748b', title: 'B 原始項目', colLayout: '1', colCount: 1, columns: ['B 內容'], attachments: [], selectedForPdf: true, pdfOrder: 2 } }
    ],
    records: [],
    users: [
      { id: '33333333-3333-4333-8333-333333333331', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 },
      { id: '33333333-3333-4333-8333-333333333332', username: 'operator', displayName: 'Operator B', role: 'operator', active: true, version: 1 }
    ],
    passwords: { owner: 'owner-pass', operator: 'operator-pass' },
    sitePassword: 'gate-pass',
    siteSessions: new Map(), userSessions: new Map(), leases: new Map(), operations: new Map(), deletedModules: [],
    sequence: 0, events: []
  };
}

let state = freshState();
const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => Date.now();

function userForSession(id) {
  const session = state.userSessions.get(id);
  return session ? state.users.find((user) => user.id === session.userId) : null;
}

function event(entityType, entityId, revision, operationId) {
  const row = { sequence: ++state.sequence, entityType, entityId, revision, operationId, changedAt: new Date().toISOString() };
  state.events.push(row);
  return row;
}

function resultState() {
  return {
    report: state.report,
    modules: state.modules,
    records: state.records,
    deletedModules: state.deletedModules,
    sequence: state.sequence,
    leases: Array.from(state.leases.entries()).map(([key, value]) => ({ key, ...value }))
  };
}

function rpc(name, p) {
  if (name === 'monthly_v7_get_status') return { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 };
  if (name === 'monthly_v7_open_site') {
    if (p.p_password !== state.sitePassword) return { ok: false, error: 'INVALID_CREDENTIALS' };
    const id = randomUUID();
    state.siteSessions.set(id, { clientSessionId: p.p_client_session_id });
    return { ok: true, site_session_id: id, expires_at: new Date(now() + 3600000).toISOString() };
  }
  if (name === 'monthly_v7_login_user') {
    if (!state.siteSessions.has(p.p_site_session_id) || state.passwords[p.p_username] !== p.p_password) return { ok: false, error: 'INVALID_CREDENTIALS' };
    const user = state.users.find((entry) => entry.username === p.p_username);
    const id = randomUUID();
    state.userSessions.set(id, { userId: user.id, clientSessionId: p.p_client_session_id, siteSessionId: p.p_site_session_id });
    return { ok: true, user_session_id: id, user: clone(user) };
  }
  if (name === 'monthly_v7_logout') {
    state.userSessions.delete(p.p_user_session_id);
    state.siteSessions.delete(p.p_site_session_id);
    return { ok: true, revoked: true };
  }
  if (name === 'monthly_v7_get_snapshot') {
    if (!state.siteSessions.has(p.p_site_session_id)) return { ok: false, error: 'SITE_SESSION_INVALID' };
    return { ok: true, workspace: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', authorityState: 'NORMALIZED_ACTIVE', authorityEpoch: 2 }, watermark: state.sequence, report: clone(state.report), modules: clone(state.modules), records: clone(state.records), users: clone(state.users) };
  }
  if (name === 'monthly_v7_claim_lease') {
    const user = userForSession(p.p_user_session_id);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    const key = `${p.p_entity_type}:${p.p_entity_id}`;
    const old = state.leases.get(key);
    if (old && old.expiresAt > now() && old.clientSessionId !== p.p_client_session_id) {
      const holder = state.users.find((entry) => entry.id === old.holderUserId);
      return { ok: false, error: 'LEASE_HELD', holderDisplayName: holder && holder.displayName, expiresAt: new Date(old.expiresAt).toISOString() };
    }
    const fence = old ? old.fencingToken + 1 : 1;
    const lease = { leaseId: randomUUID(), fencingToken: fence, holderUserId: user.id, clientSessionId: p.p_client_session_id, expiresAt: now() + 90000 };
    state.leases.set(key, lease);
    return { ok: true, entity_type: p.p_entity_type, entity_id: p.p_entity_id, lease_id: lease.leaseId, fencing_token: fence, holder_user_id: user.id, client_session_id: lease.clientSessionId, expires_at: new Date(lease.expiresAt).toISOString() };
  }
  if (name === 'monthly_v7_renew_lease' || name === 'monthly_v7_release_lease') {
    const key = `${p.p_entity_type}:${p.p_entity_id}`;
    const lease = state.leases.get(key);
    if (!lease || lease.leaseId !== p.p_lease_id || lease.fencingToken !== Number(p.p_fencing_token) || lease.clientSessionId !== p.p_client_session_id) return { ok: false, error: 'LEASE_LOST' };
    lease.expiresAt = name.includes('release') ? now() - 1 : now() + 90000;
    return { ok: true, entity_type: p.p_entity_type, entity_id: p.p_entity_id, lease_id: lease.leaseId, fencing_token: lease.fencingToken, holder_user_id: lease.holderUserId, client_session_id: lease.clientSessionId, expires_at: new Date(lease.expiresAt).toISOString() };
  }
  if (name === 'monthly_v7_save_module') {
    if (state.operations.has(p.p_operation_id)) return clone(state.operations.get(p.p_operation_id));
    const key = `module:${p.p_module_id}`;
    const lease = state.leases.get(key);
    const module = state.modules.find((entry) => entry.id === p.p_module_id);
    if (!lease || lease.expiresAt <= now() || lease.leaseId !== p.p_lease_id || lease.fencingToken !== Number(p.p_fencing_token) || lease.clientSessionId !== p.p_client_session_id) return { ok: false, error: 'LEASE_LOST' };
    if (!module || module.revision !== Number(p.p_expected_revision)) return { ok: false, error: 'REVISION_CONFLICT', currentRevision: module && module.revision };
    module.payload = clone(p.p_payload);
    module.revision += 1;
    lease.expiresAt = now() - 1;
    event('module', module.id, module.revision, p.p_operation_id);
    const result = { ok: true, entityId: module.id, revision: module.revision, watermark: state.sequence };
    state.operations.set(p.p_operation_id, result);
    return clone(result);
  }
  if (name === 'monthly_v7_delete_module') {
    if (state.operations.has(p.p_operation_id)) return clone(state.operations.get(p.p_operation_id));
    const user = userForSession(p.p_user_session_id);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    const moduleIndex = state.modules.findIndex((entry) => entry.id === p.p_module_id);
    const module = state.modules[moduleIndex];
    const moduleLease = state.leases.get(`module:${p.p_module_id}`);
    const structureLease = state.leases.get(`report_structure:${state.report.id}`);
    const ownsLease = (lease) => lease && lease.expiresAt > now()
      && lease.clientSessionId === p.p_client_session_id
      && lease.holderUserId === user.id;
    if (!ownsLease(moduleLease) || moduleLease.leaseId !== p.p_module_lease_id || moduleLease.fencingToken !== Number(p.p_module_fencing_token)
      || !ownsLease(structureLease) || structureLease.leaseId !== p.p_structure_lease_id || structureLease.fencingToken !== Number(p.p_structure_fencing_token)) {
      return { ok: false, error: 'LEASE_LOST' };
    }
    if (!module || module.revision !== Number(p.p_expected_module_revision)) return { ok: false, error: 'REVISION_CONFLICT', currentRevision: module && module.revision };
    if (state.report.revision !== Number(p.p_expected_report_revision)) return { ok: false, error: 'REPORT_REVISION_CONFLICT', currentRevision: state.report.revision };
    if (state.modules.length <= 1) return { ok: false, error: 'LAST_MODULE_REQUIRED' };
    state.modules.splice(moduleIndex, 1);
    state.deletedModules.push(module.id);
    state.report.revision += 1;
    moduleLease.expiresAt = now() - 1;
    structureLease.expiresAt = now() - 1;
    event('module', module.id, module.revision + 1, p.p_operation_id);
    event('report_structure', state.report.id, state.report.revision, p.p_operation_id);
    const result = { ok: true, entityId: module.id, revision: module.revision + 1, reportRevision: state.report.revision, deleted: true, watermark: state.sequence };
    state.operations.set(p.p_operation_id, result);
    return clone(result);
  }
  if (name === 'monthly_v7_get_changes_since') {
    const events = state.events.filter((row) => row.sequence > Number(p.p_after_sequence || 0));
    return { ok: true, watermark: events.length ? events.at(-1).sequence : Number(p.p_after_sequence || 0), hasMore: false, events: clone(events) };
  }
  if (name === 'monthly_v7_get_entity') {
    const module = state.modules.find((entry) => entry.id === p.p_entity_id);
    if (p.p_entity_type === 'module' && module) return { ok: true, entityType: 'module', entityId: module.id, revision: module.revision, deleted: false, payload: clone(module.payload) };
    return { ok: false, error: 'ENTITY_NOT_FOUND' };
  }
  if (name === 'monthly_v7_save_report_meta') {
    const lease = state.leases.get(`report_meta:${p.p_report_id}`);
    if (!lease || lease.leaseId !== p.p_lease_id) return { ok: false, error: 'LEASE_LOST' };
    if (state.report.revision !== Number(p.p_expected_revision)) return { ok: false, error: 'REVISION_CONFLICT' };
    Object.assign(state.report, { title: p.p_title, date: p.p_report_date, period: clone(p.p_period), settings: clone(p.p_settings), revision: state.report.revision + 1 });
    lease.expiresAt = now() - 1;
    event('report_meta', state.report.id, state.report.revision, p.p_operation_id);
    return { ok: true, revision: state.report.revision, watermark: state.sequence };
  }
  if (name === 'monthly_v7_create_report_snapshot') {
    if (!Object.prototype.hasOwnProperty.call(p, 'p_snapshot_kind') || Object.prototype.hasOwnProperty.call(p, 'p_kind')) {
      const error = new Error('Could not find the function public.monthly_v7_create_report_snapshot with the supplied named arguments');
      error.code = 'PGRST202';
      error.details = 'Searched for monthly_v7_create_report_snapshot with p_kind instead of p_snapshot_kind';
      error.statusCode = 404;
      throw error;
    }
    const snapshot = { report: clone(state.report), modules: clone(state.modules), records: clone(state.records) };
    snapshot.report.title = '正式快照標題';
    if (snapshot.modules[0]) snapshot.modules[0].payload.title = '正式快照模塊';
    return { ok: true, snapshotId: randomUUID(), contentSha256: 'fake-sha256', snapshot };
  }
  return { ok: false, error: `FAKE_RPC_NOT_IMPLEMENTED:${name}` };
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/__fake_reset' && req.method === 'POST') { state = freshState(); res.writeHead(204); return res.end(); }
  if (url.pathname === '/__fake_structure_change' && req.method === 'POST') {
    state.modules.push({
      id: 'm3', legacyItemId: '103', sortRank: 3, revision: 1,
      payload: { id: 103, title: '遠端新增模塊', columns: ['遠端內容'], colLayout: '1', selectedForPdf: true, moduleCategory: 'custom', pdfOrder: 3 }
    });
    state.report.revision += 1;
    event('report_structure', state.report.id, state.report.revision, randomUUID());
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_state') { res.writeHead(200, { 'Content-Type': mime['.json'] }); return res.end(JSON.stringify(resultState())); }
  if (url.pathname === '/__fake_rpc' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { const request = JSON.parse(body || '{}'); const data = rpc(request.name, request.params || {}); res.writeHead(200, { 'Content-Type': mime['.json'] }); res.end(JSON.stringify(data)); }
      catch (error) {
        res.writeHead(Number(error.statusCode) || 500, { 'Content-Type': mime['.json'] });
        res.end(JSON.stringify({ message: error.message, code: error.code || 'FAKE_RPC_ERROR', details: error.details || '' }));
      }
    });
    return;
  }
  if (url.pathname === '/supabase-config.js') {
    res.writeHead(200, { 'Content-Type': mime['.js'] });
    return res.end(`window.MONTHLY_REPORT_SUPABASE_CONFIG={supabaseUrl:${JSON.stringify(`http://${req.headers.host}`)},anonKey:'fake-anon-key',workspaceKey:'browser-workspace'};`);
  }
  if (url.pathname === '/vendor/supabase-2.112.2.js') { res.writeHead(200, { 'Content-Type': mime['.js'] }); return res.end(fakeSdk); }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
server.listen(port, '127.0.0.1', () => console.log(`monthly-v7-test-server http://127.0.0.1:${port}`));
