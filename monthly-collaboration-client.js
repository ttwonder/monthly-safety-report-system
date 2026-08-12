(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('./monthly-collaboration-core.js') : root.MonthlyCollaborationCore
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MonthlyCollaborationClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  class MonthlyV7Client {
    constructor(options = {}) {
      if (!options.transport || typeof options.transport.rpc !== 'function') throw new TypeError('transport.rpc is required');
      this.transport = options.transport;
      this.sessionStorage = options.sessionStorage || null;
      this.draftStorage = options.draftStorage || null;
      this.core = options.core || core;
      this.host = options.host || {};
      this.idFactory = options.idFactory || (() => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      });
      this.operationIdFactory = options.operationIdFactory || this.idFactory;
      const storedClientId = this.sessionStorage && this.sessionStorage.getItem('monthly_v7_client_session_id');
      this.clientSessionId = storedClientId || this.idFactory();
      if (this.sessionStorage && !storedClientId) this.sessionStorage.setItem('monthly_v7_client_session_id', this.clientSessionId);
      this.siteSession = null;
      this.userSession = null;
      this.user = null;
      this.watermark = 0;
      this.snapshot = null;
      this.leases = new Map();
      this.config = null;
      this.status = { mode: 'unknown', authorityState: '', authorityEpoch: 0, minimumClientVersion: 0 };
      this.heartbeatTimer = null;
      this.sessionGeneration = 0;
    }

    sessionErrorCode(value) {
      const candidates = [];
      const sources = [value, value && value.error, value && value.cause];
      for (const source of sources) {
        if (typeof source === 'string') {
          candidates.push(source);
        } else if (source && typeof source === 'object') {
          candidates.push(source.code, source.error, source.message, source.details, source.hint);
        }
      }
      for (const candidate of candidates) {
        const text = String(candidate || '');
        const code = ['SITE_SESSION_INVALID', 'USER_SESSION_INVALID', 'READ_SESSION_INVALID']
          .find((sentinel) => text.includes(sentinel));
        if (code) return code;
      }
      return '';
    }

    notifySessionStateChanged(reason, code = '') {
      this.sessionGeneration += 1;
      const event = Object.freeze({
        reason: String(reason || ''),
        code: String(code || ''),
        generation: this.sessionGeneration,
        siteUnlocked: this.isSiteUnlocked(),
        user: this.currentUser()
      });
      if (typeof this.host.onSessionStateChanged === 'function') {
        try { this.host.onSessionStateChanged(event); } catch (_) { /* session cleanup must still finish */ }
      }
      return event;
    }

    handleSessionError(value, requestGeneration = this.sessionGeneration) {
      const code = this.sessionErrorCode(value);
      if (!code || requestGeneration !== this.sessionGeneration) return code;
      if (code === 'SITE_SESSION_INVALID') {
        this.clearSessions('server-site-session-invalid', code);
      } else {
        this.clearUserSession('server-user-session-invalid', code);
      }
      return code;
    }

    staleSessionResponseError(name, requestGeneration, code = '') {
      const staleCode = String(code || 'STALE_SESSION_RESPONSE');
      const error = new Error(staleCode);
      error.code = staleCode;
      error.staleSessionResponse = true;
      error.rpcName = String(name || '');
      error.requestGeneration = Number(requestGeneration);
      error.currentGeneration = Number(this.sessionGeneration);
      error.silent = true;
      return error;
    }

    async rpc(name, params) {
      const requestGeneration = this.sessionGeneration;
      try {
        const result = await this.transport.rpc(name, params);
        if (requestGeneration !== this.sessionGeneration) {
          throw this.staleSessionResponseError(name, requestGeneration, this.sessionErrorCode(result));
        }
        const sessionCode = this.handleSessionError(result, requestGeneration);
        if (requestGeneration !== this.sessionGeneration) {
          const error = new Error(sessionCode || 'STALE_SESSION_RESPONSE');
          error.code = sessionCode || 'STALE_SESSION_RESPONSE';
          error.sessionInvalidHandled = !!sessionCode;
          error.silent = true;
          throw error;
        }
        return result;
      } catch (error) {
        if (error && (error.staleSessionResponse === true || error.sessionInvalidHandled === true)) throw error;
        if (requestGeneration !== this.sessionGeneration) {
          throw this.staleSessionResponseError(name, requestGeneration, this.sessionErrorCode(error));
        }
        this.handleSessionError(error, requestGeneration);
        throw error;
      }
    }

    async initialize(config) {
      this.config = Object.assign({}, config || {});
      if (!String(this.config.workspaceKey || '').trim()) throw new Error('workspaceKey is required');
      if (typeof this.transport.ensureAnonymous === 'function') await this.transport.ensureAnonymous(this.config);
      const raw = await this.rpc('monthly_v7_get_status', { p_workspace_key: this.config.workspaceKey });
      const authorityState = String(raw && (raw.authority_state || raw.authorityState) || '');
      this.status = {
        mode: authorityState === 'NORMALIZED_ACTIVE' ? 'v7' : 'legacy',
        authorityState,
        authorityEpoch: Number(raw && (raw.authority_epoch ?? raw.authorityEpoch) || 0),
        minimumClientVersion: Number(raw && (raw.minimum_client_version ?? raw.minimumClientVersion) || 0)
      };
      if (this.status.mode === 'v7' && this.sessionStorage) {
        try { this.siteSession = JSON.parse(this.sessionStorage.getItem('monthly_v7_site_session') || 'null'); } catch { this.siteSession = null; }
        try { this.userSession = JSON.parse(this.sessionStorage.getItem('monthly_v7_user_session') || 'null'); } catch { this.userSession = null; }
        try { this.user = JSON.parse(this.sessionStorage.getItem('monthly_v7_user_projection') || 'null'); } catch { this.user = null; }
      }
      return Object.assign({}, this.status);
    }

    isActive() { return this.status.mode === 'v7'; }
    isSiteUnlocked() { return this.isActive() && !!(this.siteSession && this.siteSession.id); }
    currentUser() { return this.userSession && this.userSession.id && this.user ? Object.assign({}, this.user) : null; }

    captureSessionContext() {
      const user = this.currentUser();
      return Object.freeze({
        generation: Number(this.sessionGeneration),
        actorUserId: String(user && user.id || ''),
        userSessionId: String(this.userSession && this.userSession.id || ''),
        siteSessionId: String(this.siteSession && this.siteSession.id || ''),
        clientSessionId: String(this.clientSessionId || '')
      });
    }

    isSessionContextCurrent(context) {
      if (!context || typeof context !== 'object') return false;
      const current = this.captureSessionContext();
      return Number(context.generation) === current.generation
        && String(context.actorUserId || '') === current.actorUserId
        && String(context.userSessionId || '') === current.userSessionId
        && String(context.siteSessionId || '') === current.siteSessionId
        && String(context.clientSessionId || '') === current.clientSessionId;
    }

    assertSessionContext(context, operationName = '') {
      if (this.isSessionContextCurrent(context)) return context;
      throw this.staleSessionResponseError(operationName, Number(context && context.generation));
    }

    async openSite(password) {
      if (!this.isActive()) throw new Error('V7 authority is not active');
      this.sessionGeneration += 1;
      this.clearUserSession();
      const result = await this.rpc('monthly_v7_open_site', {
        p_workspace_key: this.config.workspaceKey,
        p_password: String(password || ''),
        p_client_session_id: this.clientSessionId
      });
      if (!result || result.ok !== true) throw new Error(result && result.error || 'SITE_LOGIN_FAILED');
      this.siteSession = { id: result.site_session_id || result.siteSessionId, expiresAt: result.expires_at || result.expiresAt || '' };
      if (this.sessionStorage) this.sessionStorage.setItem('monthly_v7_site_session', JSON.stringify(this.siteSession));
      this.sessionGeneration += 1;
      return Object.assign({}, this.siteSession);
    }

    async login(username, password) {
      if (!this.isSiteUnlocked()) throw new Error('SITE_SESSION_REQUIRED');
      const result = await this.rpc('monthly_v7_login_user', {
        p_workspace_key: this.config.workspaceKey,
        p_site_session_id: this.siteSession.id,
        p_client_session_id: this.clientSessionId,
        p_username: String(username || '').trim(),
        p_password: String(password || '')
      });
      if (!result || result.ok !== true) throw new Error(result && result.error || 'USER_LOGIN_FAILED');
      this.userSession = { id: result.user_session_id || result.userSessionId };
      this.user = Object.assign({}, result.user || {});
      if (this.sessionStorage) {
        this.sessionStorage.setItem('monthly_v7_user_session', JSON.stringify(this.userSession));
        this.sessionStorage.setItem('monthly_v7_user_projection', JSON.stringify(this.user));
      }
      this.sessionGeneration += 1;
      await this.loadSnapshot();
      return this.currentUser();
    }

    cloneJson(value, fallback = null) {
      if (value == null) return fallback;
      return JSON.parse(JSON.stringify(value));
    }

    readDraft(entityType, entityId) {
      if (!this.draftStorage) return null;
      try { return JSON.parse(this.draftStorage.getItem(this.draftKey(entityType, entityId)) || 'null'); }
      catch { return null; }
    }

    cleanLocalPayload(local) {
      if (local == null) return null;
      const payload = this.cloneJson(local, {});
      delete payload._v7Id;
      delete payload._v7Revision;
      return payload;
    }

    async mergeSnapshotWithProtectedLocal(snapshot) {
      const incoming = this.cloneJson(snapshot, {});
      const previous = this.snapshot || {
        report: this.cloneJson(incoming.report, {}),
        modules: this.cloneJson(incoming.modules, []),
        records: this.cloneJson(incoming.records, [])
      };
      const protectedTargets = new Map();
      const protect = (entityType, entityId) => {
        if (!entityType || !entityId) return;
        protectedTargets.set(this.leaseKey(entityType, entityId), { entityType, entityId: String(entityId) });
      };
      for (const lease of this.leases.values()) protect(lease.entityType, lease.entityId);
      for (const row of previous.modules || []) if (this.readDraft('module', row.id)) protect('module', row.id);
      for (const row of previous.records || []) {
        const type = `record:${row.recordType}`;
        if (this.readDraft(type, row.id)) protect(type, row.id);
      }
      if (previous.report && this.readDraft('report_meta', previous.report.id)) protect('report_meta', previous.report.id);

      for (const target of protectedTargets.values()) {
        const { entityType, entityId } = target;
        const draft = this.readDraft(entityType, entityId);
        const local = typeof this.host.getLocalEntity === 'function'
          ? await this.host.getLocalEntity(entityType, entityId)
          : null;
        if (entityType === 'module') {
          const prior = (previous.modules || []).find((row) => String(row.id) === entityId);
          const serverIndex = (incoming.modules || []).findIndex((row) => String(row.id) === entityId);
          const server = serverIndex >= 0 ? incoming.modules[serverIndex] : null;
          if (!draft && !local && !prior) continue;
          const row = this.cloneJson(server || prior, { id: entityId, sortRank: Number(prior && prior.sortRank || 0) });
          if (server) {
            row._serverPayload = this.cloneJson(server.payload, {});
            row._serverRevision = Number(server.revision || 0);
          }
          row.payload = this.cloneJson(draft && draft.payload, null) || this.cleanLocalPayload(local) || this.cloneJson(prior && prior.payload, {});
          row.revision = Number((draft && draft.baseRevision) ?? (local && local._v7Revision) ?? (prior && prior.revision) ?? 0);
          if (serverIndex >= 0) incoming.modules[serverIndex] = row;
          else (incoming.modules || (incoming.modules = [])).push(row);
          if (typeof this.host.onRemoteChangeWhileEditing === 'function') {
            this.host.onRemoteChangeWhileEditing({ ok: true, entityType, entityId, local: row, server, preserved: true }, target);
          }
          continue;
        }
        if (entityType.startsWith('record:')) {
          const recordType = entityType.slice('record:'.length);
          const prior = (previous.records || []).find((row) => String(row.id) === entityId && row.recordType === recordType);
          const serverIndex = (incoming.records || []).findIndex((row) => String(row.id) === entityId && row.recordType === recordType);
          const server = serverIndex >= 0 ? incoming.records[serverIndex] : null;
          if (!draft && !local && !prior) continue;
          const row = this.cloneJson(server || prior, { id: entityId, recordType });
          row.payload = this.cloneJson(draft && draft.payload, null) || this.cleanLocalPayload(local) || this.cloneJson(prior && prior.payload, {});
          row.revision = Number((draft && draft.baseRevision) ?? (local && local._v7Revision) ?? (prior && prior.revision) ?? 0);
          if (serverIndex >= 0) incoming.records[serverIndex] = row;
          else (incoming.records || (incoming.records = [])).push(row);
          if (typeof this.host.onRemoteChangeWhileEditing === 'function') {
            this.host.onRemoteChangeWhileEditing({ ok: true, entityType, entityId, local: row, server, preserved: true }, target);
          }
          continue;
        }
        if (entityType === 'report_meta' && incoming.report && previous.report) {
          const server = this.cloneJson(incoming.report, {});
          const meta = this.cloneJson(draft && draft.payload, null) || this.cloneJson(local, null) || this.cloneJson(previous.report, {});
          for (const field of ['title', 'date', 'period', 'settings', 'status']) {
            if (meta && Object.prototype.hasOwnProperty.call(meta, field)) incoming.report[field] = this.cloneJson(meta[field], meta[field]);
          }
          incoming.report.revision = Number((draft && draft.baseRevision) ?? (meta && meta._v7Revision) ?? previous.report.revision ?? 0);
          if (typeof this.host.onRemoteChangeWhileEditing === 'function') {
            this.host.onRemoteChangeWhileEditing({ ok: true, entityType, entityId, local: meta, server, preserved: true }, target);
          }
        }
      }
      return incoming;
    }

    async loadSnapshot(options = {}) {
      if (!this.isSiteUnlocked()) throw new Error('SITE_SESSION_REQUIRED');
      const snapshot = await this.rpc('monthly_v7_get_snapshot', {
        p_workspace_key: this.config.workspaceKey,
        p_site_session_id: this.siteSession.id,
        p_user_session_id: this.userSession ? this.userSession.id : null
      });
      if (!snapshot || snapshot.ok !== true) throw new Error(snapshot && snapshot.error || 'SNAPSHOT_FAILED');
      const merged = options.preserveLocalIntents === false ? snapshot : await this.mergeSnapshotWithProtectedLocal(snapshot);
      this.snapshot = merged;
      const bundle = this.core.legacyBundleFromSnapshot(merged);
      this.watermark = Number(snapshot.watermark || 0);
      if (typeof this.host.applyBundle === 'function') await this.host.applyBundle(bundle, merged);
      return merged;
    }

    currentReport() {
      return this.snapshot && this.snapshot.report ? this.snapshot.report : null;
    }

    requireUserSession() {
      if (!this.isActive()) throw new Error('V7 authority is not active');
      if (!this.userSession || !this.userSession.id || !this.user) throw new Error('USER_SESSION_REQUIRED');
    }

    leaseKey(entityType, entityId) { return this.core.entityKey(entityType, entityId); }
    getLease(entityType, entityId) { return this.leases.get(this.leaseKey(entityType, entityId)) || null; }

    normalizeLease(raw) {
      return {
        entityType: raw.entity_type || raw.entityType,
        entityId: raw.entity_id || raw.entityId,
        leaseId: raw.lease_id || raw.leaseId,
        fencingToken: Number(raw.fencing_token ?? raw.fencingToken),
        holderUserId: raw.holder_user_id || raw.holderUserId,
        clientSessionId: raw.client_session_id || raw.clientSessionId,
        expiresAt: raw.expires_at || raw.expiresAt
      };
    }

    async claimLease(entityType, entityId, ttlSeconds = 90) {
      this.requireUserSession();
      const raw = await this.rpc('monthly_v7_claim_lease', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_ttl_seconds: ttlSeconds
      });
      if (!raw || raw.ok !== true) {
        const code = raw && raw.error || 'LEASE_HELD';
        const holderDisplayName = String(raw && (raw.holder_display_name || raw.holderDisplayName) || '').trim();
        const message = code === 'LEASE_HELD'
          ? (holderDisplayName
            ? `此項目目前由「${holderDisplayName}」編輯，請稍後再試。`
            : '此項目目前由其他使用者編輯，請稍後再試。')
          : code;
        const error = new Error(message);
        error.code = code;
        error.holderDisplayName = holderDisplayName || null;
        error.result = raw;
        throw error;
      }
      const lease = this.normalizeLease(raw);
      this.leases.set(this.leaseKey(entityType, entityId), lease);
      if (typeof this.host.onLease === 'function') this.host.onLease(lease);
      return lease;
    }

    async renewLease(entityType, entityId, ttlSeconds = 90) {
      const operationContext = this.captureSessionContext();
      const lease = this.getLease(entityType, entityId);
      if (!lease) return null;
      const key = this.leaseKey(entityType, entityId);
      const raw = await this.rpc('monthly_v7_renew_lease', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_lease_id: lease.leaseId,
        p_fencing_token: lease.fencingToken,
        p_ttl_seconds: ttlSeconds
      });
      this.assertSessionContext(operationContext, 'renew_lease');
      if (this.leases.get(key) !== lease) return null;
      if (!raw || raw.ok !== true) {
        this.leases.delete(key);
        if (typeof this.host.onLeaseLost === 'function') this.host.onLeaseLost({ entityType, entityId, lease, result: raw });
        return null;
      }
      const renewed = this.normalizeLease(raw);
      if (this.leases.get(key) === lease) this.leases.set(key, renewed);
      return renewed;
    }

    forgetCapturedLease(lease) {
      if (!lease) return false;
      const key = this.leaseKey(lease.entityType, lease.entityId);
      if (this.leases.get(key) !== lease) return false;
      this.leases.delete(key);
      return true;
    }

    async releaseCapturedLease(lease, operationContext = this.captureSessionContext()) {
      if (!lease) return true;
      const entityType = String(lease.entityType || '');
      const entityId = String(lease.entityId || '');
      const key = this.leaseKey(entityType, entityId);
      if (!entityType || !entityId
        || !this.isSessionContextCurrent(operationContext)
        || this.leases.get(key) !== lease) return false;
      try {
        const raw = await this.rpc('monthly_v7_release_lease', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: operationContext.userSessionId,
          p_client_session_id: operationContext.clientSessionId,
          p_entity_type: entityType,
          p_entity_id: entityId,
          p_lease_id: lease.leaseId,
          p_fencing_token: lease.fencingToken
        });
        this.assertSessionContext(operationContext, 'release_lease');
        return !!(raw && raw.ok);
      } finally {
        if (this.isSessionContextCurrent(operationContext)
          && this.leases.get(key) === lease) this.leases.delete(key);
      }
    }

    async releaseLease(entityType, entityId) {
      const lease = this.getLease(entityType, entityId);
      if (!lease) return true;
      return this.releaseCapturedLease(lease, this.captureSessionContext());
    }

    startHeartbeat(intervalMs = 30000) {
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        for (const lease of Array.from(this.leases.values())) {
          this.renewLease(lease.entityType, lease.entityId).catch((error) => {
            if (typeof this.host.onTransportError === 'function') this.host.onTransportError(error);
          });
        }
      }, intervalMs);
      return this.heartbeatTimer;
    }

    stopHeartbeat() {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    draftKey(entityType, entityId) { return `monthly_v7_draft:${this.leaseKey(entityType, entityId)}`; }

    saveDraft(entityType, entityId, payload, baseRevision, options = {}) {
      if (!this.draftStorage) return;
      const draft = {
        entityType, entityId, baseRevision: Number(baseRevision || 0), payload,
        savedAt: new Date().toISOString()
      };
      if (options && options.supersedesOperation) {
        draft.supersedesOperation = this.cloneJson(options.supersedesOperation, null);
      }
      this.draftStorage.setItem(this.draftKey(entityType, entityId), JSON.stringify(draft));
    }

    clearDraft(entityType, entityId) {
      if (this.draftStorage) this.draftStorage.removeItem(this.draftKey(entityType, entityId));
    }

    hasPendingOperation(pendingKey) {
      if (!this.draftStorage || !pendingKey) return false;
      return this.draftStorage.getItem(`monthly_v7_pending:${pendingKey}`) !== null;
    }

    hasCurrentActorPendingOperation(pendingKey) {
      if (!this.draftStorage || !pendingKey) return false;
      const pendingRaw = this.draftStorage.getItem(`monthly_v7_pending:${pendingKey}`);
      if (pendingRaw === null) return false;
      let pending;
      try {
        pending = JSON.parse(pendingRaw);
        this.validatePendingEnvelope(pending);
      } catch (_error) {
        // A malformed envelope cannot safely be treated as clean. The normal replay
        // path will surface PENDING_OPERATION_UNRESOLVED without replacing it.
        return true;
      }
      const currentActorId = String(this.currentUser() && this.currentUser().id || '');
      if (!currentActorId) return false;
      if (!pending.actorUserId) return true;
      return String(pending.actorUserId) === currentActorId;
    }

    pendingOperationTargets(rpcName, pendingKey) {
      const targets = new Set();
      if (!this.draftStorage || !pendingKey) return targets;
      const pendingRaw = this.draftStorage.getItem(`monthly_v7_pending:${pendingKey}`);
      if (pendingRaw === null) return targets;
      let pending;
      try { pending = JSON.parse(pendingRaw); }
      catch (_error) { throw this.pendingOperationError(); }
      const previousParams = this.validatePendingEnvelope(pending);
      this.bindPendingActor(rpcName, pending, previousParams);
      if (rpcName !== 'monthly_v7_save_module_batch') throw this.pendingOperationError();
      const report = this.currentReport();
      const changes = previousParams.p_changes;
      if (!report || pendingKey !== `save_module_batch:${report.id}`
        || String(previousParams.p_report_id || '') !== String(report.id)
        || !Array.isArray(changes) || !changes.length) {
        throw this.pendingOperationError();
      }
      const rowKeys = ['expectedRevision', 'moduleId', 'payload'];
      for (const row of changes) {
        const actualKeys = row && typeof row === 'object' && !Array.isArray(row)
          ? Object.keys(row).sort() : [];
        const entityId = String(row && row.moduleId || '');
        if (actualKeys.length !== rowKeys.length
          || !actualKeys.every((key, index) => key === rowKeys[index])
          || !entityId
          || !Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0
          || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)
          || targets.has(entityId)
          || !this.pendingTargetsEntity(rpcName, pendingKey, previousParams, 'module', entityId)) {
          throw this.pendingOperationError();
        }
        targets.add(entityId);
      }
      return targets;
    }

    modulePayload(item) {
      const payload = JSON.parse(JSON.stringify(item || {}));
      delete payload._v7Id;
      delete payload._v7Revision;
      return payload;
    }

    pendingOperationError(code = 'PENDING_OPERATION_UNRESOLVED') {
      const error = new Error(code);
      error.code = code;
      return error;
    }

    validatePendingEnvelope(pending) {
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
        throw this.pendingOperationError();
      }
      const actualKeys = Object.keys(pending).sort();
      const legacyKeys = ['createdAt', 'operationId', 'signature'];
      const actorKeys = ['actorUserId', 'createdAt', 'operationId', 'signature'];
      const matches = (keys) => actualKeys.length === keys.length
        && actualKeys.every((key, index) => key === keys[index]);
      const actorEnvelope = matches(actorKeys);
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const parsedCreatedAt = new Date(pending && pending.createdAt);
      if ((!matches(legacyKeys) && !actorEnvelope)
        || typeof pending.operationId !== 'string' || !pending.operationId
        || !uuidPattern.test(pending.operationId)
        || typeof pending.signature !== 'string' || !pending.signature
        || typeof pending.createdAt !== 'string' || !pending.createdAt
        || Number.isNaN(parsedCreatedAt.getTime())
        || parsedCreatedAt.toISOString() !== pending.createdAt
        || (actorEnvelope && (typeof pending.actorUserId !== 'string' || !pending.actorUserId))) {
        throw this.pendingOperationError();
      }
      let previousParams;
      try { previousParams = JSON.parse(pending.signature); }
      catch (_error) { throw this.pendingOperationError(); }
      if (!previousParams || typeof previousParams !== 'object' || Array.isArray(previousParams)) {
        throw this.pendingOperationError();
      }
      const leasePairs = [
        ['p_lease_id', 'p_fencing_token'],
        ['p_module_lease_id', 'p_module_fencing_token'],
        ['p_structure_lease_id', 'p_structure_fencing_token']
      ];
      for (const [leaseKey, fencingKey] of leasePairs) {
        const hasLease = Object.prototype.hasOwnProperty.call(previousParams, leaseKey);
        const hasFencing = Object.prototype.hasOwnProperty.call(previousParams, fencingKey);
        if (hasLease !== hasFencing) throw this.pendingOperationError();
        if (hasLease && (typeof previousParams[leaseKey] !== 'string'
          || !previousParams[leaseKey].trim()
          || !Number.isSafeInteger(previousParams[fencingKey])
          || previousParams[fencingKey] <= 0)) {
          throw this.pendingOperationError();
        }
      }
      return previousParams;
    }

    isExactLegacySnapshotSignature(rpcName, previousParams) {
      if (rpcName !== 'monthly_v7_create_report_snapshot'
        || !previousParams || typeof previousParams !== 'object' || Array.isArray(previousParams)) return false;
      const expectedKeys = ['p_kind', 'p_report_id', 'p_site_session_id', 'p_user_session_id', 'p_workspace_key'];
      const actualKeys = Object.keys(previousParams).sort();
      if (actualKeys.length !== expectedKeys.length
        || !actualKeys.every((key, index) => key === expectedKeys[index])) return false;
      return expectedKeys.every((key) => typeof previousParams[key] === 'string' && previousParams[key].length > 0);
    }

    bindPendingActor(rpcName, pending, previousParams) {
      const currentActorId = String(this.currentUser() && this.currentUser().id || '');
      if (!currentActorId) throw this.pendingOperationError('PENDING_OPERATION_ACTOR_UNRESOLVED');
      const legacySnapshotCandidate = rpcName === 'monthly_v7_create_report_snapshot'
        && Object.prototype.hasOwnProperty.call(previousParams, 'p_kind')
        && !Object.prototype.hasOwnProperty.call(previousParams, 'p_snapshot_kind');
      const safeLegacySnapshotShape = this.isExactLegacySnapshotSignature(rpcName, previousParams);
      if (legacySnapshotCandidate && !safeLegacySnapshotShape) {
        throw this.pendingOperationError();
      }
      if (pending.actorUserId) {
        if (String(pending.actorUserId) !== currentActorId) {
          throw this.pendingOperationError('PENDING_OPERATION_ACTOR_MISMATCH');
        }
        return pending;
      }
      if (!safeLegacySnapshotShape) {
        throw this.pendingOperationError('PENDING_OPERATION_ACTOR_UNRESOLVED');
      }
      return Object.assign({}, pending, { actorUserId: currentActorId });
    }

    migratePendingOperationSignature(rpcName, params, pendingKey, pending, signature) {
      if (!pending) return pending;
      this.validatePendingEnvelope(pending);
      if (pending.signature === signature) return pending;
      const hasExactKeys = (value, expected) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const actual = Object.keys(value).sort();
        const wanted = expected.slice().sort();
        return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
      };
      const legacyEnvelope = hasExactKeys(pending, ['operationId', 'signature', 'createdAt']);
      const actorEnvelope = hasExactKeys(pending, ['operationId', 'signature', 'createdAt', 'actorUserId']);
      if ((!legacyEnvelope && !actorEnvelope)
        || typeof pending.operationId !== 'string' || !pending.operationId
        || typeof pending.signature !== 'string' || typeof pending.createdAt !== 'string'
        || (actorEnvelope && (typeof pending.actorUserId !== 'string' || !pending.actorUserId))
        || !params || typeof params !== 'object' || Array.isArray(params)) return pending;
      let previousParams;
      try { previousParams = JSON.parse(pending.signature); } catch { return pending; }
      if (!previousParams || typeof previousParams !== 'object' || Array.isArray(previousParams)) return pending;
      const sessionKeys = new Set([
        'p_site_session_id', 'p_user_session_id', 'p_client_session_id'
      ]);
      const leaseKeys = new Set([
        'p_lease_id', 'p_fencing_token',
        'p_module_lease_id', 'p_module_fencing_token',
        'p_structure_lease_id', 'p_structure_fencing_token'
      ]);
      const canonicalValue = (value) => {
        if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
        if (value && typeof value === 'object') {
          return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
      };
      const normalizeRequest = (value) => {
        const stable = JSON.parse(JSON.stringify(value));
        if (rpcName === 'monthly_v7_create_report_snapshot'
          && Object.prototype.hasOwnProperty.call(stable, 'p_kind')
          && !Object.prototype.hasOwnProperty.call(stable, 'p_snapshot_kind')) {
          stable.p_snapshot_kind = stable.p_kind;
          delete stable.p_kind;
        }
        return stable;
      };
      const withoutKeys = (value, keys) => {
        const stable = JSON.parse(JSON.stringify(value));
        for (const key of keys) delete stable[key];
        return stable;
      };
      if (rpcName === 'monthly_v7_create_report_snapshot'
        && pendingKey !== `create_snapshot:${params.p_report_id}:${params.p_snapshot_kind}`) return pending;
      const previousRequest = normalizeRequest(previousParams);
      const currentRequest = normalizeRequest(params);
      if (canonicalValue(withoutKeys(previousRequest, sessionKeys)) === canonicalValue(withoutKeys(currentRequest, sessionKeys))) {
        return Object.assign({}, pending, { signature });
      }
      const recoverableKeys = new Set([...sessionKeys, ...leaseKeys]);
      if (canonicalValue(withoutKeys(previousRequest, recoverableKeys)) !== canonicalValue(withoutKeys(currentRequest, recoverableKeys))) return pending;
      const replayParams = JSON.parse(JSON.stringify(previousRequest));
      for (const key of sessionKeys) {
        if (Object.prototype.hasOwnProperty.call(currentRequest, key)) replayParams[key] = currentRequest[key];
        else delete replayParams[key];
      }
      return Object.assign({}, pending, {
        signature: JSON.stringify(replayParams),
        replayParams
      });
    }

    operationCanonical(value) {
      if (Array.isArray(value)) return `[${value.map((entry) => this.operationCanonical(entry)).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${this.operationCanonical(value[key])}`).join(',')}}`;
      }
      return JSON.stringify(value);
    }

    operationBusinessParams(value) {
      const transientKeys = new Set([
        'p_site_session_id', 'p_user_session_id', 'p_client_session_id',
        'p_lease_id', 'p_fencing_token',
        'p_module_lease_id', 'p_module_fencing_token',
        'p_structure_lease_id', 'p_structure_fencing_token'
      ]);
      const result = JSON.parse(JSON.stringify(value || {}));
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      transientKeys.forEach((key) => delete result[key]);
      return result;
    }

    pendingTargetsEntity(rpcName, pendingKey, previousParams, entityType, entityId) {
      const hasExactKeys = (value, expected) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const actual = Object.keys(value).sort();
        const wanted = expected.slice().sort();
        return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
      };
      const id = String(entityId || '');
      if (rpcName === 'monthly_v7_save_module') {
        return entityType === 'module'
          && pendingKey === `save_module:${id}`
          && String(previousParams.p_module_id || '') === id
          && Number.isFinite(Number(previousParams.p_expected_revision))
          && hasExactKeys(previousParams, [
            'p_workspace_key', 'p_user_session_id', 'p_client_session_id',
            'p_module_id', 'p_expected_revision', 'p_lease_id', 'p_fencing_token', 'p_payload'
          ]);
      }
      if (rpcName === 'monthly_v7_save_module_batch') {
        const report = this.currentReport();
        return entityType === 'module'
          && report && pendingKey === `save_module_batch:${report.id}`
          && String(previousParams.p_report_id || '') === String(report.id)
          && Array.isArray(previousParams.p_changes)
          && previousParams.p_changes.some((row) => String(row && row.moduleId || '') === id)
          && hasExactKeys(previousParams, [
            'p_workspace_key', 'p_user_session_id', 'p_client_session_id',
            'p_report_id', 'p_changes', 'p_lease_id', 'p_fencing_token'
          ]);
      }
      if (rpcName === 'monthly_v7_save_report_meta') {
        return entityType === 'report_meta'
          && pendingKey === `save_report_meta:${id}`
          && String(previousParams.p_report_id || '') === id
          && Number.isFinite(Number(previousParams.p_expected_revision))
          && hasExactKeys(previousParams, [
            'p_workspace_key', 'p_user_session_id', 'p_client_session_id',
            'p_report_id', 'p_expected_revision', 'p_title', 'p_report_date',
            'p_period', 'p_settings', 'p_lease_id', 'p_fencing_token'
          ]);
      }
      return false;
    }

    pendingMarkerSignatureMatches(markerSignature, pendingSignature) {
      if (markerSignature === pendingSignature) return true;
      let markerParams;
      let pendingParams;
      try {
        markerParams = JSON.parse(markerSignature);
        pendingParams = JSON.parse(pendingSignature);
      } catch (_error) { return false; }
      if (!markerParams || !pendingParams || typeof markerParams !== 'object'
        || typeof pendingParams !== 'object' || Array.isArray(markerParams) || Array.isArray(pendingParams)) {
        return false;
      }
      const markerKeys = Object.keys(markerParams).sort();
      const pendingKeys = Object.keys(pendingParams).sort();
      if (this.operationCanonical(markerKeys) !== this.operationCanonical(pendingKeys)) return false;
      const sessionKeys = new Set(['p_site_session_id', 'p_user_session_id', 'p_client_session_id']);
      return markerKeys.every((key) => {
        if (sessionKeys.has(key)) {
          return typeof markerParams[key] === 'string' && markerParams[key].trim()
            && typeof pendingParams[key] === 'string' && pendingParams[key].trim();
        }
        return this.operationCanonical(markerParams[key]) === this.operationCanonical(pendingParams[key]);
      });
    }

    pendingEntityPayload(rpcName, previousParams, entityId) {
      if (rpcName === 'monthly_v7_save_module') return previousParams.p_payload;
      if (rpcName === 'monthly_v7_save_module_batch') {
        const row = (previousParams.p_changes || [])
          .find((entry) => String(entry && entry.moduleId || '') === String(entityId || ''));
        return row && row.payload;
      }
      if (rpcName === 'monthly_v7_save_report_meta') {
        return {
          title: String(previousParams.p_title || ''),
          date: String(previousParams.p_report_date || ''),
          period: this.cloneJson(previousParams.p_period, {}),
          settings: this.cloneJson(previousParams.p_settings, {})
        };
      }
      return undefined;
    }

    saveSupersedingDraft(entityType, entityId, payload, baseRevision, rpcName, pendingKey) {
      let supersedesOperation = null;
      if (this.draftStorage) {
        const pendingRaw = this.draftStorage.getItem(`monthly_v7_pending:${pendingKey}`);
        if (pendingRaw !== null) {
          try {
            let pending = JSON.parse(pendingRaw);
            const previousParams = this.validatePendingEnvelope(pending);
            pending = this.bindPendingActor(rpcName, pending, previousParams);
            const pendingPayload = this.pendingEntityPayload(rpcName, previousParams, entityId);
            const isActualSuccessor = rpcName === 'monthly_v7_save_module_batch'
              || this.operationCanonical(payload) !== this.operationCanonical(pendingPayload);
            if (pending.actorUserId && isActualSuccessor
              && this.pendingTargetsEntity(rpcName, pendingKey, previousParams, entityType, entityId)) {
              supersedesOperation = {
                rpcName, pendingKey,
                operationId: pending.operationId,
                signature: pending.signature
              };
            }
          } catch (_error) {
            supersedesOperation = null;
          }
        }
      }
      this.saveDraft(entityType, entityId, payload, baseRevision, { supersedesOperation });
      return supersedesOperation;
    }

    async reconcileSupersededPending(rpcName, pendingKey, targets) {
      if (!this.draftStorage || !Array.isArray(targets) || !targets.length) return null;
      const pendingRaw = this.draftStorage.getItem(`monthly_v7_pending:${pendingKey}`);
      if (pendingRaw === null) return null;
      let pending;
      try { pending = JSON.parse(pendingRaw); }
      catch (_error) { throw this.pendingOperationError(); }
      const previousParams = this.validatePendingEnvelope(pending);
      pending = this.bindPendingActor(rpcName, pending, previousParams);
      const markerKeys = ['operationId', 'pendingKey', 'rpcName', 'signature'];
      let hasMarker = false;
      for (const target of targets) {
        const draft = this.readDraft(target.entityType, target.entityId);
        const marker = draft && draft.supersedesOperation;
        if (!marker) continue;
        hasMarker = true;
        const actualKeys = marker && typeof marker === 'object' && !Array.isArray(marker)
          ? Object.keys(marker).sort() : [];
        if (actualKeys.length !== markerKeys.length
          || !actualKeys.every((key, index) => key === markerKeys[index])
          || marker.rpcName !== rpcName
          || marker.pendingKey !== pendingKey
          || marker.operationId !== pending.operationId
          || !this.pendingMarkerSignatureMatches(marker.signature, pending.signature)
          || this.operationCanonical(draft.payload) !== this.operationCanonical(target.payload)
          || !this.pendingTargetsEntity(rpcName, pendingKey, previousParams, target.entityType, target.entityId)) {
          throw this.pendingOperationError();
        }
      }
      if (!hasMarker) return null;
      if (targets.some((target) => {
        const draft = this.readDraft(target.entityType, target.entityId);
        return !draft || !draft.supersedesOperation;
      })) throw this.pendingOperationError();
      if (rpcName === 'monthly_v7_save_module_batch') {
        const pendingIds = (previousParams.p_changes || []).map((row) => String(row && row.moduleId || '')).sort();
        const targetIds = targets.map((target) => String(target.entityId || '')).sort();
        if (this.operationCanonical(pendingIds) !== this.operationCanonical(targetIds)) {
          throw this.pendingOperationError();
        }
      }
      for (const key of ['p_site_session_id', 'p_user_session_id', 'p_client_session_id']) {
        if (!Object.prototype.hasOwnProperty.call(previousParams, key)) continue;
        if (key === 'p_site_session_id') previousParams[key] = this.siteSession && this.siteSession.id;
        if (key === 'p_user_session_id') previousParams[key] = this.userSession && this.userSession.id;
        if (key === 'p_client_session_id') previousParams[key] = this.clientSessionId;
      }
      return {
        result: await this.executeOperation(rpcName, previousParams, pendingKey),
        previousParams
      };
    }

    async replayPendingBeforeLease(rpcName, pendingKey, desiredParams) {
      if (!this.draftStorage) return null;
      const storageKey = `monthly_v7_pending:${pendingKey}`;
      const pendingRaw = this.draftStorage.getItem(storageKey);
      if (pendingRaw === null) return null;
      let pending;
      try {
        pending = JSON.parse(pendingRaw);
      } catch (_error) {
        const error = new Error('PENDING_OPERATION_UNRESOLVED');
        error.code = 'PENDING_OPERATION_UNRESOLVED';
        throw error;
      }
      const previousParams = this.validatePendingEnvelope(pending);
      pending = this.bindPendingActor(rpcName, pending, previousParams);
      if (rpcName === 'monthly_v7_create_report_snapshot'
        && Object.prototype.hasOwnProperty.call(previousParams, 'p_kind')
        && !Object.prototype.hasOwnProperty.call(previousParams, 'p_snapshot_kind')) {
        previousParams.p_snapshot_kind = previousParams.p_kind;
        delete previousParams.p_kind;
      }
      const desiredBusiness = this.operationCanonical(this.operationBusinessParams(desiredParams));
      const previousBusiness = this.operationCanonical(this.operationBusinessParams(previousParams));
      if (desiredBusiness !== previousBusiness) {
        const error = new Error('PENDING_OPERATION_UNRESOLVED');
        error.code = 'PENDING_OPERATION_UNRESOLVED';
        throw error;
      }
      for (const key of ['p_site_session_id', 'p_user_session_id', 'p_client_session_id']) {
        if (Object.prototype.hasOwnProperty.call(desiredParams, key)) previousParams[key] = desiredParams[key];
        else delete previousParams[key];
      }
      return this.executeOperation(rpcName, previousParams, pendingKey);
    }

    async executeOperation(rpcName, params, pendingKey) {
      const storageKey = `monthly_v7_pending:${pendingKey}`;
      const signature = JSON.stringify(params);
      let pending = null;
      if (this.draftStorage) {
        const pendingRaw = this.draftStorage.getItem(storageKey);
        if (pendingRaw !== null) {
          try {
            pending = JSON.parse(pendingRaw);
          } catch (_error) {
            const error = new Error('PENDING_OPERATION_UNRESOLVED');
            error.code = 'PENDING_OPERATION_UNRESOLVED';
            throw error;
          }
          const previousParams = this.validatePendingEnvelope(pending);
          pending = this.bindPendingActor(rpcName, pending, previousParams);
        }
      }
      pending = this.migratePendingOperationSignature(rpcName, params, pendingKey, pending, signature);
      const currentActorId = String((this.currentUser() && this.currentUser().id) || '');
      if (pending && pending.actorUserId && pending.actorUserId !== currentActorId) {
        const error = new Error('PENDING_OPERATION_ACTOR_MISMATCH');
        error.code = 'PENDING_OPERATION_ACTOR_MISMATCH';
        throw error;
      }
      const operationParams = pending && pending.replayParams ? pending.replayParams : params;
      const operationSignature = JSON.stringify(operationParams);
      if (pending && pending.signature !== operationSignature) {
        const error = new Error('PENDING_OPERATION_UNRESOLVED');
        error.code = 'PENDING_OPERATION_UNRESOLVED';
        throw error;
      }
      const operationId = pending && pending.operationId ? pending.operationId : this.operationIdFactory();
      const storedEnvelope = { operationId, signature: operationSignature, createdAt: new Date().toISOString() };
      if (pending && pending.actorUserId) storedEnvelope.actorUserId = pending.actorUserId;
      else if (!pending && currentActorId) storedEnvelope.actorUserId = currentActorId;
      if (this.draftStorage) this.draftStorage.setItem(storageKey, JSON.stringify(storedEnvelope));
      const request = Object.assign({}, operationParams, { p_operation_id: operationId });
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await this.rpc(rpcName, request);
          const preserveMismatch = result && result.ok === false && result.error === 'IDEMPOTENCY_MISMATCH';
          if (this.draftStorage && !preserveMismatch) this.draftStorage.removeItem(storageKey);
          return result;
        } catch (error) {
          lastError = error;
          if (this.sessionErrorCode(error) || error?.code === 'STALE_SESSION_RESPONSE') throw error;
        }
      }
      throw lastError;
    }

    async saveModule(item) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'save_module');
      const entityId = item && item._v7Id;
      if (!entityId || !Number.isFinite(Number(item && item._v7Revision))) {
        throw new TypeError('V7 module identity/revision is required');
      }
      const pendingKey = `save_module:${entityId}`;
      const supersededLease = this.getLease('module', entityId);
      const superseded = await this.reconcileSupersededPending(
        'monthly_v7_save_module', pendingKey,
        [{ entityType: 'module', entityId, payload: this.modulePayload(item) }]
      );
      this.assertSessionContext(operationContext, 'save_module');
      if (superseded) {
        const priorResult = superseded.result;
        if (priorResult && priorResult.ok === true) {
          item._v7Revision = Number(priorResult.revision);
          this.watermark = Math.max(this.watermark, Number(priorResult.watermark || 0));
          const row = this.snapshot && (this.snapshot.modules || [])
            .find((entry) => String(entry.id) === String(entityId));
          if (row) {
            row.revision = Number(priorResult.revision);
            row.payload = this.cloneJson(superseded.previousParams.p_payload, {});
          }
        } else if (priorResult && priorResult.error === 'LEASE_LOST') {
          this.forgetCapturedLease(supersededLease);
        } else {
          const code = priorResult && priorResult.error || 'SAVE_FAILED';
          const error = new Error(code);
          error.code = code;
          error.result = priorResult;
          if (typeof this.host.onConflict === 'function') {
            this.host.onConflict({
              entityType: 'module', entityId, draft: this.modulePayload(item), result: priorResult
            });
          }
          throw error;
        }
      }
      const expectedRevision = Number(item && item._v7Revision);
      const payload = this.modulePayload(item);
      this.saveDraft('module', entityId, payload, expectedRevision);
      const desiredParams = {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_module_id: entityId,
        p_expected_revision: expectedRevision,
        p_payload: payload
      };
      let operationLease = null;
      let replayLease = null;
      const fail = async (result, releaseCurrent = false) => {
        const code = result && result.error || 'SAVE_FAILED';
        if (releaseCurrent) {
          await this.releaseCapturedLease(operationLease || replayLease || supersededLease, operationContext);
          this.assertSessionContext(operationContext, 'save_module_cleanup');
        } else if (['LEASE_LOST', 'REVISION_CONFLICT', 'AUTHORITY_CHANGED'].includes(code)) {
          this.forgetCapturedLease(operationLease);
        }
        const error = new Error(code);
        error.code = code;
        error.result = result;
        if (typeof this.host.onConflict === 'function') this.host.onConflict({ entityType: 'module', entityId, draft: payload, result });
        throw error;
      };
      const complete = async (result, releaseCurrent = false) => {
        if (releaseCurrent) {
          await this.releaseCapturedLease(operationLease || replayLease || supersededLease, operationContext);
          this.assertSessionContext(operationContext, 'save_module_cleanup');
        }
        this.assertSessionContext(operationContext, 'save_module');
        item._v7Revision = Number(result.revision);
        this.watermark = Math.max(this.watermark, Number(result.watermark || 0));
        this.clearDraft('module', entityId);
        if (typeof this.host.onItemSaved === 'function') this.host.onItemSaved({ entityType: 'module', entityId, revision: item._v7Revision });
        return result;
      };

      replayLease = this.getLease('module', entityId);
      const replayed = await this.replayPendingBeforeLease('monthly_v7_save_module', pendingKey, desiredParams);
      this.assertSessionContext(operationContext, 'save_module');
      if (replayed) {
        if (replayed.ok === true) return complete(replayed, false);
        if (replayed.error !== 'LEASE_LOST') return fail(replayed, true);
        this.forgetCapturedLease(replayLease);
      }

      operationLease = this.getLease('module', entityId) || await this.claimLease('module', entityId);
      this.assertSessionContext(operationContext, 'save_module');
      const result = await this.executeOperation('monthly_v7_save_module', Object.assign({}, desiredParams, {
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken
      }), pendingKey);
      this.assertSessionContext(operationContext, 'save_module');
      if (!result || result.ok !== true) return fail(result, false);
      return complete(result, false);
    }

    async saveReportMeta(meta) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'save_report_meta');
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const pendingKey = `save_report_meta:${report.id}`;
      const payload = {
        title: String(meta && meta.title || report.title || ''),
        date: String(meta && meta.date || report.date || ''),
        period: JSON.parse(JSON.stringify(meta && meta.period || report.period || {})),
        settings: JSON.parse(JSON.stringify(meta && meta.settings || report.settings || {}))
      };
      const supersededLease = this.getLease('report_meta', report.id);
      const superseded = await this.reconcileSupersededPending(
        'monthly_v7_save_report_meta', pendingKey,
        [{ entityType: 'report_meta', entityId: report.id, payload }]
      );
      this.assertSessionContext(operationContext, 'save_report_meta');
      if (superseded) {
        const priorResult = superseded.result;
        if (priorResult && priorResult.ok === true) {
          report.revision = Number(priorResult.revision);
          report.title = String(superseded.previousParams.p_title || '');
          report.date = String(superseded.previousParams.p_report_date || '');
          report.period = this.cloneJson(superseded.previousParams.p_period, {});
          report.settings = this.cloneJson(superseded.previousParams.p_settings, {});
          this.watermark = Math.max(this.watermark, Number(priorResult.watermark || 0));
          this.forgetCapturedLease(supersededLease);
        } else if (priorResult && priorResult.error === 'LEASE_LOST') {
          this.forgetCapturedLease(supersededLease);
        } else {
          return this.commandResult(priorResult, 'SAVE_REPORT_META_FAILED');
        }
      }
      this.saveDraft('report_meta', report.id, payload, Number(report.revision));
      const desiredParams = {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_report_id: report.id,
        p_expected_revision: Number(report.revision),
        p_title: payload.title,
        p_report_date: payload.date,
        p_period: payload.period,
        p_settings: payload.settings
      };
      let replayLease = null;
      let operationLease = null;
      const complete = async (result, releaseCurrent = false) => {
        if (releaseCurrent) {
          await this.releaseCapturedLease(operationLease || replayLease || supersededLease, operationContext);
          this.assertSessionContext(operationContext, 'save_report_meta_cleanup');
        } else {
          this.forgetCapturedLease(operationLease);
        }
        this.assertSessionContext(operationContext, 'save_report_meta');
        report.revision = Number(result.revision);
        Object.assign(report, payload);
        this.clearDraft('report_meta', report.id);
        return result;
      };
      replayLease = this.getLease('report_meta', report.id);
      const replayed = await this.replayPendingBeforeLease('monthly_v7_save_report_meta', pendingKey, desiredParams);
      this.assertSessionContext(operationContext, 'save_report_meta');
      if (replayed) {
        if (replayed.ok === true) return complete(this.commandResult(replayed, 'SAVE_REPORT_META_FAILED'), true);
        if (replayed.error !== 'LEASE_LOST') {
          await this.releaseCapturedLease(replayLease, operationContext);
          this.assertSessionContext(operationContext, 'save_report_meta_cleanup');
          return this.commandResult(replayed, 'SAVE_REPORT_META_FAILED');
        }
        this.forgetCapturedLease(replayLease);
      }
      operationLease = this.getLease('report_meta', report.id) || await this.claimLease('report_meta', report.id);
      this.assertSessionContext(operationContext, 'save_report_meta');
      const result = this.commandResult(await this.executeOperation('monthly_v7_save_report_meta', Object.assign({}, desiredParams, {
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken
      }), pendingKey), 'SAVE_REPORT_META_FAILED');
      this.assertSessionContext(operationContext, 'save_report_meta');
      return complete(result, false);
    }

    async createModule(payload) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'create_module');
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const operationLease = this.getLease('report_structure', report.id) || await this.claimLease('report_structure', report.id);
      this.assertSessionContext(operationContext, 'create_module');
      const cleanPayload = this.modulePayload(payload || {});
      const result = this.commandResult(await this.executeOperation('monthly_v7_create_module', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_report_id: report.id,
        p_expected_report_revision: Number(report.revision),
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken,
        p_payload: cleanPayload
      }, `create_module:${report.id}`), 'CREATE_MODULE_FAILED');
      this.assertSessionContext(operationContext, 'create_module');
      report.revision = Number(result.reportRevision ?? result.report_revision);
      this.forgetCapturedLease(operationLease);
      const item = Object.assign({}, cleanPayload, {
        _v7Id: result.entityId || result.entity_id,
        _v7Revision: Number(result.revision)
      });
      if (typeof this.host.onModuleCreated === 'function') this.host.onModuleCreated(item);
      return item;
    }

    async reorderModules(items) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'reorder_modules');
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const order = (items || []).map((item) => item && item._v7Id);
      if (!order.length || order.some((id) => !id)) throw new TypeError('all modules require V7 IDs');
      const operationLease = this.getLease('report_structure', report.id) || await this.claimLease('report_structure', report.id);
      this.assertSessionContext(operationContext, 'reorder_modules');
      const result = this.commandResult(await this.executeOperation('monthly_v7_reorder_modules', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_report_id: report.id,
        p_expected_report_revision: Number(report.revision),
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken,
        p_order: order
      }, `reorder_modules:${report.id}`), 'REORDER_MODULES_FAILED');
      this.assertSessionContext(operationContext, 'reorder_modules');
      report.revision = Number(result.reportRevision ?? result.report_revision);
      this.forgetCapturedLease(operationLease);
      return result;
    }

    async saveModuleBatch(items) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'save_module_batch');
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      let saveItems = Array.isArray(items) ? items.slice() : [];
      if (!saveItems.length || saveItems.some((item) => !item || !item._v7Id
        || !Number.isFinite(Number(item._v7Revision)))) {
        throw new TypeError('batch modules require V7 identities/revisions');
      }
      const pendingKey = `save_module_batch:${report.id}`;
      const supersededLease = this.getLease('kpi_batch', report.id);
      const superseded = await this.reconcileSupersededPending(
        'monthly_v7_save_module_batch', pendingKey,
        saveItems.map((item) => ({
          entityType: 'module', entityId: item._v7Id, payload: this.modulePayload(item)
        }))
      );
      this.assertSessionContext(operationContext, 'save_module_batch');
      if (superseded) {
        const priorResult = superseded.result;
        if (priorResult && priorResult.ok === true) {
          const priorUpdates = new Map((priorResult.updated || [])
            .map((row) => [String(row.entityId || row.entity_id), Number(row.revision)]));
          const priorPayloads = new Map((superseded.previousParams.p_changes || [])
            .map((row) => [String(row.moduleId), this.cloneJson(row.payload, {})]));
          for (const item of saveItems) {
            const id = String(item._v7Id);
            if (priorUpdates.has(id)) item._v7Revision = priorUpdates.get(id);
            const row = this.snapshot && (this.snapshot.modules || [])
              .find((entry) => String(entry.id) === id);
            if (row && priorPayloads.has(id)) {
              row.revision = Number(item._v7Revision);
              row.payload = this.cloneJson(priorPayloads.get(id), {});
            }
          }
          this.watermark = Math.max(this.watermark, Number(priorResult.watermark || 0));
          saveItems = saveItems.filter((item) => {
            const confirmed = priorPayloads.get(String(item._v7Id));
            const changed = this.operationCanonical(this.modulePayload(item))
              !== this.operationCanonical(confirmed);
            if (!changed) this.clearDraft('module', item._v7Id);
            return changed;
          });
          if (!saveItems.length) return priorResult;
        } else if (priorResult && priorResult.error === 'LEASE_LOST') {
          this.forgetCapturedLease(supersededLease);
        } else {
          return this.commandResult(priorResult, 'SAVE_MODULE_BATCH_FAILED');
        }
      }
      const changes = saveItems.map((item) => ({
        moduleId: item && item._v7Id,
        expectedRevision: Number(item && item._v7Revision),
        payload: this.modulePayload(item)
      }));
      changes.forEach((row) => this.saveDraft('module', row.moduleId, row.payload, row.expectedRevision));
      const desiredParams = {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_report_id: report.id,
        p_changes: changes
      };
      let result;
      let replayLease = null;
      let operationLease = null;
      try {
        replayLease = this.getLease('kpi_batch', report.id);
        const replayed = await this.replayPendingBeforeLease('monthly_v7_save_module_batch', pendingKey, desiredParams);
        this.assertSessionContext(operationContext, 'save_module_batch');
        if (replayed) {
          if (replayed.ok === true) {
            result = this.commandResult(replayed, 'SAVE_MODULE_BATCH_FAILED');
          } else if (replayed.error !== 'LEASE_LOST') {
            result = this.commandResult(replayed, 'SAVE_MODULE_BATCH_FAILED');
          } else {
            this.forgetCapturedLease(replayLease);
          }
        }
        if (!result) {
          this.assertSessionContext(operationContext, 'save_module_batch');
          operationLease = this.getLease('kpi_batch', report.id) || await this.claimLease('kpi_batch', report.id);
          this.assertSessionContext(operationContext, 'save_module_batch');
          result = this.commandResult(await this.executeOperation('monthly_v7_save_module_batch', Object.assign({}, desiredParams, {
            p_lease_id: operationLease.leaseId,
            p_fencing_token: operationLease.fencingToken
          }), pendingKey), 'SAVE_MODULE_BATCH_FAILED');
          this.assertSessionContext(operationContext, 'save_module_batch');
        }
      } catch (error) {
        await this.releaseCapturedLease(operationLease, operationContext);
        if (['REVISION_CONFLICT', 'LEASE_LOST', 'AUTHORITY_CHANGED'].includes(error.code)
          && typeof this.host.onConflict === 'function') {
          this.host.onConflict({
            entityType: 'module_batch',
            entityId: error.result && (error.result.entityId || error.result.entity_id),
            drafts: changes,
            result: error.result
          });
        }
        throw error;
      }
      const updates = new Map((result.updated || []).map((row) => [row.entityId || row.entity_id, Number(row.revision)]));
      (items || []).forEach((item) => {
        if (updates.has(item._v7Id)) item._v7Revision = updates.get(item._v7Id);
        this.clearDraft('module', item._v7Id);
      });
      // Persistence acknowledgement (including same-operation COMMITTED replay)
      // does not end the aggregate edit session.  The exact captured lease stays
      // registered until an explicit editor exit, actor switch, or valid logout.
      return result;
    }

    async deleteModule(item) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'delete_module');
      const report = this.currentReport();
      const entityId = item && item._v7Id;
      const expectedRevision = Number(item && item._v7Revision);
      if (!report || !report.id || !entityId || !Number.isFinite(expectedRevision)) throw new TypeError('module/report V7 context is required');
      this.saveDraft('module', entityId, { deleteRequested: true, previous: this.modulePayload(item) }, expectedRevision);
      let structureLease;
      let moduleLease;
      try {
        // Structure first gives all structure-changing commands one deterministic lock order.
        structureLease = this.getLease('report_structure', report.id) || await this.claimLease('report_structure', report.id);
        this.assertSessionContext(operationContext, 'delete_module');
        moduleLease = this.getLease('module', entityId) || await this.claimLease('module', entityId);
        this.assertSessionContext(operationContext, 'delete_module');
        const result = this.commandResult(await this.executeOperation('monthly_v7_delete_module', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: operationContext.userSessionId,
          p_client_session_id: operationContext.clientSessionId,
          p_module_id: entityId,
          p_expected_module_revision: expectedRevision,
          p_expected_report_revision: Number(report.revision),
          p_structure_lease_id: structureLease.leaseId,
          p_structure_fencing_token: structureLease.fencingToken,
          p_module_lease_id: moduleLease.leaseId,
          p_module_fencing_token: moduleLease.fencingToken
        }, `delete_module:${entityId}`), 'DELETE_MODULE_FAILED');
        this.assertSessionContext(operationContext, 'delete_module');
        report.revision = Number(result.reportRevision ?? result.report_revision);
        const structureKey = this.leaseKey('report_structure', report.id);
        const moduleKey = this.leaseKey('module', entityId);
        if (this.leases.get(structureKey) === structureLease) this.leases.delete(structureKey);
        if (this.leases.get(moduleKey) === moduleLease) this.leases.delete(moduleKey);
        this.clearDraft('module', entityId);
        if (typeof this.host.onModuleDeleted === 'function') this.host.onModuleDeleted(entityId);
        return result;
      } catch (error) {
        await Promise.allSettled([
          this.releaseCapturedLease(moduleLease, operationContext),
          this.releaseCapturedLease(structureLease, operationContext)
        ]);
        throw error;
      }
    }

    commandResult(result, fallbackCode) {
      if (result && result.ok === true) {
        this.watermark = Math.max(this.watermark, Number(result.watermark || 0));
        return result;
      }
      const code = result && result.error || fallbackCode;
      const error = new Error(code);
      error.code = code;
      error.result = result;
      throw error;
    }

    async createRecord(recordType, payload) {
      this.requireUserSession();
      const cleanPayload = JSON.parse(JSON.stringify(payload || {}));
      const result = this.commandResult(await this.executeOperation('monthly_v7_create_record', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_record_type: recordType,
        p_payload: cleanPayload
      }, `create_record:${recordType}`), 'CREATE_RECORD_FAILED');
      const record = Object.assign({}, cleanPayload, {
        _v7Id: result.entityId || result.entity_id,
        _v7Revision: Number(result.revision)
      });
      if (typeof this.host.onRecordCreated === 'function') this.host.onRecordCreated(recordType, record);
      return record;
    }

    recordPayload(record) {
      const payload = JSON.parse(JSON.stringify(record || {}));
      delete payload._v7Id;
      delete payload._v7Revision;
      return payload;
    }

    async saveRecord(recordType, record) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'save_record');
      const entityId = record && record._v7Id;
      const expectedRevision = Number(record && record._v7Revision);
      if (!entityId || !Number.isFinite(expectedRevision)) throw new TypeError('V7 record identity/revision is required');
      const entityType = `record:${recordType}`;
      const payload = this.recordPayload(record);
      this.saveDraft(entityType, entityId, payload, expectedRevision);
      const operationLease = this.getLease(entityType, entityId) || await this.claimLease(entityType, entityId);
      this.assertSessionContext(operationContext, 'save_record');
      let result;
      try {
        result = this.commandResult(await this.executeOperation('monthly_v7_save_record', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: operationContext.userSessionId,
          p_client_session_id: operationContext.clientSessionId,
          p_record_id: entityId,
          p_expected_revision: expectedRevision,
          p_lease_id: operationLease.leaseId,
          p_fencing_token: operationLease.fencingToken,
          p_payload: payload
        }, `save_record:${entityId}`), 'SAVE_RECORD_FAILED');
        this.assertSessionContext(operationContext, 'save_record');
      } catch (error) {
        if (['LEASE_LOST', 'REVISION_CONFLICT', 'AUTHORITY_CHANGED'].includes(error.code)) {
          this.forgetCapturedLease(operationLease);
        }
        if (this.isSessionContextCurrent(operationContext) && typeof this.host.onConflict === 'function') {
          this.host.onConflict({ entityType, entityId, draft: payload, result: error.result });
        }
        throw error;
      }
      record._v7Revision = Number(result.revision);
      this.forgetCapturedLease(operationLease);
      this.clearDraft(entityType, entityId);
      if (typeof this.host.onItemSaved === 'function') this.host.onItemSaved({ entityType, entityId, revision: record._v7Revision });
      return result;
    }

    async deleteRecord(recordType, record) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'delete_record');
      const entityId = record && record._v7Id;
      const expectedRevision = Number(record && record._v7Revision);
      if (!entityId || !Number.isFinite(expectedRevision)) throw new TypeError('V7 record identity/revision is required');
      const entityType = `record:${recordType}`;
      this.saveDraft(entityType, entityId, { deleteRequested: true, previous: this.recordPayload(record) }, expectedRevision);
      const operationLease = this.getLease(entityType, entityId) || await this.claimLease(entityType, entityId);
      this.assertSessionContext(operationContext, 'delete_record');
      const result = this.commandResult(await this.executeOperation('monthly_v7_delete_record', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_record_id: entityId,
        p_expected_revision: expectedRevision,
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken
      }, `delete_record:${entityId}`), 'DELETE_RECORD_FAILED');
      this.assertSessionContext(operationContext, 'delete_record');
      this.forgetCapturedLease(operationLease);
      this.clearDraft(entityType, entityId);
      if (typeof this.host.onRecordDeleted === 'function') this.host.onRecordDeleted(recordType, entityId);
      return result;
    }

    async createUser(profile) {
      this.requireUserSession();
      const result = this.commandResult(await this.executeOperation('monthly_v7_create_user', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_username: String(profile && profile.username || '').trim(),
        p_display_name: String(profile && profile.displayName || profile && profile.username || '').trim(),
        p_role: String(profile && profile.role || 'operator'),
        p_password: String(profile && profile.password || '')
      }, `create_user:${String(profile && profile.username || '').trim()}`), 'CREATE_USER_FAILED');
      if (typeof this.host.onUsersChanged === 'function') this.host.onUsersChanged(result.user);
      return result.user;
    }

    async updateUser(targetUserId, profile) {
      this.requireUserSession();
      const result = this.commandResult(await this.executeOperation('monthly_v7_update_user', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_target_user_id: targetUserId,
        p_username: String(profile && profile.username || '').trim(),
        p_display_name: String(profile && profile.displayName || profile && profile.username || '').trim(),
        p_role: String(profile && profile.role || 'operator'),
        p_new_password: profile && profile.password ? String(profile.password) : null
      }, `update_user:${targetUserId}`), 'UPDATE_USER_FAILED');
      if (typeof this.host.onUsersChanged === 'function') this.host.onUsersChanged(result.user);
      return result.user;
    }

    async deleteUser(targetUserId) {
      this.requireUserSession();
      const result = this.commandResult(await this.executeOperation('monthly_v7_delete_user', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_target_user_id: targetUserId
      }, `delete_user:${targetUserId}`), 'DELETE_USER_FAILED');
      if (typeof this.host.onUsersChanged === 'function') this.host.onUsersChanged(null, targetUserId);
      return result;
    }

    async createReportSnapshot(kind = 'pdf') {
      this.requireUserSession();
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      return this.commandResult(await this.executeOperation('monthly_v7_create_report_snapshot', {
        p_workspace_key: this.config.workspaceKey,
        p_site_session_id: this.siteSession.id,
        p_user_session_id: this.userSession.id,
        p_report_id: report.id,
        p_snapshot_kind: kind
      }, `create_snapshot:${report.id}:${kind}`), 'CREATE_SNAPSHOT_FAILED');
    }

    async updateSitePassword(newPassword) {
      this.requireUserSession();
      const result = this.commandResult(await this.executeOperation('monthly_v7_update_site_password', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_new_password: String(newPassword || '')
      }, `update_site_password:${this.config.workspaceKey}`), 'UPDATE_SITE_PASSWORD_FAILED');
      this.clearSessions();
      return result;
    }

    async getEntity(entityType, entityId) {
      this.requireUserSession();
      const entity = await this.rpc('monthly_v7_get_entity', {
        p_workspace_key: this.config.workspaceKey,
        p_site_session_id: this.siteSession.id,
        p_user_session_id: this.userSession.id,
        p_entity_type: entityType,
        p_entity_id: entityId
      });
      if (!entity || entity.ok !== true) {
        const code = entity && entity.error || 'ENTITY_READ_FAILED';
        const error = new Error(code);
        error.code = code;
        error.result = entity;
        throw error;
      }
      return entity;
    }

    async catchUp() {
      this.requireUserSession();
      let pageCount = 0;
      let lastResult = { watermark: this.watermark, events: [], hasMore: false };
      do {
        const raw = await this.rpc('monthly_v7_get_changes_since', {
          p_workspace_key: this.config.workspaceKey,
          p_site_session_id: this.siteSession.id,
          p_user_session_id: this.userSession.id,
          p_after_sequence: this.watermark,
          p_limit: 200
        });
        if (!raw || raw.ok !== true) throw new Error(raw && raw.error || 'CATCH_UP_FAILED');
        const reduced = this.core.reduceChangeEvents(this.watermark, raw.events || []);
        const latestByEntity = new Map();
        for (const event of reduced.events) {
          const type = event.entityType || event.entity_type;
          const id = event.entityId || event.entity_id;
          latestByEntity.set(this.leaseKey(type, id), { type, id, event });
        }
        let requiresFullSnapshot = false;
        for (const value of latestByEntity.values()) {
          if (!(value.type === 'module' || value.type === 'report_meta' || value.type.startsWith('record:'))) {
            requiresFullSnapshot = true;
            continue;
          }
          const entity = await this.rpc('monthly_v7_get_entity', {
            p_workspace_key: this.config.workspaceKey,
            p_site_session_id: this.siteSession.id,
            p_user_session_id: this.userSession.id,
            p_entity_type: value.type,
            p_entity_id: value.id
          });
          const hasLocalIntent = !!this.getLease(value.type, value.id) || !!(this.draftStorage && this.draftStorage.getItem(this.draftKey(value.type, value.id)));
          if (hasLocalIntent) {
            if (typeof this.host.onRemoteChangeWhileEditing === 'function') this.host.onRemoteChangeWhileEditing(entity, value.event);
          } else if (typeof this.host.applyEntity === 'function') {
            await this.host.applyEntity(entity, value.event);
          }
        }
        this.watermark = Math.max(this.watermark, Number(raw.watermark || reduced.watermark || 0));
        lastResult = { watermark: this.watermark, events: reduced.events, hasMore: raw.hasMore === true || raw.has_more === true };
        if (requiresFullSnapshot) await this.loadSnapshot();
        pageCount += 1;
        if (pageCount >= 10 && lastResult.hasMore) throw new Error('CATCH_UP_PAGE_LIMIT');
      } while (lastResult.hasMore);
      return lastResult;
    }

    startRealtime() {
      this.stopRealtime();
      if (!this.userSession || typeof this.transport.subscribe !== 'function') return null;
      const workspaceId = this.snapshot && this.snapshot.workspace && this.snapshot.workspace.id;
      if (!workspaceId) return null;
      this.realtimeUnsubscribe = this.transport.subscribe(workspaceId, () => {
        this.catchUp().catch((error) => {
          if (typeof this.host.onTransportError === 'function') this.host.onTransportError(error);
        });
      });
      return this.realtimeUnsubscribe;
    }

    stopRealtime() {
      if (typeof this.realtimeUnsubscribe === 'function') this.realtimeUnsubscribe();
      this.realtimeUnsubscribe = null;
    }

    async logoutUser() {
      const operationContext = this.captureSessionContext();
      try {
        if (this.isActive() && operationContext.userSessionId) {
          const result = await this.rpc('monthly_v7_logout_user', {
            p_workspace_key: this.config.workspaceKey,
            p_site_session_id: operationContext.siteSessionId || null,
            p_user_session_id: operationContext.userSessionId
          });
          this.assertSessionContext(operationContext, 'logout_user');
          this.commandResult(result, 'USER_LOGOUT_FAILED');
        }
      } finally {
        if (this.isSessionContextCurrent(operationContext)) this.clearUserSession('user-logout');
      }
    }

    async logout() {
      const operationContext = this.captureSessionContext();
      try {
        if (this.isActive() && operationContext.siteSessionId) {
          await this.rpc('monthly_v7_logout', {
            p_workspace_key: this.config.workspaceKey,
            p_site_session_id: operationContext.siteSessionId,
            p_user_session_id: operationContext.userSessionId || null
          });
          this.assertSessionContext(operationContext, 'logout_site');
        }
      } finally {
        if (this.isSessionContextCurrent(operationContext)) this.clearSessions('site-logout');
      }
    }

    clearUserSession(reason = '', code = '') {
      this.stopHeartbeat();
      this.stopRealtime();
      this.userSession = null;
      this.user = null;
      this.leases.clear();
      if (this.sessionStorage) {
        this.sessionStorage.removeItem('monthly_v7_user_session');
        this.sessionStorage.removeItem('monthly_v7_user_projection');
      }
      if (reason) this.notifySessionStateChanged(reason, code);
    }

    clearSessions(reason = '', code = '') {
      this.clearUserSession();
      this.siteSession = null;
      if (this.sessionStorage) {
        this.sessionStorage.removeItem('monthly_v7_site_session');
      }
      if (reason) this.notifySessionStateChanged(reason, code);
    }
  }

  return Object.freeze({ MonthlyV7Client });
});
