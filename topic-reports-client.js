(function (root, factory) {
  const commonJs = typeof module === 'object' && module.exports;
  const api = factory(root, commonJs ? require('./topic-reports-core.js') : root.TopicReportsCore);
  if (commonJs) module.exports = api;
  if (root) {
    root.TopicReportsClient = api;
    root.TOPIC_REPORT_ASSET_BUILDS = Object.assign({}, root.TOPIC_REPORT_ASSET_BUILDS, { client: api.BUILD_ID });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, core) {
  'use strict';

  const BUILD_ID = '1.9.0';
  const IDENTITY_STORAGE_KEY = 'topic:v1:identity-handoff';
  const CREATE_SENTINEL_ID = '00000000-0000-4000-8000-000000000001';
  const SESSION_ERRORS = new Set([
    'AUTH_REQUIRED', 'SITE_SESSION_INVALID', 'USER_SESSION_INVALID', 'READ_SESSION_INVALID'
  ]);

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function isUuid(value) {
    return core.UUID_PATTERN.test(String(value || ''));
  }

  function safeUserProjection(value) {
    const user = value && typeof value === 'object' ? value : {};
    if (!isUuid(user.id) || !String(user.username || '').trim() || !String(user.displayName || '').trim()
      || !['owner', 'admin', 'operator'].includes(String(user.role || ''))) return null;
    return {
      id: String(user.id).toLowerCase(),
      username: String(user.username),
      displayName: String(user.displayName),
      role: String(user.role),
      active: user.active !== false,
      version: Number.isInteger(Number(user.version)) && Number(user.version) > 0 ? Number(user.version) : 1
    };
  }

  function validateIdentity(value) {
    const identity = value && typeof value === 'object' ? value : {};
    const user = safeUserProjection(identity.user);
    if (Number(identity.version) !== 1 || identity.domain !== 'topic-auth-handoff'
      || !String(identity.workspaceKey || '').trim()
      || !Number.isInteger(Number(identity.authorityEpoch)) || Number(identity.authorityEpoch) <= 0
      || !String(identity.clientSessionId || '').trim()
      || !isUuid(identity.siteSessionId) || !isUuid(identity.userSessionId) || !user || user.active === false) {
      return null;
    }
    return {
      version: 1,
      domain: 'topic-auth-handoff',
      workspaceKey: String(identity.workspaceKey),
      authorityEpoch: Number(identity.authorityEpoch),
      clientSessionId: String(identity.clientSessionId),
      siteSessionId: String(identity.siteSessionId).toLowerCase(),
      userSessionId: String(identity.userSessionId).toLowerCase(),
      user
    };
  }

  function captureMonthlyIdentity(app) {
    if (!app || typeof app.isActive !== 'function' || app.isActive() !== true
      || typeof app.isWriteReady !== 'function' || app.isWriteReady() !== true
      || !app.client) throw new Error('TOPIC_MONTHLY_IDENTITY_NOT_READY');
    const client = app.client;
    const user = typeof client.currentUser === 'function'
      ? client.currentUser()
      : (typeof app.currentUser === 'function' ? app.currentUser() : null);
    const identity = validateIdentity({
      version: 1,
      domain: 'topic-auth-handoff',
      workspaceKey: client.config && client.config.workspaceKey,
      authorityEpoch: client.status && (client.status.authorityEpoch || client.status.authority_epoch),
      clientSessionId: client.clientSessionId,
      siteSessionId: client.siteSession && client.siteSession.id,
      userSessionId: client.userSession && client.userSession.id,
      user
    });
    if (!identity) throw new Error('TOPIC_MONTHLY_IDENTITY_INVALID');
    return identity;
  }

  function storeIdentityHandoff(storage, value) {
    if (!storage || typeof storage.setItem !== 'function') throw new Error('TOPIC_SESSION_STORAGE_REQUIRED');
    const identity = validateIdentity(value);
    if (!identity) throw new Error('TOPIC_IDENTITY_INVALID');
    storage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
    return clone(identity);
  }

  function readIdentityHandoff(storage) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    let parsed = null;
    try { parsed = JSON.parse(storage.getItem(IDENTITY_STORAGE_KEY) || 'null'); }
    catch (_error) { parsed = null; }
    const identity = validateIdentity(parsed);
    if (!identity && typeof storage.removeItem === 'function') storage.removeItem(IDENTITY_STORAGE_KEY);
    return identity;
  }

  function clearIdentityHandoff(storage) {
    if (!storage || typeof storage.removeItem !== 'function') return false;
    storage.removeItem(IDENTITY_STORAGE_KEY);
    return true;
  }

  class SupabaseTopicTransport {
    constructor(supabaseGlobal, options = {}) {
      this.supabaseGlobal = supabaseGlobal;
      this.client = null;
      this.configKey = '';
      const timeout = Number(options.requestTimeoutMs || 30000);
      this.requestTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
    }

    async withTimeout(promise, operationName) {
      let timer = null;
      const timeout = new Promise((resolve, reject) => {
        timer = (root.setTimeout || setTimeout)(() => {
          const error = new Error('RPC_TIMEOUT');
          error.code = 'RPC_TIMEOUT';
          error.rpcName = operationName;
          reject(error);
        }, this.requestTimeoutMs);
      });
      try { return await Promise.race([promise, timeout]); }
      finally { if (timer !== null) (root.clearTimeout || clearTimeout)(timer); }
    }

    async ensureAnonymous(config) {
      if (!this.supabaseGlobal || typeof this.supabaseGlobal.createClient !== 'function') throw new Error('SUPABASE_JS_NOT_LOADED');
      const url = String(config && config.supabaseUrl || '').replace(/\/$/, '');
      const anonKey = String(config && config.anonKey || '');
      if (!url || !anonKey) throw new Error('SUPABASE_CONFIG_REQUIRED');
      const nextKey = `${url}|${anonKey.slice(-16)}`;
      if (!this.client || this.configKey !== nextKey) {
        this.configKey = nextKey;
        this.client = this.supabaseGlobal.createClient(url, anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            // 必須與月報transport相同，才能以同一anonymous auth.uid使用已核發的server session。
            storageKey: `monthly-v7-auth-${url.replace(/[^a-z0-9]/gi, '-').slice(-40)}`
          }
        });
      }
      const existing = await this.client.auth.getSession();
      if (existing.error) throw existing.error;
      if (!existing.data || !existing.data.session) {
        const signed = await this.client.auth.signInAnonymously({
          options: { data: { application: 'monthly-safety-report-system-topic-v1' } }
        });
        if (signed.error) {
          const error = new Error('SUPABASE_ANONYMOUS_AUTH_REQUIRED');
          error.cause = signed.error;
          throw error;
        }
      }
      return true;
    }

    async rpc(name, params) {
      if (!this.client) throw new Error('SUPABASE_CLIENT_NOT_READY');
      const response = await this.withTimeout(this.client.rpc(name, params || {}), name);
      if (response.error) {
        const error = new Error(response.error.message || response.error.details || name);
        error.code = response.error.code || 'SUPABASE_RPC_ERROR';
        error.details = response.error.details || '';
        error.rpcName = name;
        throw error;
      }
      return response.data;
    }
  }

  class TopicReportClient {
    constructor(options = {}) {
      if (!options.transport || typeof options.transport.rpc !== 'function') throw new TypeError('transport.rpc is required');
      this.transport = options.transport;
      this.config = Object.assign({}, options.config || {});
      this.identity = validateIdentity(options.identity);
      this.sessionStorage = options.sessionStorage || null;
      this.draftStorage = options.draftStorage || null;
      this.idFactory = options.idFactory || (() => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `00000000-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
      });
      this.generation = 1;
      this.initialized = false;
    }

    async initialize() {
      if (!this.identity) throw new Error('TOPIC_IDENTITY_REQUIRED');
      if (!this.config.workspaceKey) this.config.workspaceKey = this.identity.workspaceKey;
      if (String(this.config.workspaceKey) !== String(this.identity.workspaceKey)) throw new Error('TOPIC_WORKSPACE_MISMATCH');
      if (typeof this.transport.ensureAnonymous === 'function') await this.transport.ensureAnonymous(this.config);
      this.initialized = true;
      return { ok: true, user: this.currentUser() };
    }

    currentUser() { return this.identity ? clone(this.identity.user) : null; }

    replaceIdentity(value) {
      const next = validateIdentity(value);
      if (!next) throw new Error('TOPIC_IDENTITY_INVALID');
      this.identity = next;
      this.generation += 1;
      if (this.sessionStorage) storeIdentityHandoff(this.sessionStorage, next);
      return this.currentUser();
    }

    invalidateIdentity() {
      this.identity = null;
      this.generation += 1;
      clearIdentityHandoff(this.sessionStorage);
    }

    captureContext(reportId = '', editorWindowId = '') {
      return Object.freeze({
        generation: this.generation,
        actorUserId: String(this.identity && this.identity.user && this.identity.user.id || ''),
        userSessionId: String(this.identity && this.identity.userSessionId || ''),
        clientSessionId: String(this.identity && this.identity.clientSessionId || ''),
        reportId: String(reportId || ''),
        editorWindowId: String(editorWindowId || '')
      });
    }

    isContextCurrent(context) {
      const active = this.captureContext(context && context.reportId, context && context.editorWindowId);
      return !!context
        && Number(context.generation) === active.generation
        && String(context.actorUserId) === active.actorUserId
        && String(context.userSessionId) === active.userSessionId
        && String(context.clientSessionId) === active.clientSessionId
        && String(context.reportId || '') === active.reportId
        && String(context.editorWindowId || '') === active.editorWindowId;
    }

    assertContext(context) {
      if (this.isContextCurrent(context)) return context;
      const error = new Error('STALE_TOPIC_CONTEXT');
      error.code = 'STALE_TOPIC_CONTEXT';
      throw error;
    }

    commonParams() {
      if (!this.identity) throw new Error('TOPIC_IDENTITY_REQUIRED');
      return {
        p_workspace_key: this.identity.workspaceKey,
        p_user_session_id: this.identity.userSessionId,
        p_client_session_id: this.identity.clientSessionId
      };
    }

    resultError(result) {
      const code = String(result && result.error || 'TOPIC_OPERATION_FAILED');
      const error = new Error(code);
      error.code = code;
      error.result = clone(result);
      return error;
    }

    sessionErrorCode(value) {
      const candidates = [value && value.code, value && value.error, value && value.message]
        .map((entry) => String(entry || ''));
      return candidates.find((entry) => SESSION_ERRORS.has(entry)) || '';
    }

    async rpc(name, params, context) {
      if (!/^monthly_v7_topic_/.test(String(name || ''))) throw new Error('TOPIC_RPC_NAMESPACE_REQUIRED');
      try {
        const result = await this.transport.rpc(name, params || {});
        this.assertContext(context);
        const sessionCode = this.sessionErrorCode(result);
        if (sessionCode) {
          this.invalidateIdentity();
          const error = new Error(sessionCode);
          error.code = sessionCode;
          error.result = clone(result);
          throw error;
        }
        return result;
      } catch (error) {
        if (this.sessionErrorCode(error)) this.invalidateIdentity();
        throw error;
      }
    }

    async listReports() {
      const context = this.captureContext();
      const result = await this.rpc(
        'monthly_v7_topic_list_reports', this.commonParams(), context
      );
      if (!result || result.ok !== true) throw this.resultError(result);
      return clone(result);
    }

    async getReport(reportId) {
      const context = this.captureContext(reportId);
      const result = await this.rpc('monthly_v7_topic_get_report', {
        ...this.commonParams(), p_report_id: reportId
      }, context);
      if (!result || result.ok !== true) throw this.resultError(result);
      return clone(result);
    }

    async acquireLease(reportId, editorWindowId, ttlSeconds = 90) {
      const context = this.captureContext(reportId, editorWindowId);
      const result = await this.rpc('monthly_v7_topic_acquire_report_lease', {
        ...this.commonParams(),
        p_report_id: reportId,
        p_editor_window_id: editorWindowId,
        p_ttl_seconds: ttlSeconds
      }, context);
      return clone(result);
    }

    async openReport({ reportId, editorWindowId }) {
      const loaded = await this.getReport(reportId);
      const lease = await this.acquireLease(reportId, editorWindowId);
      if (!lease || lease.ok !== true) {
        if (lease && lease.error === 'LEASE_HELD') {
          return {
            ok: true,
            mode: 'readonly',
            report: loaded.report,
            lease: null,
            holderDisplayName: lease.holderDisplayName || loaded.holderDisplayName || '',
            expiresAt: lease.expiresAt || loaded.leaseExpiresAt || ''
          };
        }
        throw this.resultError(lease);
      }
      return { ok: true, mode: 'edit', report: loaded.report, lease };
    }

    operationScope(operationType, reportId, editorWindowId) {
      return {
        operationType,
        reportId,
        actorUserId: this.identity && this.identity.user.id,
        editorWindowId
      };
    }

    readPending(scope) {
      if (!this.sessionStorage) return null;
      try { return JSON.parse(this.sessionStorage.getItem(core.topicPendingKey(scope)) || 'null'); }
      catch (_error) { return null; }
    }

    writePending(scope, envelope) {
      if (!this.sessionStorage) return;
      this.sessionStorage.setItem(core.topicPendingKey(scope), JSON.stringify(envelope));
    }

    clearPending(scope) {
      if (this.sessionStorage) this.sessionStorage.removeItem(core.topicPendingKey(scope));
    }

    readDraft(scope) {
      if (!this.draftStorage) return null;
      try { return JSON.parse(this.draftStorage.getItem(core.topicDraftKey(scope)) || 'null'); }
      catch (_error) { return null; }
    }

    writeDraft(scope, draft) {
      if (!this.draftStorage) return;
      this.draftStorage.setItem(core.topicDraftKey(scope), JSON.stringify(draft));
    }

    clearDraft(scope) {
      if (this.draftStorage) this.draftStorage.removeItem(core.topicDraftKey(scope));
    }

    async executeOperation({ operationType, reportId, editorWindowId, rpcName, params }) {
      const scope = this.operationScope(operationType, reportId, editorWindowId);
      const requestWithoutOperation = clone(params || {});
      delete requestWithoutOperation.p_operation_id;
      const requestHash = canonical(requestWithoutOperation);
      let pending = this.readPending(scope);
      if (pending && (pending.requestHash !== requestHash || pending.actorUserId !== scope.actorUserId
        || pending.reportId !== reportId || pending.editorWindowId !== editorWindowId
        || pending.operationType !== operationType)) {
        const error = new Error('TOPIC_PENDING_OPERATION_MISMATCH');
        error.code = 'TOPIC_PENDING_OPERATION_MISMATCH';
        throw error;
      }
      if (!pending) {
        pending = {
          version: 1,
          domain: 'topic',
          operationType,
          operationId: this.idFactory(),
          actorUserId: scope.actorUserId,
          reportId,
          editorWindowId,
          rpcName,
          request: requestWithoutOperation,
          requestHash,
          createdAt: new Date().toISOString()
        };
        this.writePending(scope, pending);
      }
      const context = this.captureContext(reportId, editorWindowId);
      let result;
      try {
        result = await this.rpc(rpcName, {
          ...requestWithoutOperation,
          p_operation_id: pending.operationId
        }, context);
      } catch (error) {
        // Unknown outcome retains the exact operation envelope for idempotent replay.
        throw error;
      }
      this.assertContext(context);
      this.clearPending(scope);
      if (!result || result.ok !== true) throw this.resultError(result);
      return clone(result);
    }

    async retryPendingOperation(pending) {
      const value = clone(pending);
      const valid = value && value.version === 1 && value.domain === 'topic'
        && value.actorUserId === this.identity.user.id
        && ['create', 'save', 'snapshot', 'delete'].includes(value.operationType)
        && isUuid(value.reportId) && isUuid(value.editorWindowId)
        && /^monthly_v7_topic_/.test(String(value.rpcName || ''))
        && value.request && typeof value.request === 'object' && !Array.isArray(value.request);
      if (!valid) {
        const error = new Error('TOPIC_PENDING_ENVELOPE_INVALID');
        error.code = 'TOPIC_PENDING_ENVELOPE_INVALID';
        throw error;
      }
      return this.executeOperation({
        operationType: value.operationType,
        reportId: value.reportId,
        editorWindowId: value.editorWindowId,
        rpcName: value.rpcName,
        params: value.request
      });
    }

    async createReport({ editorWindowId, content, title, reportDate }) {
      const normalized = core.normalizeTopicContent(content);
      const result = await this.executeOperation({
        operationType: 'create',
        reportId: CREATE_SENTINEL_ID,
        editorWindowId,
        rpcName: 'monthly_v7_topic_create_report',
        params: {
          ...this.commonParams(),
          p_editor_window_id: editorWindowId,
          p_title: String(title || normalized.title),
          p_report_date: String(reportDate || normalized.reportDate),
          p_content: normalized
        }
      });
      return result;
    }

    async deleteReport({ reportId, expectedRevision }) {
      if (!isUuid(reportId) || !Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 1) {
        throw new Error('TOPIC_DELETE_SCOPE_INVALID');
      }
      const pendingScope = this.operationScope('delete', reportId, reportId);
      const pending = this.readPending(pendingScope);
      if (pending) return this.retryPendingOperation(pending);
      return this.executeOperation({
        operationType: 'delete',
        reportId,
        // A list-originated delete has no editor window. The report UUID is a stable,
        // actor-scoped envelope key so an unknown outcome can replay exactly once.
        editorWindowId: reportId,
        rpcName: 'monthly_v7_topic_delete_report',
        params: {
          ...this.commonParams(),
          p_report_id: reportId,
          p_expected_revision: Number(expectedRevision)
        }
      });
    }

    async saveReport({ report, lease, editorWindowId, content, status }) {
      if (!report || !isUuid(report.id) || !lease || !isUuid(lease.leaseId)) throw new Error('TOPIC_SAVE_SCOPE_INVALID');
      const normalized = core.normalizeTopicContent(content);
      const draftScope = this.operationScope('save', report.id, editorWindowId);
      const context = this.captureContext(report.id, editorWindowId);
      this.writeDraft(draftScope, {
        version: 1,
        domain: 'topic',
        reportId: report.id,
        actorUserId: this.identity.user.id,
        editorWindowId,
        baseRevision: Number(report.revision),
        content: normalized,
        savedLocallyAt: new Date().toISOString()
      });
      const result = await this.executeOperation({
        operationType: 'save',
        reportId: report.id,
        editorWindowId,
        rpcName: 'monthly_v7_topic_save_report',
        params: {
          ...this.commonParams(),
          p_report_id: report.id,
          p_editor_window_id: editorWindowId,
          p_lease_id: lease.leaseId,
          p_fencing_token: Number(lease.fencingToken),
          p_expected_revision: Number(report.revision),
          p_title: normalized.title,
          p_report_date: normalized.reportDate,
          p_status: status || report.status || 'draft',
          p_content: normalized
        }
      });
      this.assertContext(context);
      this.clearDraft(draftScope);
      return result;
    }

    async heartbeatLease({ reportId, editorWindowId, lease, ttlSeconds = 90 }) {
      const context = this.captureContext(reportId, editorWindowId);
      const result = await this.rpc('monthly_v7_topic_heartbeat_report_lease', {
        ...this.commonParams(), p_report_id: reportId, p_editor_window_id: editorWindowId,
        p_lease_id: lease.leaseId, p_fencing_token: Number(lease.fencingToken),
        p_ttl_seconds: ttlSeconds
      }, context);
      if (!result || result.ok !== true) throw this.resultError(result);
      return clone(result);
    }

    async releaseLease({ reportId, editorWindowId, lease }) {
      const context = this.captureContext(reportId, editorWindowId);
      const result = await this.rpc('monthly_v7_topic_release_report_lease', {
        ...this.commonParams(), p_report_id: reportId, p_editor_window_id: editorWindowId,
        p_lease_id: lease.leaseId, p_fencing_token: Number(lease.fencingToken)
      }, context);
      if (!result || result.ok !== true) throw this.resultError(result);
      return clone(result);
    }

    async discardEditing({ reportId, editorWindowId, lease }) {
      if (!isUuid(reportId) || !isUuid(editorWindowId) || !lease || !isUuid(lease.leaseId)) {
        throw new Error('TOPIC_DISCARD_SCOPE_INVALID');
      }
      const saveScope = this.operationScope('save', reportId, editorWindowId);
      if (this.readPending(saveScope)) {
        const error = new Error('TOPIC_PENDING_SAVE_UNCERTAIN');
        error.code = 'TOPIC_PENDING_SAVE_UNCERTAIN';
        throw error;
      }
      const released = await this.releaseLease({ reportId, editorWindowId, lease });
      if (!released || released.released !== true) throw new Error('TOPIC_RELEASE_NOT_CONFIRMED');
      // Discard is destructive only after the server confirms this exact fence was released.
      this.clearDraft(saveScope);
      return { ok: true, released: true, reportId };
    }

    async completeEditing(options) {
      const saved = await this.saveReport(options);
      const activeLease = saved.lease || options.lease;
      const released = await this.releaseLease({
        reportId: saved.report.id,
        editorWindowId: options.editorWindowId,
        lease: activeLease
      });
      return { ok: true, saved: saved.report, released: released.released === true };
    }

    async createSnapshot({ reportId, expectedRevision, editorWindowId }) {
      return this.executeOperation({
        operationType: 'snapshot', reportId, editorWindowId,
        rpcName: 'monthly_v7_topic_create_snapshot',
        params: {
          ...this.commonParams(), p_report_id: reportId,
          p_expected_revision: Number(expectedRevision)
        }
      });
    }

    async getSnapshot(snapshotId) {
      const context = this.captureContext();
      const result = await this.rpc('monthly_v7_topic_get_snapshot', {
        ...this.commonParams(), p_snapshot_id: snapshotId
      }, context);
      if (!result || result.ok !== true) throw this.resultError(result);
      return clone(result);
    }
  }

  return Object.freeze({
    BUILD_ID,
    IDENTITY_STORAGE_KEY,
    CREATE_SENTINEL_ID,
    validateIdentity,
    captureMonthlyIdentity,
    storeIdentityHandoff,
    readIdentityHandoff,
    clearIdentityHandoff,
    SupabaseTopicTransport,
    TopicReportClient
  });
});
