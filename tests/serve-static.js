'use strict';

const http = require('node:http');
const { readFileSync, existsSync, statSync } = require('node:fs');
const { extname, join, normalize } = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');

const root = join(__dirname, '..');
const port = Number(process.env.PORT || 4187);
const fakeSdk = readFileSync(join(__dirname, 'fixtures', 'fake-supabase.js'));

function freshState() {
  const initialModuleUpdatedAt = '2026-08-10T00:00:00.000Z';
  return {
    statusResponse: { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 },
    statusFailure: null,
    rpcCounts: new Map(),
    report: { id: '11111111-1111-4111-8111-111111111111', legacyFileId: 'browser-report', title: '瀏覽器協作測試', date: '2026-08-10', period: { startM: '8', startD: '1', endM: '8', endD: '31' }, revision: 1, settings: {} },
    modules: [
      { id: '22222222-2222-4222-8222-222222222221', legacyItemId: '101', sortRank: 1, revision: 1, updatedAt: initialModuleUpdatedAt, payload: { id: 101, icon: 'fas fa-edit', iconColor: '#64748b', title: 'A 原始項目', colLayout: '1', colCount: 1, columns: ['A 內容'], attachments: [], selectedForPdf: true, pdfOrder: 1 } },
      { id: '22222222-2222-4222-8222-222222222222', legacyItemId: '102', sortRank: 2, revision: 1, updatedAt: initialModuleUpdatedAt, payload: { id: 102, icon: 'fas fa-edit', iconColor: '#64748b', title: 'B 原始項目', colLayout: '1', colCount: 1, columns: ['B 內容'], attachments: [], selectedForPdf: true, pdfOrder: 2 } }
    ],
    records: [],
    users: [
      { id: '33333333-3333-4333-8333-333333333331', username: 'owner', displayName: 'Owner A', role: 'owner', active: true, version: 1 },
      { id: '33333333-3333-4333-8333-333333333332', username: 'operator', displayName: 'Operator B', role: 'operator', active: true, version: 1 }
    ],
    passwords: { owner: 'owner-pass', operator: 'operator-pass' },
    sitePassword: 'gate-pass',
    siteSessions: new Map(), userSessions: new Map(), trustedDevices: new Map(), resumeTokens: new Map(),
    leases: new Map(), operations: new Map(), deletedModules: [], snapshots: [],
    hangRpcCounts: new Map(), hangAfterCommitCounts: new Map(),
    sequence: 0, events: []
  };
}

let state = freshState();
const clone = (value) => JSON.parse(JSON.stringify(value));
const now = () => Date.now();
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function userForSession(id) {
  const session = state.userSessions.get(id);
  return session ? state.users.find((user) => user.id === session.userId) : null;
}

function event(entityType, entityId, revision) {
  // Match the production monthly_v7_get_changes_since contract: change hints
  // deliberately expose no actor or operation identity.
  const row = { sequence: ++state.sequence, entityType, entityId, revision, changedAt: new Date().toISOString() };
  state.events.push(row);
  return row;
}

function replayOperation(operationId, actorUserId, requestHash) {
  const existing = state.operations.get(operationId);
  if (!existing) return null;
  if (existing.actorUserId !== actorUserId || existing.requestHash !== requestHash) return { ok: false, error: 'IDEMPOTENCY_MISMATCH' };
  return clone(existing.result);
}

function storeOperation(operationId, actorUserId, requestHash, result) {
  state.operations.set(operationId, { actorUserId, requestHash, result: clone(result) });
  return clone(result);
}

function resultState() {
  return {
    rpcCounts: Object.fromEntries(state.rpcCounts.entries()),
    report: state.report,
    modules: state.modules,
    records: state.records,
    deletedModules: state.deletedModules,
    sequence: state.sequence,
    snapshots: state.snapshots,
    operations: Array.from(state.operations.entries()).map(([operationId, operation]) => ({
      operationId,
      actorUserId: operation.actorUserId || '',
      requestHash: operation.requestHash || '',
      result: operation.result || operation
    })),
    leases: Array.from(state.leases.entries()).map(([key, value]) => ({ key, ...value })),
    trustedDeviceCount: state.trustedDevices.size,
    activeTrustedDeviceCount: Array.from(state.trustedDevices.values())
      .filter((device) => !device.revoked && device.expiresAt > now()).length,
    activeSiteResumeCount: Array.from(state.resumeTokens.values())
      .filter((token) => token.purpose === 'site' && !token.consumed && !token.revoked && token.expiresAt > now()).length,
    activeUserResumeCount: Array.from(state.resumeTokens.values())
      .filter((token) => token.purpose === 'user' && !token.consumed && !token.revoked && token.expiresAt > now()).length
  };
}

