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
    }

    async initialize(config) {
      this.config = Object.assign({}, config || {});
      if (!String(this.config.workspaceKey || '').trim()) throw new Error('workspaceKey is required');
      if (typeof this.transport.ensureAnonymous === 'function') await this.transport.ensureAnonymous(this.config);
      const raw = await this.transport.rpc('monthly_v7_get_status', { p_workspace_key: this.config.workspaceKey });
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
    currentUser() { return this.user ? Object.assign({}, this.user) : null; }

    async openSite(password) {
      if (!this.isActive()) throw new Error('V7 authority is not active');
      const result = await this.transport.rpc('monthly_v7_open_site', {
        p_workspace_key: this.config.workspaceKey,
        p_password: String(password || ''),
        p_client_session_id: this.clientSessionId
      });
      if (!result || result.ok !== true) throw new Error(result && result.error || 'SITE_LOGIN_FAILED');
      this.siteSession = { id: result.site_session_id || result.siteSessionId, expiresAt: result.expires_at || result.expiresAt || '' };
      if (this.sessionStorage) this.sessionStorage.setItem('monthly_v7_site_session', JSON.stringify(this.siteSession));
      return Object.assign({}, this.siteSession);
    }

    async login(username, password) {
      if (!this.isSiteUnlocked()) throw new Error('SITE_SESSION_REQUIRED');
      const result = await this.transport.rpc('monthly_v7_login_user', {
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
      const previous = this.snapshot;
      if (!previous) return incoming;
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
      const snapshot = await this.transport.rpc('monthly_v7_get_snapshot', {
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
      const raw = await this.transport.rpc('monthly_v7_claim_lease', {
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
      const lease = this.getLease(entityType, entityId);
      if (!lease) return null;
      const raw = await this.transport.rpc('monthly_v7_renew_lease', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_entity_type: entityType,
        p_entity_id: entityId,
        p_lease_id: lease.leaseId,
        p_fencing_token: lease.fencingToken,
        p_ttl_seconds: ttlSeconds
      });
      if (!raw || raw.ok !== true) {
        this.leases.delete(this.leaseKey(entityType, entityId));
        if (typeof this.host.onLeaseLost === 'function') this.host.onLeaseLost({ entityType, entityId, lease, result: raw });
        return null;
      }
      const renewed = this.normalizeLease(raw);
      this.leases.set(this.leaseKey(entityType, entityId), renewed);
      return renewed;
    }

    async releaseLease(entityType, entityId) {
      const lease = this.getLease(entityType, entityId);
      if (!lease) return true;
      try {
        const raw = await this.transport.rpc('monthly_v7_release_lease', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: this.userSession.id,
          p_client_session_id: this.clientSessionId,
          p_entity_type: entityType,
          p_entity_id: entityId,
          p_lease_id: lease.leaseId,
          p_fencing_token: lease.fencingToken
        });
        return !!(raw && raw.ok);
      } finally {
        this.leases.delete(this.leaseKey(entityType, entityId));
      }
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

    saveDraft(entityType, entityId, payload, baseRevision) {
      if (!this.draftStorage) return;
      this.draftStorage.setItem(this.draftKey(entityType, entityId), JSON.stringify({
        entityType, entityId, baseRevision: Number(baseRevision || 0), payload,
        savedAt: new Date().toISOString()
      }));
    }

    clearDraft(entityType, entityId) {
      if (this.draftStorage) this.draftStorage.removeItem(this.draftKey(entityType, entityId));
    }

    modulePayload(item) {
      const payload = JSON.parse(JSON.stringify(item || {}));
      delete payload._v7Id;
      delete payload._v7Revision;
      return payload;
    }

    async executeOperation(rpcName, params, pendingKey) {
      const storageKey = `monthly_v7_pending:${pendingKey}`;
      const signature = JSON.stringify(params);
      let pending = null;
      if (this.draftStorage) {
        try { pending = JSON.parse(this.draftStorage.getItem(storageKey) || 'null'); } catch { pending = null; }
      }
      if (pending && pending.signature !== signature) {
        const error = new Error('PENDING_OPERATION_UNRESOLVED');
        error.code = 'PENDING_OPERATION_UNRESOLVED';
        throw error;
      }
      const operationId = pending && pending.operationId ? pending.operationId : this.operationIdFactory();
      if (this.draftStorage) this.draftStorage.setItem(storageKey, JSON.stringify({ operationId, signature, createdAt: new Date().toISOString() }));
      const request = Object.assign({}, params, { p_operation_id: operationId });
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await this.transport.rpc(rpcName, request);
          if (this.draftStorage) this.draftStorage.removeItem(storageKey);
          return result;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }

    async saveModule(item) {
      this.requireUserSession();
      const entityId = item && item._v7Id;
      const expectedRevision = Number(item && item._v7Revision);
      if (!entityId || !Number.isFinite(expectedRevision)) throw new TypeError('V7 module identity/revision is required');
      const payload = this.modulePayload(item);
      this.saveDraft('module', entityId, payload, expectedRevision);
      const lease = this.getLease('module', entityId) || await this.claimLease('module', entityId);
      const result = await this.executeOperation('monthly_v7_save_module', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_module_id: entityId,
        p_expected_revision: expectedRevision,
        p_lease_id: lease.leaseId,
        p_fencing_token: lease.fencingToken,
        p_payload: payload
      }, `save_module:${entityId}`);
      if (!result || result.ok !== true) {
        const code = result && result.error || 'SAVE_FAILED';
        if (['LEASE_LOST', 'REVISION_CONFLICT', 'AUTHORITY_CHANGED'].includes(code)) this.leases.delete(this.leaseKey('module', entityId));
        const error = new Error(code);
        error.code = code;
        error.result = result;
        if (typeof this.host.onConflict === 'function') this.host.onConflict({ entityType: 'module', entityId, draft: payload, result });
        throw error;
      }
      item._v7Revision = Number(result.revision);
      this.watermark = Math.max(this.watermark, Number(result.watermark || 0));
      this.leases.delete(this.leaseKey('module', entityId));
      this.clearDraft('module', entityId);
      if (typeof this.host.onItemSaved === 'function') this.host.onItemSaved({ entityType: 'module', entityId, revision: item._v7Revision });
      return result;
    }

    async saveReportMeta(meta) {
      this.requireUserSession();
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const lease = this.getLease('report_meta', report.id) || await this.claimLease('report_meta', report.id);
      const result = this.commandResult(await this.executeOperation('monthly_v7_save_report_meta', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_report_id: report.id,
        p_expected_revision: Number(report.revision),
        p_lease_id: lease.leaseId,
        p_fencing_token: lease.fencingToken,
        p_title: String(meta && meta.title || report.title || ''),
        p_report_date: String(meta && meta.date || report.date || ''),
        p_period: JSON.parse(JSON.stringify(meta && meta.period || report.period || {})),
        p_settings: JSON.parse(JSON.stringify(meta && meta.settings || report.settings || {}))
      }, `save_report_meta:${report.id}`), 'SAVE_REPORT_META_FAILED');
      report.revision = Number(result.revision);
      Object.assign(report, meta || {});
      this.leases.delete(this.leaseKey('report_meta', report.id));
      return result;
    }

    async createModule(payload) {
      this.requireUserSession();
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const lease = this.getLease('report_structure', report.id) || await this.claimLease('report_structure', report.id);
      const cleanPayload = this.modulePayload(payload || {});
      const result = this.commandResult(await this.executeOperation('monthly_v7_create_module', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_report_id: report.id,
        p_expected_report_revision: Number(report.revision),
        p_lease_id: lease.leaseId,
        p_fencing_token: lease.fencingToken,
        p_payload: cleanPayload
      }, `create_module:${report.id}`), 'CREATE_MODULE_FAILED');
      report.revision = Number(result.reportRevision ?? result.report_revision);
      this.leases.delete(this.leaseKey('report_structure', report.id));
      const item = Object.assign({}, cleanPayload, {
        _v7Id: result.entityId || result.entity_id,
        _v7Revision: Number(result.revision)
      });
      if (typeof this.host.onModuleCreated === 'function') this.host.onModuleCreated(item);
      return item;
    }

    async reorderModules(items) {
      this.requireUserSession();
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const order = (items || []).map((item) => item && item._v7Id);
      if (!order.length || order.some((id) => !id)) throw new TypeError('all modules require V7 IDs');
      const lease = this.getLease('report_structure', report.id) || await this.claimLease('report_structure', report.id);
      const result = this.commandResult(await this.executeOperation('monthly_v7_reorder_modules', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_report_id: report.id,
        p_expected_report_revision: Number(report.revision),
        p_lease_id: lease.leaseId,
        p_fencing_token: lease.fencingToken,
        p_order: order
      }, `reorder_modules:${report.id}`), 'REORDER_MODULES_FAILED');
      report.revision = Number(result.reportRevision ?? result.report_revision);
      this.leases.delete(this.leaseKey('report_structure', report.id));
      return result;
    }

    async saveModuleBatch(items) {
      this.requireUserSession();
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const changes = (items || []).map((item) => ({
        moduleId: item && item._v7Id,
        expectedRevision: Number(item && item._v7Revision),
        payload: this.modulePayload(item)
      }));
      if (!changes.length || changes.some((row) => !row.moduleId || !Number.isFinite(row.expectedRevision))) throw new TypeError('batch modules require V7 identities/revisions');
      changes.forEach((row) => this.saveDraft('module', row.moduleId, row.payload, row.expectedRevision));
      const lease = this.getLease('kpi_batch', report.id) || await this.claimLease('kpi_batch', report.id);
      let result;
      try {
        result = this.commandResult(await this.executeOperation('monthly_v7_save_module_batch', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: this.userSession.id,
          p_client_session_id: this.clientSessionId,
          p_report_id: report.id,
          p_lease_id: lease.leaseId,
          p_fencing_token: lease.fencingToken,
          p_changes: changes
        }, `save_module_batch:${report.id}`), 'SAVE_MODULE_BATCH_FAILED');
      } catch (error) {
        this.leases.delete(this.leaseKey('kpi_batch', report.id));
        throw error;
      }
      const updates = new Map((result.updated || []).map((row) => [row.entityId || row.entity_id, Number(row.revision)]));
      (items || []).forEach((item) => {
        if (updates.has(item._v7Id)) item._v7Revision = updates.get(item._v7Id);
        this.clearDraft('module', item._v7Id);
      });
      this.leases.delete(this.leaseKey('kpi_batch', report.id));
      // The batch RPC atomically expires its kpi_batch lease, but each editor may
      // still hold an independently claimed module lease. Release those server
      // leases after the committed batch so another editor need not wait for TTL.
      await Promise.allSettled(changes.map((row) => this.releaseLease('module', row.moduleId)));
      return result;
    }

    async deleteModule(item) {
      this.requireUserSession();
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
        moduleLease = this.getLease('module', entityId) || await this.claimLease('module', entityId);
        const result = this.commandResult(await this.executeOperation('monthly_v7_delete_module', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: this.userSession.id,
          p_client_session_id: this.clientSessionId,
          p_module_id: entityId,
          p_expected_module_revision: expectedRevision,
          p_expected_report_revision: Number(report.revision),
          p_structure_lease_id: structureLease.leaseId,
          p_structure_fencing_token: structureLease.fencingToken,
          p_module_lease_id: moduleLease.leaseId,
          p_module_fencing_token: moduleLease.fencingToken
        }, `delete_module:${entityId}`), 'DELETE_MODULE_FAILED');
        report.revision = Number(result.reportRevision ?? result.report_revision);
        this.leases.delete(this.leaseKey('report_structure', report.id));
        this.leases.delete(this.leaseKey('module', entityId));
        this.clearDraft('module', entityId);
        if (typeof this.host.onModuleDeleted === 'function') this.host.onModuleDeleted(entityId);
        return result;
      } catch (error) {
        await Promise.allSettled([
          this.releaseLease('module', entityId),
          this.releaseLease('report_structure', report.id)
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
      const entityId = record && record._v7Id;
      const expectedRevision = Number(record && record._v7Revision);
      if (!entityId || !Number.isFinite(expectedRevision)) throw new TypeError('V7 record identity/revision is required');
      const entityType = `record:${recordType}`;
      const payload = this.recordPayload(record);
      this.saveDraft(entityType, entityId, payload, expectedRevision);
      const lease = this.getLease(entityType, entityId) || await this.claimLease(entityType, entityId);
      let result;
      try {
        result = this.commandResult(await this.executeOperation('monthly_v7_save_record', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: this.userSession.id,
          p_client_session_id: this.clientSessionId,
          p_record_id: entityId,
          p_expected_revision: expectedRevision,
          p_lease_id: lease.leaseId,
          p_fencing_token: lease.fencingToken,
          p_payload: payload
        }, `save_record:${entityId}`), 'SAVE_RECORD_FAILED');
      } catch (error) {
        if (['LEASE_LOST', 'REVISION_CONFLICT', 'AUTHORITY_CHANGED'].includes(error.code)) this.leases.delete(this.leaseKey(entityType, entityId));
        if (typeof this.host.onConflict === 'function') this.host.onConflict({ entityType, entityId, draft: payload, result: error.result });
        throw error;
      }
      record._v7Revision = Number(result.revision);
      this.leases.delete(this.leaseKey(entityType, entityId));
      this.clearDraft(entityType, entityId);
      if (typeof this.host.onItemSaved === 'function') this.host.onItemSaved({ entityType, entityId, revision: record._v7Revision });
      return result;
    }

    async deleteRecord(recordType, record) {
      this.requireUserSession();
      const entityId = record && record._v7Id;
      const expectedRevision = Number(record && record._v7Revision);
      if (!entityId || !Number.isFinite(expectedRevision)) throw new TypeError('V7 record identity/revision is required');
      const entityType = `record:${recordType}`;
      this.saveDraft(entityType, entityId, { deleteRequested: true, previous: this.recordPayload(record) }, expectedRevision);
      const lease = this.getLease(entityType, entityId) || await this.claimLease(entityType, entityId);
      const result = this.commandResult(await this.executeOperation('monthly_v7_delete_record', {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_record_id: entityId,
        p_expected_revision: expectedRevision,
        p_lease_id: lease.leaseId,
        p_fencing_token: lease.fencingToken
      }, `delete_record:${entityId}`), 'DELETE_RECORD_FAILED');
      this.leases.delete(this.leaseKey(entityType, entityId));
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
        p_kind: kind
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

    async catchUp() {
      this.requireUserSession();
      let pageCount = 0;
      let lastResult = { watermark: this.watermark, events: [], hasMore: false };
      do {
        const raw = await this.transport.rpc('monthly_v7_get_changes_since', {
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
          const entity = await this.transport.rpc('monthly_v7_get_entity', {
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

    async logout() {
      try {
        if (this.isActive() && this.siteSession && this.siteSession.id) {
          await this.transport.rpc('monthly_v7_logout', {
            p_workspace_key: this.config.workspaceKey,
            p_site_session_id: this.siteSession.id,
            p_user_session_id: this.userSession ? this.userSession.id : null
          });
        }
      } finally {
        this.clearSessions();
      }
    }

    clearSessions() {
      this.stopHeartbeat();
      this.stopRealtime();
      this.siteSession = null;
      this.userSession = null;
      this.user = null;
      this.leases.clear();
      if (this.sessionStorage) {
        this.sessionStorage.removeItem('monthly_v7_site_session');
        this.sessionStorage.removeItem('monthly_v7_user_session');
        this.sessionStorage.removeItem('monthly_v7_user_projection');
      }
    }
  }

  return Object.freeze({ MonthlyV7Client });
});