function rpc(name, p) {
  state.rpcCounts.set(name, Number(state.rpcCounts.get(name) || 0) + 1);
  if (name === 'monthly_v7_get_status') {
    if (state.statusFailure) {
      const error = new Error(state.statusFailure.message || 'STATUS_UNAVAILABLE');
      error.code = state.statusFailure.code || 'STATUS_UNAVAILABLE';
      throw error;
    }
    return clone(state.statusResponse);
  }
  if (name === 'monthly_v7_open_site') {
    if (p.p_password !== state.sitePassword) return { ok: false, error: 'INVALID_CREDENTIALS' };
    const id = randomUUID();
    state.siteSessions.set(id, { clientSessionId: p.p_client_session_id });
    return { ok: true, site_session_id: id, expires_at: new Date(now() + 3600000).toISOString() };
  }
  if (name === 'monthly_v7_issue_site_resume') {
    const session = state.siteSessions.get(p.p_site_session_id);
    if (!session || session.clientSessionId !== p.p_client_session_id) {
      return { ok: false, error: 'SITE_SESSION_INVALID' };
    }
    let deviceId = session.trustedDeviceId;
    if (!deviceId || !state.trustedDevices.has(deviceId)) {
      deviceId = randomUUID();
      state.trustedDevices.set(deviceId, { expiresAt: now() + 12 * 60 * 60 * 1000, revoked: false });
      session.trustedDeviceId = deviceId;
    }
    for (const token of state.resumeTokens.values()) {
      if (token.deviceId === deviceId && token.purpose === 'site' && !token.consumed) token.revoked = true;
    }
    const rawToken = randomBytes(32).toString('hex');
    const expiresAt = state.trustedDevices.get(deviceId).expiresAt;
    state.resumeTokens.set(rawToken, { deviceId, purpose: 'site', expiresAt, consumed: false, revoked: false });
    return {
      ok: true,
      trusted_device_id: deviceId,
      resume_token: rawToken,
      expires_at: new Date(expiresAt).toISOString(),
      authority_epoch: 2,
      site_policy_generation: 1
    };
  }
  if (name === 'monthly_v7_exchange_site_resume') {
    const token = state.resumeTokens.get(p.p_resume_token);
    const device = token && state.trustedDevices.get(token.deviceId);
    if (!token || token.purpose !== 'site' || token.consumed || token.revoked
      || token.expiresAt <= now() || !device || device.revoked || device.expiresAt <= now()) {
      return { ok: false, error: 'SITE_RESUME_INVALID' };
    }
    token.consumed = true;
    const replacement = randomBytes(32).toString('hex');
    state.resumeTokens.set(replacement, {
      deviceId: token.deviceId, purpose: 'site', expiresAt: device.expiresAt, consumed: false, revoked: false
    });
    const siteSessionId = randomUUID();
    state.siteSessions.set(siteSessionId, {
      clientSessionId: p.p_client_session_id,
      trustedDeviceId: token.deviceId
    });
    return {
      ok: true,
      site_session_id: siteSessionId,
      trusted_device_id: token.deviceId,
      resume_token: replacement,
      expires_at: new Date(device.expiresAt).toISOString(),
      authority_state: 'NORMALIZED_ACTIVE',
      authority_epoch: 2,
      minimum_client_version: 7
    };
  }
  if (name === 'monthly_v7_forget_trusted_device') {
    const siteSession = state.siteSessions.get(p.p_site_session_id);
    const deviceId = siteSession && siteSession.clientSessionId === p.p_client_session_id
      ? siteSession.trustedDeviceId
      : '';
    const device = deviceId && state.trustedDevices.get(deviceId);
    if (!device) return { ok: false, error: 'TRUSTED_DEVICE_NOT_FOUND' };
    device.revoked = true;
    for (const token of state.resumeTokens.values()) {
      if (token.deviceId === deviceId) token.revoked = true;
    }
    const revokedSiteIds = new Set();
    for (const [siteSessionId, session] of state.siteSessions.entries()) {
      if (session.trustedDeviceId === deviceId) {
        revokedSiteIds.add(siteSessionId);
        state.siteSessions.delete(siteSessionId);
      }
    }
    for (const [userSessionId, session] of state.userSessions.entries()) {
      if (revokedSiteIds.has(session.siteSessionId)) state.userSessions.delete(userSessionId);
    }
    return { ok: true, forgotten: true, trusted_device_id: deviceId };
  }
  if (name === 'monthly_v7_login_user') {
    if (!state.siteSessions.has(p.p_site_session_id) || state.passwords[p.p_username] !== p.p_password) return { ok: false, error: 'INVALID_CREDENTIALS' };
    const user = state.users.find((entry) => entry.username === p.p_username);
    const id = randomUUID();
    state.userSessions.set(id, {
      userId: user.id,
      userVersion: user.version,
      clientSessionId: p.p_client_session_id,
      siteSessionId: p.p_site_session_id
    });
    return { ok: true, user_session_id: id, user: clone(user) };
  }
  if (name === 'monthly_v7_issue_user_resume') {
    const siteSession = state.siteSessions.get(p.p_site_session_id);
    const userSession = state.userSessions.get(p.p_user_session_id);
    if (!siteSession || siteSession.clientSessionId !== p.p_client_session_id) {
      return { ok: false, error: 'SITE_SESSION_INVALID' };
    }
    if (!siteSession.trustedDeviceId) return { ok: false, error: 'TRUSTED_DEVICE_REQUIRED' };
    if (!userSession || userSession.siteSessionId !== p.p_site_session_id
      || userSession.clientSessionId !== p.p_client_session_id) {
      return { ok: false, error: 'USER_SESSION_INVALID' };
    }
    const user = state.users.find((entry) => entry.id === userSession.userId
      && entry.active !== false && entry.version === userSession.userVersion);
    const device = state.trustedDevices.get(siteSession.trustedDeviceId);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    if (!device || device.revoked || device.expiresAt <= now()) return { ok: false, error: 'TRUSTED_DEVICE_REQUIRED' };
    for (const token of state.resumeTokens.values()) {
      if (token.deviceId === siteSession.trustedDeviceId && token.purpose === 'user' && !token.consumed) token.revoked = true;
    }
    const rawToken = randomBytes(32).toString('hex');
    const expiresAt = Math.min(device.expiresAt, now() + 12 * 60 * 60 * 1000);
    state.resumeTokens.set(rawToken, {
      deviceId: siteSession.trustedDeviceId,
      purpose: 'user',
      userId: user.id,
      userVersion: user.version,
      userRole: user.role,
      expiresAt,
      consumed: false,
      revoked: false
    });
    return {
      ok: true,
      trusted_device_id: siteSession.trustedDeviceId,
      resume_token: rawToken,
      expires_at: new Date(expiresAt).toISOString(),
      user: clone(user)
    };
  }
  if (name === 'monthly_v7_exchange_user_resume') {
    const siteSession = state.siteSessions.get(p.p_site_session_id);
    const token = state.resumeTokens.get(p.p_resume_token);
    const device = siteSession && siteSession.trustedDeviceId
      ? state.trustedDevices.get(siteSession.trustedDeviceId)
      : null;
    const user = token && state.users.find((entry) => entry.id === token.userId
      && entry.active !== false && entry.version === token.userVersion && entry.role === token.userRole);
    if (!siteSession || siteSession.clientSessionId !== p.p_client_session_id
      || !token || token.purpose !== 'user' || token.deviceId !== siteSession.trustedDeviceId
      || token.consumed || token.revoked || token.expiresAt <= now()
      || !device || device.revoked || device.expiresAt <= now() || !user) {
      return { ok: false, error: 'USER_RESUME_INVALID' };
    }
    token.consumed = true;
    const replacement = randomBytes(32).toString('hex');
    const expiresAt = Math.min(device.expiresAt, now() + 12 * 60 * 60 * 1000);
    state.resumeTokens.set(replacement, {
      deviceId: token.deviceId,
      purpose: 'user',
      userId: user.id,
      userVersion: user.version,
      userRole: user.role,
      expiresAt,
      consumed: false,
      revoked: false
    });
    const userSessionId = randomUUID();
    state.userSessions.set(userSessionId, {
      userId: user.id,
      userVersion: user.version,
      clientSessionId: p.p_client_session_id,
      siteSessionId: p.p_site_session_id
    });
    return {
      ok: true,
      user_session_id: userSessionId,
      trusted_device_id: token.deviceId,
      resume_token: replacement,
      expires_at: new Date(expiresAt).toISOString(),
      user: clone(user)
    };
  }
  if (name === 'monthly_v7_logout_user') {
    const session = state.userSessions.get(p.p_user_session_id);
    const belongsToSite = session && session.siteSessionId === p.p_site_session_id;
    if (belongsToSite) {
      const siteSession = state.siteSessions.get(p.p_site_session_id);
      for (const token of state.resumeTokens.values()) {
        if (token.purpose === 'user' && token.userId === session.userId
          && token.deviceId === siteSession?.trustedDeviceId && !token.consumed) token.revoked = true;
      }
      state.userSessions.delete(p.p_user_session_id);
    }
    return { ok: true, revoked: Boolean(belongsToSite) };
  }
  if (name === 'monthly_v7_logout') {
    const siteSession = state.siteSessions.get(p.p_site_session_id);
    const deviceId = siteSession && siteSession.trustedDeviceId;
    if (deviceId && state.trustedDevices.has(deviceId)) {
      state.trustedDevices.get(deviceId).revoked = true;
      for (const token of state.resumeTokens.values()) {
        if (token.deviceId === deviceId) token.revoked = true;
      }
      const revokedSiteIds = new Set();
      for (const [siteSessionId, session] of state.siteSessions.entries()) {
        if (session.trustedDeviceId === deviceId) {
          revokedSiteIds.add(siteSessionId);
          state.siteSessions.delete(siteSessionId);
        }
      }
      for (const [userSessionId, session] of state.userSessions.entries()) {
        if (revokedSiteIds.has(session.siteSessionId)) state.userSessions.delete(userSessionId);
      }
      return { ok: true, revoked: true, trustedDeviceRevoked: true };
    }
    state.userSessions.delete(p.p_user_session_id);
    state.siteSessions.delete(p.p_site_session_id);
    return { ok: true, revoked: true, trustedDeviceRevoked: false };
  }
  if (name === 'monthly_v7_update_site_password') {
    const session = state.userSessions.get(p.p_user_session_id);
    const actor = session && session.clientSessionId === p.p_client_session_id
      ? state.users.find((entry) => entry.id === session.userId)
      : null;
    if (!actor) return { ok: false, error: 'USER_SESSION_INVALID' };
    if (!['owner', 'admin'].includes(actor.role)) return { ok: false, error: 'FORBIDDEN' };
    if (String(p.p_new_password || '').length < 8) return { ok: false, error: 'INVALID_PAYLOAD' };
    const requestHash = sha256(canonical({
      command: 'update_site_password',
      password_digest: sha256(p.p_new_password)
    }));
    const replay = replayOperation(p.p_operation_id, actor.id, requestHash);
    if (replay) return replay;

    state.sitePassword = String(p.p_new_password);
    for (const device of state.trustedDevices.values()) device.revoked = true;
    for (const token of state.resumeTokens.values()) token.revoked = true;
    state.siteSessions.clear();
    state.userSessions.clear();
    const result = {
      ok: true,
      entityType: 'site_policy',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generation: 2,
      requiresReauth: true,
      operationId: p.p_operation_id
    };
    return storeOperation(p.p_operation_id, actor.id, requestHash, result);
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
    const user = userForSession(p.p_user_session_id);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    const requestHash = canonical({
      command: 'save_module', entityId: p.p_module_id, expectedRevision: Number(p.p_expected_revision),
      leaseId: p.p_lease_id, fencingToken: Number(p.p_fencing_token), payload: p.p_payload
    });
    const key = `module:${p.p_module_id}`;
    const replay = replayOperation(p.p_operation_id, user.id, requestHash);
    if (replay) {
      const replayLease = state.leases.get(key);
      if (replay.ok === true && replayLease
        && replayLease.leaseId === p.p_lease_id
        && replayLease.fencingToken === Number(p.p_fencing_token)
        && replayLease.clientSessionId === p.p_client_session_id
        && replayLease.holderUserId === user.id) {
        replayLease.expiresAt = now() + 90000;
      }
      return replay;
    }
    const lease = state.leases.get(key);
    const module = state.modules.find((entry) => entry.id === p.p_module_id);
    if (!lease || lease.expiresAt <= now() || lease.leaseId !== p.p_lease_id || lease.fencingToken !== Number(p.p_fencing_token)
      || lease.clientSessionId !== p.p_client_session_id || lease.holderUserId !== user.id) {
      return storeOperation(p.p_operation_id, user.id, requestHash, { ok: false, error: 'LEASE_LOST' });
    }
    if (!module || module.revision !== Number(p.p_expected_revision)) {
      return storeOperation(p.p_operation_id, user.id, requestHash, { ok: false, error: 'REVISION_CONFLICT', currentRevision: module && module.revision });
    }
    module.payload = clone(p.p_payload);
    module.revision += 1;
    module.updatedAt = new Date().toISOString();
    lease.expiresAt = now() + 90000;
    event('module', module.id, module.revision, p.p_operation_id);
    const result = { ok: true, entityId: module.id, revision: module.revision };
    return storeOperation(p.p_operation_id, user.id, requestHash, result);
  }
  if (name === 'monthly_v7_create_module') {
    const user = userForSession(p.p_user_session_id);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    const key = `report_structure:${state.report.id}`;
    const lease = state.leases.get(key);
    if (!lease || lease.expiresAt <= now() || lease.leaseId !== p.p_lease_id
      || lease.fencingToken !== Number(p.p_fencing_token)
      || lease.clientSessionId !== p.p_client_session_id || lease.holderUserId !== user.id) {
      return { ok: false, error: 'LEASE_LOST' };
    }
    if (state.report.id !== p.p_report_id || state.report.revision !== Number(p.p_expected_report_revision)) {
      return { ok: false, error: 'REVISION_CONFLICT', currentRevision: state.report.revision };
    }
    const id = randomUUID();
    const module = {
      id,
      legacyItemId: `v7:${id}`,
      sortRank: state.modules.length + 1,
      revision: 1,
      updatedAt: new Date().toISOString(),
      payload: clone(p.p_payload)
    };
    state.modules.push(module);
    state.report.revision += 1;
    lease.expiresAt = now() - 1;
    event('module', id, 1, p.p_operation_id);
    event('report_structure', state.report.id, state.report.revision, p.p_operation_id);
    return {
      ok: true, entityType: 'module', entityId: id, revision: 1,
      reportRevision: state.report.revision, sortRank: module.sortRank,
      operationId: p.p_operation_id, watermark: state.sequence
    };
  }
  if (name === 'monthly_v7_save_module_batch') {
    const user = userForSession(p.p_user_session_id);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    const lease = state.leases.get(`kpi_batch:${state.report.id}`);
    if (!lease || lease.expiresAt <= now() || lease.leaseId !== p.p_lease_id
      || lease.fencingToken !== Number(p.p_fencing_token)
      || lease.clientSessionId !== p.p_client_session_id || lease.holderUserId !== user.id) {
      return { ok: false, error: 'LEASE_LOST' };
    }
    const changes = Array.isArray(p.p_changes) ? p.p_changes : [];
    if (!changes.length) return { ok: false, error: 'INVALID_PAYLOAD' };
    for (const change of changes) {
      const module = state.modules.find((entry) => entry.id === change.moduleId);
      if (!module) return { ok: false, error: 'ENTITY_NOT_FOUND' };
      if (module.revision !== Number(change.expectedRevision)) {
        return { ok: false, error: 'REVISION_CONFLICT', entityId: module.id, currentRevision: module.revision };
      }
    }
    const updated = [];
    for (const change of changes) {
      const module = state.modules.find((entry) => entry.id === change.moduleId);
      module.payload = clone(change.payload);
      module.revision += 1;
      module.updatedAt = new Date().toISOString();
      updated.push({ entityId: module.id, revision: module.revision });
      event('module', module.id, module.revision, p.p_operation_id);
    }
    lease.expiresAt = now() + 90000;
    return { ok: true, updated, operationId: p.p_operation_id };
  }
  if (name === 'monthly_v7_reorder_modules') {
    const user = userForSession(p.p_user_session_id);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    if (Object.prototype.hasOwnProperty.call(p, 'p_order') || !Array.isArray(p.p_module_order)) {
      const error = new Error('Could not find the function public.monthly_v7_reorder_modules with the supplied named arguments');
      error.code = 'PGRST202';
      throw error;
    }
    const lease = state.leases.get(`report_structure:${state.report.id}`);
    if (!lease || lease.expiresAt <= now() || lease.leaseId !== p.p_lease_id
      || lease.fencingToken !== Number(p.p_fencing_token)
      || lease.clientSessionId !== p.p_client_session_id || lease.holderUserId !== user.id) {
      return { ok: false, error: 'LEASE_LOST' };
    }
    if (state.report.id !== p.p_report_id || state.report.revision !== Number(p.p_expected_report_revision)) {
      return { ok: false, error: 'REVISION_CONFLICT', currentRevision: state.report.revision };
    }
    const expected = new Set(state.modules.map((entry) => entry.id));
    if (p.p_module_order.length !== expected.size
      || new Set(p.p_module_order).size !== expected.size
      || p.p_module_order.some((id) => !expected.has(id))) {
      return { ok: false, error: 'ORDER_MUST_INCLUDE_ALL_MODULES' };
    }
    const byId = new Map(state.modules.map((entry) => [entry.id, entry]));
    state.modules = p.p_module_order.map((id, index) => Object.assign(byId.get(id), { sortRank: index + 1 }));
    state.report.revision += 1;
    lease.expiresAt = now() - 1;
    event('report_structure', state.report.id, state.report.revision, p.p_operation_id);
    return {
      ok: true, entityType: 'report_structure', entityId: state.report.id,
      reportRevision: state.report.revision, operationId: p.p_operation_id, watermark: state.sequence
    };
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
    const session = state.userSessions.get(p.p_user_session_id);
    if (!session || session.siteSessionId !== p.p_site_session_id || !state.siteSessions.has(p.p_site_session_id)) {
      return { ok: false, error: 'READ_SESSION_INVALID' };
    }
    const events = state.events.filter((row) => row.sequence > Number(p.p_after_sequence || 0));
    return { ok: true, watermark: events.length ? events.at(-1).sequence : Number(p.p_after_sequence || 0), hasMore: false, events: clone(events) };
  }
  if (name === 'monthly_v7_get_entity') {
    const session = state.userSessions.get(p.p_user_session_id);
    if (!session || session.siteSessionId !== p.p_site_session_id || !state.siteSessions.has(p.p_site_session_id)) {
      return { ok: false, error: 'READ_SESSION_INVALID' };
    }
    const module = state.modules.find((entry) => entry.id === p.p_entity_id);
    if (p.p_entity_type === 'module' && module) return { ok: true, entityType: 'module', entityId: module.id, revision: module.revision, deleted: false, payload: clone(module.payload) };
    if (p.p_entity_type === 'report_meta' && p.p_entity_id === state.report.id) {
      return {
        ok: true, entityType: 'report_meta', entityId: state.report.id,
        revision: state.report.revision, deleted: false,
        payload: {
          title: state.report.title, date: state.report.date,
          period: clone(state.report.period), settings: clone(state.report.settings)
        }
      };
    }
    return { ok: false, error: 'ENTITY_NOT_FOUND' };
  }
  if (name === 'monthly_v7_save_report_meta') {
    const user = userForSession(p.p_user_session_id);
    if (!user) return { ok: false, error: 'USER_SESSION_INVALID' };
    const requestHash = canonical({
      command: 'save_report_meta', reportId: p.p_report_id,
      expectedRevision: Number(p.p_expected_revision),
      title: p.p_title, date: p.p_report_date,
      period: p.p_period, settings: p.p_settings,
      leaseId: p.p_lease_id, fencingToken: Number(p.p_fencing_token)
    });
    const replay = replayOperation(p.p_operation_id, user.id, requestHash);
    if (replay) return replay;
    const lease = state.leases.get(`report_meta:${p.p_report_id}`);
    if (!lease || lease.expiresAt <= now() || lease.leaseId !== p.p_lease_id
      || lease.fencingToken !== Number(p.p_fencing_token)
      || lease.clientSessionId !== p.p_client_session_id || lease.holderUserId !== user.id) {
      return storeOperation(p.p_operation_id, user.id, requestHash, { ok: false, error: 'LEASE_LOST' });
    }
    if (state.report.revision !== Number(p.p_expected_revision)) {
      return storeOperation(p.p_operation_id, user.id, requestHash, {
        ok: false, error: 'REVISION_CONFLICT', currentRevision: state.report.revision
      });
    }
    Object.assign(state.report, { title: p.p_title, date: p.p_report_date, period: clone(p.p_period), settings: clone(p.p_settings), revision: state.report.revision + 1 });
    lease.expiresAt = now() - 1;
    event('report_meta', state.report.id, state.report.revision, p.p_operation_id);
    return storeOperation(p.p_operation_id, user.id, requestHash, { ok: true, revision: state.report.revision });
  }
  if (name === 'monthly_v7_create_report_snapshot') {
    if (!Object.prototype.hasOwnProperty.call(p, 'p_snapshot_kind') || Object.prototype.hasOwnProperty.call(p, 'p_kind')) {
      const error = new Error('Could not find the function public.monthly_v7_create_report_snapshot with the supplied named arguments');
      error.code = 'PGRST202';
      error.details = 'Searched for monthly_v7_create_report_snapshot with p_kind instead of p_snapshot_kind';
      error.statusCode = 404;
      throw error;
    }
    const session = state.userSessions.get(p.p_user_session_id);
    const user = userForSession(p.p_user_session_id);
    if (!session || !user || session.siteSessionId !== p.p_site_session_id) return { ok: false, error: 'READ_SESSION_INVALID' };
    const requestHash = canonical({ command: 'create_report_snapshot', reportId: p.p_report_id, snapshotKind: p.p_snapshot_kind });
    const replay = replayOperation(p.p_operation_id, user.id, requestHash);
    if (replay) return replay;
    const snapshotId = randomUUID();
    const snapshot = { report: clone(state.report), modules: clone(state.modules), records: clone(state.records), watermark: state.sequence };
    const result = { ok: true, snapshotId, snapshotKind: p.p_snapshot_kind, contentSha256: 'fake-sha256', snapshot, operationId: p.p_operation_id };
    state.snapshots.push({ snapshotId, operationId: p.p_operation_id, actorUserId: user.id, watermark: snapshot.watermark, reportRevision: snapshot.report.revision, modules: clone(snapshot.modules) });
    return storeOperation(p.p_operation_id, user.id, requestHash, result);
  }
  return { ok: false, error: `FAKE_RPC_NOT_IMPLEMENTED:${name}` };
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/__fake_reset' && req.method === 'POST') { state = freshState(); res.writeHead(204); return res.end(); }
  if (url.pathname === '/__fake_status' && req.method === 'POST') {
    const kind = String(url.searchParams.get('kind') || 'normalized');
    state.statusFailure = null;
    if (kind === 'legacy') state.statusResponse = { ok: true, authority_state: 'LEGACY_ACTIVE', authority_epoch: 1, minimum_client_version: 6 };
    else if (kind === 'unknown') state.statusResponse = { ok: true, authority_state: 'MIGRATION_UNKNOWN', authority_epoch: 2, minimum_client_version: 7 };
    else if (kind === 'empty') state.statusResponse = { ok: true };
    else if (kind === 'null') state.statusResponse = null;
    else if (kind === 'error') state.statusFailure = { code: 'STATUS_UNAVAILABLE', message: 'STATUS_UNAVAILABLE' };
    else state.statusResponse = { ok: true, authority_state: 'NORMALIZED_ACTIVE', authority_epoch: 2, minimum_client_version: 7 };
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_invalidate_user_sessions' && req.method === 'POST') {
    state.userSessions.clear();
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_structure_change' && req.method === 'POST') {
    state.modules.push({
      id: 'm3', legacyItemId: '103', sortRank: 3, revision: 1, updatedAt: new Date().toISOString(),
      payload: { id: 103, title: '遠端新增模塊', columns: ['遠端內容'], colLayout: '1', selectedForPdf: true, moduleCategory: 'custom', pdfOrder: 3 }
    });
    state.report.revision += 1;
    event('report_structure', state.report.id, state.report.revision, randomUUID());
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_reverse_module_order' && req.method === 'POST') {
    state.modules = state.modules.slice().reverse().map((module, index) => ({ ...module, sortRank: index + 1 }));
    state.report.revision += 1;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_remote_module_change' && req.method === 'POST') {
    const module = state.modules[0];
    module.payload = Object.assign({}, module.payload, { title: '遠端較新內容' });
    module.revision += 1;
    module.updatedAt = new Date().toISOString();
    event('module', module.id, module.revision, randomUUID());
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_remote_report_meta_change' && req.method === 'POST') {
    state.report.title = '遠端較新月報標題';
    state.report.revision += 1;
    event('report_meta', state.report.id, state.report.revision, randomUUID());
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_malicious_module_title' && req.method === 'POST') {
    state.modules[0].payload = Object.assign({}, state.modules[0].payload, {
      title: '<b data-safe-title="1">安全粗體</b><img src="/missing-title-image" onerror="window.__v7TitleXssExecuted=(window.__v7TitleXssExecuted||0)+1"><script>window.__v7TitleXssExecuted=(window.__v7TitleXssExecuted||0)+1<\/script>'
    });
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_drop_first_module_lease' && req.method === 'POST') {
    state.leases.delete(`module:${state.modules[0].id}`);
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_hang_rpc' && req.method === 'POST') {
    const name = String(url.searchParams.get('name') || '');
    const rawCount = String(url.searchParams.get('count') || '1');
    const count = rawCount === 'always' ? -1 : Math.max(0, Number(rawCount));
    if (url.searchParams.get('mode') === 'after_commit') state.hangAfterCommitCounts.set(name, count);
    else state.hangRpcCounts.set(name, count);
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/__fake_state') { res.writeHead(200, { 'Content-Type': mime['.json'] }); return res.end(JSON.stringify(resultState())); }
  if (url.pathname.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
    const name = url.pathname.slice('/rest/v1/rpc/'.length);
    state.rpcCounts.set(name, Number(state.rpcCounts.get(name) || 0) + 1);
    res.writeHead(403, { 'Content-Type': mime['.json'] });
    return res.end(JSON.stringify({ code: '42501', message: `permission denied for function ${name}` }));
  }
  if (url.pathname === '/__fake_rpc' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const request = JSON.parse(body || '{}');
        const remainingAfterCommit = Number(state.hangAfterCommitCounts.get(request.name) || 0);
        if (remainingAfterCommit === -1 || remainingAfterCommit > 0) {
          rpc(request.name, request.params || {});
          if (remainingAfterCommit > 0) state.hangAfterCommitCounts.set(request.name, remainingAfterCommit - 1);
          return;
        }
        const remainingHangs = Number(state.hangRpcCounts.get(request.name) || 0);
        if (remainingHangs === -1) return;
        if (remainingHangs > 0) {
          state.hangRpcCounts.set(request.name, remainingHangs - 1);
          return;
        }
        const data = rpc(request.name, request.params || {});
        res.writeHead(200, { 'Content-Type': mime['.json'] });
        res.end(JSON.stringify(data));
      }
      catch (error) {
        res.writeHead(Number(error.statusCode) || 500, { 'Content-Type': mime['.json'] });
        res.end(JSON.stringify({ message: error.message, code: error.code || 'FAKE_RPC_ERROR', details: error.details || '' }));
      }
    });
    return;
  }
  if (url.pathname === '/supabase-config.js') {
    res.writeHead(200, { 'Content-Type': mime['.js'] });
    return res.end(`window.MONTHLY_REPORT_SUPABASE_CONFIG={supabaseUrl:${JSON.stringify(`http://${req.headers.host}`)},anonKey:'fake-anon-key',workspaceKey:'browser-workspace'};window.MONTHLY_REPORT_ASSET_BUILDS=Object.assign({},window.MONTHLY_REPORT_ASSET_BUILDS,{config:'7.0.20'});`);
  }
  if (url.pathname === '/vendor/supabase-2.112.2.js') { res.writeHead(200, { 'Content-Type': mime['.js'] }); return res.end(fakeSdk); }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
server.listen(port, '127.0.0.1', () => console.log(`monthly-v7-test-server http://127.0.0.1:${port}`));
