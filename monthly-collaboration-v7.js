(function (root, factory) {
  const buildId = '7.0.26';
  const commonJs = typeof module === 'object' && module.exports;
  const api = factory(
    root,
    commonJs ? require('./monthly-collaboration-client.js') : root.MonthlyCollaborationClient,
    buildId,
    !commonJs
  );
  if (commonJs) module.exports = api;
  if (root) {
    root.MonthlyV7Browser = api;
    root.MONTHLY_REPORT_ASSET_BUILDS = Object.assign({}, root.MONTHLY_REPORT_ASSET_BUILDS, { v7: buildId });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, clientApi, buildId, browserBuildHandshakeRequired) {
  'use strict';

  const REQUIRED_BUILD_ASSETS = Object.freeze(['page', 'config', 'core', 'client', 'v7']);

  function startupBuildReceipt() {
    const pageBuild = String(root && root.MONTHLY_REPORT_PAGE_BUILD || '').trim();
    const declared = root && root.MONTHLY_REPORT_ASSET_BUILDS && typeof root.MONTHLY_REPORT_ASSET_BUILDS === 'object'
      ? root.MONTHLY_REPORT_ASSET_BUILDS
      : {};
    const assets = {};
    for (const name of REQUIRED_BUILD_ASSETS) assets[name] = String(declared[name] || '').trim();
    const mismatches = REQUIRED_BUILD_ASSETS.filter((name) => !pageBuild || assets[name] !== pageBuild);
    return Object.freeze({ pageBuild, assets: Object.freeze(assets), mismatches: Object.freeze(mismatches) });
  }

  function assertStartupBuild() {
    const receipt = startupBuildReceipt();
    if (receipt.mismatches.length === 0) return receipt;
    const error = new Error('MIXED_ASSET_BLOCKED');
    error.code = 'MIXED_ASSET_BLOCKED';
    error.buildReceipt = receipt;
    throw error;
  }

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

  function cloudSaveTime(value = Date.now()) {
    try {
      return new Date(value).toLocaleTimeString('zh-Hant', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
    } catch (_error) {
      return new Date(value).toISOString().slice(11, 19);
    }
  }

  class SupabaseV7Transport {
    constructor(supabaseGlobal, options = {}) {
      this.supabaseGlobal = supabaseGlobal;
      this.client = null;
      this.configKey = '';
      this.channels = new Set();
      const configuredTimeout = Number(options.requestTimeoutMs ?? root.MONTHLY_V7_RPC_TIMEOUT_MS ?? 30000);
      this.requestTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30000;
    }

    async withTimeout(promise, operationName) {
      let timer = null;
      const startedAt = Date.now();
      const timeout = new Promise((resolve, reject) => {
        timer = root.setTimeout(() => {
          const error = new Error('RPC_TIMEOUT');
          error.code = 'RPC_TIMEOUT';
          error.operation = operationName;
          error.rpcName = operationName;
          error.elapsedMs = Math.max(0, Date.now() - startedAt);
          reject(error);
        }, this.requestTimeoutMs);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer !== null) root.clearTimeout(timer);
      }
    }

    async ensureAnonymous(config) {
      if (!this.supabaseGlobal || typeof this.supabaseGlobal.createClient !== 'function') throw new Error('SUPABASE_JS_NOT_LOADED');
      const url = String(config.supabaseUrl || '').replace(/\/$/, '');
      const anonKey = String(config.anonKey || '');
      if (!url || !anonKey) throw new Error('SUPABASE_CONFIG_REQUIRED');
      const nextKey = `${url}|${anonKey.slice(-16)}`;
      if (!this.client || this.configKey !== nextKey) {
        this.configKey = nextKey;
        this.client = this.supabaseGlobal.createClient(url, anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storageKey: `monthly-v7-auth-${url.replace(/[^a-z0-9]/gi, '-').slice(-40)}`
          }
        });
      }
      const sessionResult = await this.client.auth.getSession();
      if (sessionResult.error) throw sessionResult.error;
      if (!sessionResult.data || !sessionResult.data.session) {
        const signed = await this.client.auth.signInAnonymously({ options: { data: { application: 'monthly-safety-report-system-v7' } } });
        if (signed.error) {
          const error = new Error('SUPABASE_ANONYMOUS_AUTH_REQUIRED');
          error.cause = signed.error;
          throw error;
        }
      }
    }

    async rpc(name, params) {
      if (!this.client) throw new Error('SUPABASE_CLIENT_NOT_READY');
      const response = await this.withTimeout(this.client.rpc(name, params || {}), name);
      if (response.error) {
        const error = new Error(response.error.message || response.error.details || name);
        error.code = response.error.code || 'SUPABASE_RPC_ERROR';
        error.details = response.error.details || '';
        throw error;
      }
      return response.data;
    }

    subscribe(workspaceId, onHint) {
      if (!this.client) return null;
      const channel = this.client
        .channel(`monthly-v7-${workspaceId}-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'monthly_v7_change_events',
          filter: `workspace_id=eq.${workspaceId}`
        }, (payload) => onHint(payload));
      channel.subscribe();
      this.channels.add(channel);
      return () => {
        this.channels.delete(channel);
        try { this.client.removeChannel(channel); } catch {}
      };
    }

    destroy() {
      for (const channel of Array.from(this.channels)) {
        try { this.client.removeChannel(channel); } catch {}
      }
      this.channels.clear();
    }
  }

  class MonthlyV7BrowserApp {
    constructor(options = {}) {
      this.transport = options.transport || new SupabaseV7Transport(root.supabase);
      this.host = options.host || {};
      this.client = null;
      this.status = { mode: 'unknown' };
      this.persistChain = Promise.resolve();
      this.claimPromises = new Map();
      this.moduleReleaseTimers = new Map();
      this.revisionConflictBlocks = new Map();
      this.pendingRecoveryBlock = null;
      this.writeFailureBlocks = new Map();
      this.authorityWriteBlock = null;
      this.initialized = false;
      this.guardsInstalled = false;
      this.userResumeStatus = { requested: false, remembered: false, restored: false, warning: '' };
    }

    setHost(host) {
      this.host = host || {};
      if (this.client) this.client.host = this.clientHost();
    }

    clientHost() {
      return {
        getLocalEntity: async (...args) => typeof this.host.getLocalEntity === 'function'
          ? this.host.getLocalEntity(...args)
          : null,
        getLegacyLocalState: async (...args) => typeof this.host.getLegacyLocalState === 'function'
          ? this.host.getLegacyLocalState(...args)
          : null,
        clearLegacyRecovery: async (...args) => typeof this.host.clearLegacyRecovery === 'function'
          ? this.host.clearLegacyRecovery(...args)
          : false,
        applyBundle: async (bundle, snapshot) => {
          if (typeof this.host.applyBundle === 'function') await this.host.applyBundle(bundle, snapshot);
          this.rebuildRevisionConflictBlocks(snapshot);
          if (this.isRevisionConflictBlocked()) this.publishRevisionConflictStatus();
        },
        applyEntity: async (entity, event) => {
          this.acceptRemoteEntity(entity);
          if (typeof this.host.applyEntity === 'function') await this.host.applyEntity(entity, event);
        },
        onLease: (lease) => {
          this.decorateLease(lease);
          if (typeof this.host.onLease === 'function') this.host.onLease(lease);
        },
        onLeaseLost: (info) => {
          const blockInfo = Object.assign({}, info, {
            result: Object.assign({ ok: false, error: 'LEASE_LOST' }, info && info.result || {})
          });
          this.markWriteFailureBlock(blockInfo);
          this.decorateEditorRows();
          if (typeof this.host.onLeaseLost === 'function') this.host.onLeaseLost(info);
          if (!this.isRevisionConflictBlocked()) this.publishWriteFailureStatus(blockInfo);
        },
        onConflict: (info) => {
          const revisionBlocked = this.markRevisionConflict(info);
          const writeBlocked = this.markWriteFailureBlock(info);
          this.decorateEditorRows();
          if (typeof this.host.onConflict === 'function') this.host.onConflict(info);
          if (revisionBlocked) this.publishRevisionConflictStatus();
          else if (writeBlocked && !this.isRevisionConflictBlocked()) this.publishWriteFailureStatus(info);
        },
        onAuthorityFailure: (info) => {
          const blockInfo = {
            result: {
              ok: false,
              error: String(info && info.code || ''),
              authorityState: String(info && info.authorityState || ''),
              rpcName: String(info && info.rpcName || '')
            }
          };
          if (this.markWriteFailureBlock(blockInfo) && !this.isRevisionConflictBlocked()) {
            this.publishWriteFailureStatus();
          }
        },
        onRemoteChangeWhileEditing: (entity, event) => {
          if (typeof this.host.onRemoteChangeWhileEditing === 'function') this.host.onRemoteChangeWhileEditing(entity, event);
          if (this.isRevisionConflictBlocked()) this.publishRevisionConflictStatus();
        },
        onTransportError: (error) => this.reportError(error),
        onSessionStateChanged: (event) => {
          if (typeof this.host.onSessionStateChanged === 'function') this.host.onSessionStateChanged(event);
          this.decorateEditorRows();
        },
        onItemSaved: (info) => {
          this.clearRevisionConflict(info && info.entityType, info && info.entityId);
          this.decorateEditorRows();
          if (typeof this.host.onItemSaved === 'function') this.host.onItemSaved(info);
        },
        onUsersChanged: (...args) => {
          if (typeof this.host.onUsersChanged === 'function') this.host.onUsersChanged(...args);
        }
      };
    }

    async initialize(config, host) {
      if (browserBuildHandshakeRequired) assertStartupBuild();
      if (host) this.setHost(host);
      if (!config || !config.workspaceKey) throw new Error('SUPABASE_CONFIG_REQUIRED');
      this.client = new clientApi.MonthlyV7Client({
        transport: this.transport,
        sessionStorage: root.sessionStorage,
        draftStorage: root.localStorage,
        resumeStorage: root.localStorage,
        host: this.clientHost()
      });
      try {
        this.status = await this.client.initialize(config);
      } catch (error) {
        this.status = Object.assign({ mode: 'error' }, this.client.status || {});
        this.initialized = false;
        throw error;
      }
      this.initialized = true;
      if (this.isActive()) this.installEditGuards();
      return this.status;
    }

    isActive() { return !!(this.client && this.client.isActive()); }
    isSiteUnlocked() { return !!(this.client && this.client.isSiteUnlocked()); }
    isSiteSessionPendingValidation() {
      return !!(this.client && typeof this.client.isSiteSessionPendingValidation === 'function'
        && this.client.isSiteSessionPendingValidation());
    }
    isWriteReady() {
      if (!this.client) return false;
      return typeof this.client.isWriteReady === 'function'
        ? !!this.client.isWriteReady()
        : !!this.client.currentUser?.();
    }
    currentUser() { return this.client ? this.client.currentUser() : null; }
    currentReport() { return this.client ? this.client.currentReport() : null; }

    diagnosticState() {
      const buildReceipt = startupBuildReceipt();
      if (buildReceipt.mismatches.length > 0) return 'MIXED_ASSET_BLOCKED';
      if (this.status && this.status.mode === 'v7') return 'NORMALIZED_READY';
      if (this.status && this.status.mode === 'legacy') return 'EXPLICIT_LEGACY_READY';
      if (String(this.status && this.status.errorCode || '') === 'V7_CLIENT_VERSION_UNSUPPORTED') {
        return 'INCOMPATIBLE_CLIENT';
      }
      if (this.status && this.status.mode === 'error') return 'UNAVAILABLE';
      return 'UNINITIALIZED';
    }

    async workspaceHashPrefix() {
      const workspaceKey = String(this.client && this.client.config && this.client.config.workspaceKey || '');
      const subtle = root && root.crypto && root.crypto.subtle;
      const Encoder = root && root.TextEncoder;
      if (!workspaceKey || !subtle || typeof subtle.digest !== 'function' || typeof Encoder !== 'function') return '';
      const digest = await subtle.digest('SHA-256', new Encoder().encode(workspaceKey));
      return Array.from(new Uint8Array(digest))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 12);
    }

    async diagnosticReceipt() {
      const buildReceipt = startupBuildReceipt();
      const status = this.status || {};
      const operation = this.client && typeof this.client.lastOperationReceipt === 'function'
        ? this.client.lastOperationReceipt()
        : null;
      return Object.freeze({
        state: this.diagnosticState(),
        builds: Object.freeze({
          page: buildReceipt.pageBuild,
          config: buildReceipt.assets.config,
          core: buildReceipt.assets.core,
          client: buildReceipt.assets.client,
          v7: buildReceipt.assets.v7
        }),
        authority: Object.freeze({
          state: String(status.authorityState || ''),
          epoch: Number(status.authorityEpoch || 0)
        }),
        workspaceHashPrefix: await this.workspaceHashPrefix(),
        lastRpc: this.client && typeof this.client.lastRpc === 'function' ? this.client.lastRpc() : '',
        save: Object.freeze({
          origin: String(operation && (operation.saveOrigin || operation.requestedOrigin) || ''),
          requestedOrigin: String(operation && operation.requestedOrigin || ''),
          operationId: String(operation && operation.operationId || ''),
          state: String(operation && operation.state || '')
        })
      });
    }

    async openSite(password, options = {}) {
      const result = await this.client.openSite(password);
      if (options.rememberDevice === true) {
        try {
          await this.client.issueSiteResume();
          result.resumeRemembered = true;
        } catch (error) {
          const authorityCode = this.authorityFailureCode(error);
          if (authorityCode) {
            try { error.code = authorityCode; } catch (_error) { /* preserve original error */ }
            this.client.clearSiteResumeMarker();
            this.client.clearLocalSiteSession('site-resume-authority-changed', authorityCode);
            throw error;
          }
          const sessionCode = this.client && typeof this.client.sessionErrorCode === 'function'
            ? this.client.sessionErrorCode(error)
            : '';
          if (sessionCode || error?.code === 'STALE_SESSION_RESPONSE') throw error;
          result.resumeRemembered = false;
          result.resumeWarning = String(error && (error.code || error.message) || 'SITE_RESUME_ISSUE_FAILED');
        }
      }
      return result;
    }

    async login(username, password, options = {}) {
      const rememberUser = options.rememberUser === true;
      this.client.clearUserResumeMarker();
      this.client.status.userResumeErrorCode = '';
      this.userResumeStatus = { requested: rememberUser, remembered: false, restored: false, warning: '' };
      const user = await this.client.login(username, password);
      if (rememberUser) {
        try {
          await this.client.issueUserResume();
          this.userResumeStatus.remembered = true;
        } catch (error) {
          const authorityCode = this.authorityFailureCode(error);
          const sessionCode = this.client && typeof this.client.sessionErrorCode === 'function'
            ? this.client.sessionErrorCode(error)
            : '';
          if (authorityCode || sessionCode || error?.code === 'STALE_SESSION_RESPONSE') throw error;
          this.userResumeStatus.warning = this.client.isUserResumeCapabilityMissing(error)
            ? 'USER_RESUME_CAPABILITY_MISSING'
            : String(error && (error.code || error.message) || 'USER_RESUME_ISSUE_FAILED');
        }
      }
      this.client.startHeartbeat();
      this.client.startRealtime();
      this.decorateEditorRows();
      return user;
    }

    async resumeUserFromMarker() {
      if (!this.client || this.client.currentUser()) return this.currentUser();
      const marker = this.client.readUserResumeMarker();
      if (!marker) return null;
      if (!this.client.isSiteUnlocked() || !String(this.client.siteSession && this.client.siteSession.trustedDeviceId || '')) {
        return null;
      }
      this.userResumeStatus = { requested: true, remembered: true, restored: false, warning: '' };
      try {
        const user = await this.client.restoreUserFromMarker();
        if (!user) return null;
        this.userResumeStatus.restored = true;
        this.client.status.userResumeErrorCode = '';
        this.client.startHeartbeat();
        this.client.startRealtime();
        return user;
      } catch (error) {
        const authorityCode = this.authorityFailureCode(error);
        const sessionCode = this.client && typeof this.client.sessionErrorCode === 'function'
          ? this.client.sessionErrorCode(error)
          : '';
        if (authorityCode || sessionCode === 'SITE_SESSION_INVALID' || error?.code === 'STALE_SESSION_RESPONSE') throw error;
        const rawCode = String(error && (error.code || error.message) || 'USER_RESUME_FAILED');
        const code = this.client.isUserResumeCapabilityMissing(error)
          ? 'USER_RESUME_CAPABILITY_MISSING'
          : rawCode;
        this.client.status.userResumeErrorCode = code;
        this.userResumeStatus.warning = code;
        return null;
      }
    }

    async logoutUser() {
      if (!this.client) return;
      const client = this.client;
      const operationContext = this.captureOperationContext();
      for (const timer of this.moduleReleaseTimers.values()) root.clearTimeout(timer);
      this.moduleReleaseTimers.clear();
      const leases = Array.from(client.leases.values());
      await Promise.allSettled(leases.map((lease) => client.releaseCapturedLease(lease, operationContext)));
      this.assertOperationContext(operationContext, 'logout_user_release');
      await client.logoutUser();
      // The core logout fences its own RPC await and intentionally invalidates
      // the captured context on success.  A non-null user here can only be a
      // successor session, which the old continuation must not decorate/use.
      if (typeof client.currentUser === 'function' && client.currentUser()) {
        this.assertOperationContext(operationContext, 'logout_user_complete');
      }
      this.decorateEditorRows();
    }

    async logout() {
      if (!this.client) return;
      const client = this.client;
      const operationContext = this.captureOperationContext();
      for (const timer of this.moduleReleaseTimers.values()) root.clearTimeout(timer);
      this.moduleReleaseTimers.clear();
      const leases = Array.from(client.leases.values());
      const releaseResults = await Promise.allSettled(
        leases.map((lease) => client.releaseCapturedLease(lease, operationContext))
      );
      this.assertSiteOperationContext(operationContext, 'logout_site_release', releaseResults);
      await client.logout();
      if (typeof client.isSiteUnlocked === 'function' && client.isSiteUnlocked()) {
        this.assertOperationContext(operationContext, 'logout_site_complete');
      }
      this.decorateEditorRows();
    }

    async forgetTrustedDevice() {
      if (!this.client) return;
      const client = this.client;
      const operationContext = this.captureOperationContext();
      for (const timer of this.moduleReleaseTimers.values()) root.clearTimeout(timer);
      this.moduleReleaseTimers.clear();
      const leases = Array.from(client.leases.values());
      const releaseResults = await Promise.allSettled(
        leases.map((lease) => client.releaseCapturedLease(lease, operationContext))
      );
      this.assertSiteOperationContext(operationContext, 'forget_trusted_device_release', releaseResults);
      const result = await client.forgetTrustedDevice();
      if (typeof client.isSiteUnlocked === 'function' && client.isSiteUnlocked()) {
        this.assertOperationContext(operationContext, 'forget_trusted_device_complete');
      }
      this.decorateEditorRows();
      return result;
    }

    clearLocalSiteSession(reason = 'local-site-session-cleared', code = '') {
      if (!this.client) return false;
      for (const timer of this.moduleReleaseTimers.values()) root.clearTimeout(timer);
      this.moduleReleaseTimers.clear();
      const cleared = this.client.clearLocalSiteSession(reason, code);
      this.decorateEditorRows();
      return cleared;
    }

    async loadSnapshot(options = {}) {
      const result = await this.client.loadSnapshot(options);
      if (!this.client.currentUser()) await this.resumeUserFromMarker();
      if (this.client.currentUser()) {
        this.client.startHeartbeat();
        this.client.startRealtime();
      }
      this.decorateEditorRows();
      return this.client.snapshot || result;
    }

    async syncLatest(options = {}) {
      if (options.preserveLocalIntents === false) return this.loadSnapshot(options);
      if (!this.client.currentUser()) return this.loadSnapshot(options);
      return this.client.catchUp();
    }

    async releaseAllLeasesForAuthoritativeReload() {
      if (!this.client) return true;
      const client = this.client;
      const operationContext = this.captureOperationContext();
      for (const timer of this.moduleReleaseTimers.values()) root.clearTimeout(timer);
      this.moduleReleaseTimers.clear();
      const leases = Array.from(client.leases.values());
      const results = await Promise.all(
        leases.map((lease) => client.releaseCapturedLease(lease, operationContext))
      );
      this.assertOperationContext(operationContext, 'authoritative_reload_release');
      if (results.some((confirmed) => confirmed !== true)) {
        const error = new Error('LEASE_RELEASE_NOT_CONFIRMED');
        error.code = 'LEASE_RELEASE_NOT_CONFIRMED';
        throw error;
      }
      this.decorateEditorRows();
      return true;
    }

    async reapplyProtectedLocalIntents() {
      if (!this.client || typeof this.client.reapplyProtectedLocalIntents !== 'function') return null;
      const result = await this.client.reapplyProtectedLocalIntents();
      this.decorateEditorRows();
      return result;
    }

    captureOperationContext() {
      return this.client && typeof this.client.captureSessionContext === 'function'
        ? this.client.captureSessionContext()
        : null;
    }

    isOperationContextCurrent(context) {
      return !context || !this.client || typeof this.client.isSessionContextCurrent !== 'function'
        || this.client.isSessionContextCurrent(context);
    }

    assertOperationContext(context, operationName = '') {
      if (context && this.client && typeof this.client.assertSessionContext === 'function') {
        this.client.assertSessionContext(context, operationName);
      }
      return context;
    }

    assertSiteOperationContext(context, operationName = '', releaseResults = []) {
      if (!context || !this.client) return context;
      const current = this.captureOperationContext();
      const originalSiteSessionId = String(context.siteSessionId || '');
      const currentSiteSessionId = String(current && current.siteSessionId || '');
      const sameClientSession = String(current && current.clientSessionId || '')
        === String(context.clientSessionId || '');
      if (originalSiteSessionId && sameClientSession && currentSiteSessionId === originalSiteSessionId) {
        return context;
      }
      const siteInvalid = releaseResults.find((entry) => {
        if (!entry || entry.status !== 'rejected') return false;
        const code = String(entry.reason && (entry.reason.code || entry.reason.message) || '');
        return code.includes('SITE_SESSION_INVALID');
      });
      if (!currentSiteSessionId && siteInvalid) {
        if (typeof this.client.clearSiteResumeMarker === 'function') this.client.clearSiteResumeMarker();
        if (typeof this.client.clearLocalSiteSession === 'function') {
          this.client.clearLocalSiteSession(`${operationName}-site-invalid`, 'SITE_SESSION_INVALID');
        }
        throw siteInvalid.reason;
      }
      return this.assertOperationContext(context, operationName);
    }

    enqueue(task, operationName = 'queued-persist', options = {}) {
      const operationContext = this.captureOperationContext();
      const run = this.persistChain.catch(() => undefined).then(async () => {
        this.assertOperationContext(operationContext, operationName);
        const result = await task(operationContext);
        this.assertOperationContext(operationContext, operationName);
        return result;
      });
      this.persistChain = run;
      return run.catch((error) => {
        const authorityCode = this.authorityFailureCode(error);
        if (authorityCode) {
          this.markWriteFailureBlock({
            result: {
              ok: false,
              error: authorityCode,
              rpcName: String(error && error.rpcName || operationName || ''),
              authorityState: String(error && error.result
                && (error.result.authorityState || error.result.authority_state) || '')
            }
          });
          if (!this.isRevisionConflictBlocked()) this.publishWriteFailureStatus();
          try { error.silent = true; } catch (_error) { /* global blocker already published */ }
        }
        if (this.markPendingRecoveryBlock(error, {
          operationName,
          saveOrigin: options.saveOrigin
        })) {
          this.publishPendingRecoveryStatus();
          try { error.silent = true; } catch (_error) { /* status already published */ }
        }
        if (!['REVISION_CONFLICT', 'REVISION_CONFLICT_CANCELLED'].includes(error && error.code) && !error?.silent) {
          this.reportError(error);
        }
        throw error;
      });
    }

    pendingRecoveryErrorCode(error) {
      const code = String(error && error.code || '');
      return [
        'PENDING_OPERATION_UNRESOLVED',
        'PENDING_OPERATION_ACTOR_MISMATCH',
        'PENDING_OPERATION_ACTOR_UNRESOLVED'
      ].includes(code) ? code : '';
    }

    markPendingRecoveryBlock(error, context = {}) {
      const code = this.pendingRecoveryErrorCode(error);
      if (!code) return false;
      if (!this.pendingRecoveryBlock) {
        this.pendingRecoveryBlock = {
          state: 'PENDING_OPERATION_BLOCKED',
          code,
          operationName: String(context.operationName || error?.rpcName || ''),
          saveOrigin: String(context.saveOrigin || error?.saveOrigin || ''),
          detectedAt: new Date().toISOString()
        };
      }
      return true;
    }

    isPendingRecoveryBlocked() {
      return !!this.pendingRecoveryBlock;
    }

    pendingRecoveryStatusText() {
      return '偵測到無法安全辨識的待對帳操作；原始證據與本機草稿均已保留，已停止背景自動保存。請由管理員人工檢查後重新載入。';
    }

    publishPendingRecoveryStatus() {
      if (!this.isPendingRecoveryBlocked()) return false;
      this.setStatus(this.pendingRecoveryStatusText(), 'error', { preferOverRecovery: true });
      return true;
    }

    pendingRecoveryBlockedResult() {
      this.publishPendingRecoveryStatus();
      return {
        mode: 'v7', localOnly: true, recoveryBlocked: true,
        state: 'PENDING_OPERATION_BLOCKED',
        code: this.pendingRecoveryBlock && this.pendingRecoveryBlock.code
      };
    }

    markWriteFailureBlock(info = {}) {
      const result = info.result || {};
      const code = String(result.error || '');
      const authorityCode = this.authorityFailureCode(code);
      if (code !== 'LEASE_LOST' && !authorityCode) return false;
      const block = {
        state: code === 'LEASE_LOST' ? 'LEASE_LOST_BLOCKED' : 'AUTHORITY_CHANGED_BLOCKED',
        code,
        entityType: String(info.entityType || ''),
        entityId: String(info.entityId || ''),
        draft: clone(info.draft || {}),
        result: clone(result),
        detectedAt: new Date().toISOString()
      };
      if (authorityCode) this.authorityWriteBlock = block;
      else if (block.entityType && block.entityId) {
        this.writeFailureBlocks.set(this.revisionConflictKey(block.entityType, block.entityId), block);
      }
      return true;
    }

    authorityFailureCode(code) {
      const candidates = [];
      const sources = [code, code && code.result, code && code.cause];
      for (const source of sources) {
        if (typeof source === 'string') candidates.push(source);
        else if (source && typeof source === 'object') {
          candidates.push(source.code, source.error, source.message, source.details, source.hint);
        }
      }
      for (const candidate of candidates) {
        const text = String(candidate || '');
        const sentinel = ['AUTHORITY_CHANGED', 'AUTHORITY_NOT_ACTIVE']
          .find((value) => text.includes(value));
        if (sentinel) return sentinel;
      }
      return '';
    }

    isWriteFailureBlocked(entityType, entityId) {
      if (this.authorityWriteBlock) return true;
      if (entityType && entityId) {
        return this.writeFailureBlocks.has(this.revisionConflictKey(entityType, entityId));
      }
      return this.writeFailureBlocks.size > 0;
    }

    writeFailureBlockFor(entityType, entityId) {
      if (this.authorityWriteBlock) return this.authorityWriteBlock;
      if (entityType && entityId) {
        return this.writeFailureBlocks.get(this.revisionConflictKey(entityType, entityId)) || null;
      }
      return this.writeFailureBlocks.values().next().value || null;
    }

    writeFailureStatusText(block = this.authorityWriteBlock) {
      if (block && this.authorityFailureCode(block.code)) {
        return '雲端 authority 已變更；已停止保存且不會降級舊版，本機草稿仍完整保留。請重新載入以完成安全驗證。';
      }
      return '編輯權已失效；本機草稿已保留為唯讀，已停止此項目的背景保存。請重新取得編輯權後再人工保存。';
    }

    publishWriteFailureStatus(info = {}) {
      const block = this.writeFailureBlockFor(info.entityType, info.entityId);
      if (!block) return false;
      this.setStatus(this.writeFailureStatusText(block), 'error', { preferOverRecovery: true });
      return true;
    }

    writeFailureBlockedResult(entityType, entityId) {
      const block = this.writeFailureBlockFor(entityType, entityId);
      if (!block) return null;
      this.publishWriteFailureStatus({ entityType, entityId });
      return {
        mode: 'v7', localOnly: true, writeBlocked: true,
        state: block.state, code: block.code,
        entityType: block.entityType, entityId: block.entityId
      };
    }

    revisionConflictKey(entityType, entityId) {
      return `${String(entityType || '')}:${String(entityId || '')}`;
    }

    revisionConflictStatusText() {
      const subject = this.revisionConflictBlocks.size > 1
        ? `${this.revisionConflictBlocks.size} 個項目`
        : '此項目';
      return `雲端有較新版本；${subject}的本機草稿已保留，等待你選擇。請按「保存修改」查看並決定。`;
    }

    publishRevisionConflictStatus() {
      if (!this.isRevisionConflictBlocked()) return false;
      this.setStatus(this.revisionConflictStatusText(), 'error', { preferOverRecovery: true });
      return true;
    }

    isRevisionConflictBlocked(entityType, entityId) {
      if (entityType && entityId) {
        return this.revisionConflictBlocks.has(this.revisionConflictKey(entityType, entityId));
      }
      return this.revisionConflictBlocks.size > 0;
    }

    clearRevisionConflict(entityType, entityId) {
      if (!entityType || !entityId) return false;
      return this.revisionConflictBlocks.delete(this.revisionConflictKey(entityType, entityId));
    }

    markRevisionConflict(info = {}) {
      const result = info.result || {};
      if (String(result.error || '') !== 'REVISION_CONFLICT') return false;
      const add = (entityType, entityId, draftPayload, baseRevision) => {
        const type = String(entityType || '');
        const id = String(entityId || '');
        if (!['module', 'report_meta'].includes(type) || !id) return;
        const storedDraft = this.client && this.client.readDraft(type, id);
        const base = Number(storedDraft?.baseRevision ?? baseRevision ?? 0);
        const current = Number(result.currentRevision ?? result.current_revision ?? 0);
        this.revisionConflictBlocks.set(this.revisionConflictKey(type, id), {
          state: 'REVISION_CONFLICT_BLOCKED',
          entityType: type,
          entityId: id,
          baseRevision: Number.isSafeInteger(base) && base >= 0 ? base : 0,
          serverRevision: Number.isSafeInteger(current) && current > 0 ? current : null,
          draft: clone(storedDraft?.payload ?? draftPayload ?? {}),
          result: clone(result),
          source: 'server'
        });
      };
      if (info.entityType === 'module_batch') {
        const conflictId = String(result.entityId || result.entity_id || info.entityId || '');
        const drafts = Array.isArray(info.drafts) ? info.drafts : [];
        const targets = conflictId
          ? drafts.filter((row) => String(row?.moduleId || row?.module_id || '') === conflictId)
          : drafts;
        for (const row of targets) {
          add(
            'module', row?.moduleId || row?.module_id, row?.payload,
            row?.expectedRevision ?? row?.expected_revision
          );
        }
        if (conflictId && targets.length === 0) add('module', conflictId, null, null);
      } else {
        add(info.entityType, info.entityId, info.draft, info.baseRevision);
      }
      return this.isRevisionConflictBlocked();
    }

    rebuildRevisionConflictBlocks(snapshot = this.client && this.client.snapshot) {
      const next = new Map();
      if (!this.client || !snapshot) {
        this.revisionConflictBlocks = next;
        return [];
      }
      const reportId = String(snapshot.report && snapshot.report.id || '');
      const batchPendingKey = reportId ? `save_module_batch:${reportId}` : '';
      const hasAnyBatchPending = !!(batchPendingKey && this.client.hasPendingOperation(batchPendingKey));
      const addIfStale = (entityType, entityId, authorityRevision, authorityPayload) => {
        const id = String(entityId || '');
        const draft = id && this.client.readDraft(entityType, id);
        const base = Number(draft && draft.baseRevision);
        const current = Number(authorityRevision);
        if (!draft || !Number.isSafeInteger(base) || base < 0
          || !Number.isSafeInteger(current) || current <= base
          || canonical(draft.payload) === canonical(authorityPayload)) return;
        const pendingKey = entityType === 'module'
          ? `save_module:${id}`
          : `save_report_meta:${id}`;
        if (this.client.hasPendingOperation(pendingKey)
          || (entityType === 'module' && hasAnyBatchPending)) return;
        next.set(this.revisionConflictKey(entityType, id), {
          state: 'REVISION_CONFLICT_BLOCKED',
          entityType,
          entityId: id,
          baseRevision: base,
          serverRevision: current,
          draft: clone(draft.payload),
          result: { ok: false, error: 'REVISION_CONFLICT', currentRevision: current },
          source: 'snapshot'
        });
      };
      for (const row of snapshot.modules || []) {
        addIfStale(
          'module', row && row.id,
          row && (row._serverRevision ?? row.revision),
          row && (row._serverPayload ?? row.payload)
        );
      }
      if (snapshot.report && reportId) {
        const authorityMeta = snapshot.report._serverPayload || {
          title: String(snapshot.report.title || ''),
          date: String(snapshot.report.date || ''),
          period: clone(snapshot.report.period || {}),
          settings: clone(snapshot.report.settings || {})
        };
        addIfStale(
          'report_meta', reportId,
          snapshot.report._serverRevision ?? snapshot.report.revision,
          authorityMeta
        );
      }
      this.revisionConflictBlocks = next;
      return Array.from(next.values()).map(clone);
    }

    baselineModuleMap() {
      return new Map(((this.client.snapshot && this.client.snapshot.modules) || []).map((row) => {
        if (!Object.prototype.hasOwnProperty.call(row, '_serverPayload')) return [row.id, row];
        return [row.id, Object.assign({}, row, {
          payload: clone(row._serverPayload),
          revision: Number(row._serverRevision ?? row.revision)
        })];
      }));
    }

    syncModuleBaseline(item, confirmedPayload) {
      if (!this.client.snapshot) return;
      if (!Array.isArray(this.client.snapshot.modules)) this.client.snapshot.modules = [];
      let row = this.client.snapshot.modules.find((entry) => entry.id === item._v7Id);
      if (!row) {
        row = { id: item._v7Id, legacyItemId: String(item.id || item._v7Id) };
        this.client.snapshot.modules.push(row);
      }
      row.revision = Number(item._v7Revision);
      row.payload = clone(confirmedPayload === undefined ? this.client.modulePayload(item) : confirmedPayload);
      delete row._serverPayload;
      delete row._serverRevision;
      this.clearRevisionConflict('module', item._v7Id);
    }

    hasModuleDraft(entityId) {
      return !!(this.client && entityId && this.client.readDraft('module', entityId));
    }

    async rebaseModulesForConfirmedRetry(items, conflictError, operationContext = this.captureOperationContext()) {
      this.assertOperationContext(operationContext, 'rebase_modules');
      const pending = (items || []).filter((item) => item && item._v7Id);
      const serverEntities = [];
      for (const item of pending) {
        const entity = await this.client.getEntity('module', item._v7Id);
        this.assertOperationContext(operationContext, 'rebase_modules');
        if (entity.deleted || !Number.isFinite(Number(entity.revision))) {
          const error = new Error('CONFLICT_ENTITY_UNAVAILABLE');
          error.code = 'CONFLICT_ENTITY_UNAVAILABLE';
          error.result = entity;
          throw error;
        }
        serverEntities.push(entity);
      }
      const confirmed = typeof this.host.confirmRevisionOverwrite === 'function'
        ? await Promise.resolve(this.host.confirmRevisionOverwrite({
          entityType: 'module',
          entityIds: pending.map((item) => item._v7Id),
          drafts: pending.map((item) => clone(this.client.modulePayload(item))),
          serverEntities: clone(serverEntities),
          result: conflictError && conflictError.result
        }))
        : false;
      this.assertOperationContext(operationContext, 'rebase_modules');
      if (!confirmed) {
        this.setStatus('已取消覆蓋；雲端未變更，本機草稿仍完整保留。', 'warn');
        const error = new Error('REVISION_CONFLICT_CANCELLED');
        error.code = 'REVISION_CONFLICT_CANCELLED';
        error.silent = true;
        error.result = conflictError && conflictError.result;
        throw error;
      }
      pending.forEach((item, index) => {
        const entity = serverEntities[index];
        this.acceptRemoteEntity(entity);
        item._v7Revision = Number(entity.revision);
        this.client.saveDraft('module', item._v7Id, this.client.modulePayload(item), item._v7Revision);
        this.clearRevisionConflict('module', item._v7Id);
      });
      return serverEntities;
    }

    async saveChangedModules(changed, options = {}, operationContext = this.captureOperationContext()) {
      this.assertOperationContext(operationContext, 'save_changed_modules');
      const commit = async () => {
        this.assertOperationContext(operationContext, 'save_changed_modules');
        const submitted = changed.map((item) => ({
          item,
          payload: clone(this.client.modulePayload(item))
        }));
        const isBatch = changed.length > 1;
        const rpcName = isBatch ? 'monthly_v7_save_module_batch' : 'monthly_v7_save_module';
        const pendingKey = isBatch
          ? `save_module_batch:${this.currentReport() && this.currentReport().id}`
          : `save_module:${changed[0] && changed[0]._v7Id}`;
        let cloudConfirmed = false;
        try {
          if (!isBatch) await this.client.saveModule(changed[0], options);
          else await this.client.saveModuleBatch(changed, options);
          this.assertOperationContext(operationContext, 'save_changed_modules');
          cloudConfirmed = true;
          submitted.forEach(({ item, payload }) => this.syncModuleBaseline(item, payload));
        } finally {
          if (this.isOperationContextCurrent(operationContext)) {
            for (const { item, payload } of submitted) {
              this.assertOperationContext(operationContext, 'save_changed_modules_cleanup');
              let liveItem = item;
              if (typeof this.host.getLocalEntity === 'function') {
                try {
                  liveItem = await this.host.getLocalEntity('module', item._v7Id) || item;
                  this.assertOperationContext(operationContext, 'save_changed_modules_cleanup');
                } catch (error) {
                  this.assertOperationContext(operationContext, 'save_changed_modules_cleanup');
                  liveItem = item;
                }
              }
              const currentPayload = this.client.modulePayload(liveItem);
              const changedWhileSaving = canonical(currentPayload) !== canonical(payload);
              if ((!cloudConfirmed && isBatch) || changedWhileSaving) {
                if (!cloudConfirmed && typeof this.client.saveSupersedingDraft === 'function') {
                  this.client.saveSupersedingDraft(
                    'module', item._v7Id, currentPayload, Number(item._v7Revision), rpcName, pendingKey
                  );
                } else {
                  this.client.saveDraft('module', item._v7Id, currentPayload, Number(item._v7Revision));
                }
              }
            }
          }
        }
      };
      try {
        await commit();
      } catch (error) {
        if (error && error.code === 'REVISION_CONFLICT' && options.resolveRevisionConflict === true) {
          await this.rebaseModulesForConfirmedRetry(changed, error, operationContext);
          this.assertOperationContext(operationContext, 'save_changed_modules');
          await commit();
          return;
        }
        throw error;
      }
    }

    async rebaseReportMetaForConfirmedRetry(meta, conflictError, operationContext = this.captureOperationContext()) {
      this.assertOperationContext(operationContext, 'rebase_report_meta');
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const entity = await this.client.getEntity('report_meta', report.id);
      this.assertOperationContext(operationContext, 'rebase_report_meta');
      if (entity.deleted || !Number.isFinite(Number(entity.revision))) {
        const error = new Error('CONFLICT_ENTITY_UNAVAILABLE');
        error.code = 'CONFLICT_ENTITY_UNAVAILABLE';
        error.result = entity;
        throw error;
      }
      const confirmed = typeof this.host.confirmRevisionOverwrite === 'function'
        ? await Promise.resolve(this.host.confirmRevisionOverwrite({
          entityType: 'report_meta',
          entityIds: [report.id],
          drafts: [clone(meta)],
          serverEntities: [clone(entity)],
          result: conflictError && conflictError.result
        }))
        : false;
      this.assertOperationContext(operationContext, 'rebase_report_meta');
      if (!confirmed) {
        this.setStatus('已取消覆蓋；雲端未變更，本機草稿仍完整保留。', 'warn');
        const error = new Error('REVISION_CONFLICT_CANCELLED');
        error.code = 'REVISION_CONFLICT_CANCELLED';
        error.silent = true;
        error.result = conflictError && conflictError.result;
        throw error;
      }
      this.acceptRemoteEntity(entity);
      if (this.client.snapshot && this.client.snapshot.report) {
        this.client.snapshot.report._serverRevision = Number(entity.revision);
        this.client.snapshot.report._serverPayload = clone(entity.payload || {});
      }
      this.client.saveDraft('report_meta', report.id, meta, Number(entity.revision));
      this.clearRevisionConflict('report_meta', report.id);
      return entity;
    }

    async persistReportData(items, options = {}) {
      if (!this.isActive()) return { mode: 'legacy' };
      if (this.isPendingRecoveryBlocked()) return this.pendingRecoveryBlockedResult();
      if (this.authorityWriteBlock) return this.writeFailureBlockedResult('', '');
      if (!this.isWriteReady()) {
        this.setStatus('本機草稿已保存；請登入後再提交逐項變更。', 'warn');
        return { mode: 'v7', localOnly: true };
      }
      const liveItems = Array.isArray(items) ? items : [];
      const writeBlockedModule = liveItems.find((item) => (
        item && item._v7Id && this.isWriteFailureBlocked('module', item._v7Id)
      ));
      if (writeBlockedModule) {
        return this.writeFailureBlockedResult('module', writeBlockedModule._v7Id);
      }
      if (this.client.snapshot?.legacyLocalRecovery && options.confirmLegacyRecovery !== true) {
        const baseline = this.baselineModuleMap();
        for (const item of liveItems) {
          const entityId = String(item?._v7Id || '');
          const row = baseline.get(entityId);
          if (!entityId || !row) continue;
          const payload = this.client.modulePayload(item);
          const existing = this.client.readDraft('module', entityId);
          if (!existing && canonical(payload) === canonical(row.payload)) continue;
          this.client.saveDraft(
            'module', entityId, payload,
            Number(existing?.baseRevision ?? item._v7Revision ?? row.revision ?? 0),
            existing?.supersedesOperation
              ? { supersedesOperation: existing.supersedesOperation }
              : {}
          );
        }
        const accepted = this.client.snapshot.legacyLocalRecovery.hasAcceptedRecovery === true;
        this.setStatus(accepted
          ? '已依可信證據救回切換前內容；禁止背景自動提交，請人工確認後按「保存修改」。'
          : '切換前本機候選缺少可信 freshness 證據，已隔離且不會由一般保存上傳或重建。', 'warn');
        return { mode: 'v7', localOnly: true, recoveryPending: true };
      }
      return this.enqueue(async (operationContext) => {
        if (!this.client.snapshot) {
          await this.client.loadSnapshot();
          this.assertOperationContext(operationContext, 'persist_report_data');
        }
        const blockedModules = liveItems.filter((item) => (
          item && item._v7Id && this.isRevisionConflictBlocked('module', item._v7Id)
        ));
        if (blockedModules.length > 0) {
          if (options.resolveRevisionConflict !== true) {
            this.publishRevisionConflictStatus();
            return {
              mode: 'v7', localOnly: true, conflictBlocked: true,
              state: 'REVISION_CONFLICT_BLOCKED'
            };
          }
          const conflict = new Error('REVISION_CONFLICT');
          conflict.code = 'REVISION_CONFLICT';
          conflict.result = clone(
            this.revisionConflictBlocks.get(
              this.revisionConflictKey('module', blockedModules[0]._v7Id)
            )?.result || { ok: false, error: 'REVISION_CONFLICT' }
          );
          await this.rebaseModulesForConfirmedRetry(blockedModules, conflict, operationContext);
          this.assertOperationContext(operationContext, 'persist_report_data');
        }
        let baseline = this.baselineModuleMap();
        const createReplay = typeof this.client.reconcilePendingCreateModule === 'function'
          ? await this.client.reconcilePendingCreateModule(liveItems)
          : null;
        this.assertOperationContext(operationContext, 'persist_report_data');
        if (createReplay && createReplay.ok !== true && createReplay.error !== 'LEASE_LOST') {
          this.client.commandResult(createReplay, 'CREATE_MODULE_FAILED');
        }
        if (createReplay && createReplay.ok === true) {
          const reconciledItem = liveItems.find((item) => String(item?._v7Id || '')
            === String(createReplay.entityId || createReplay.entity_id || ''));
          if (reconciledItem) this.syncModuleBaseline(reconciledItem);
          baseline = this.baselineModuleMap();
        }
        const liveIds = new Set(liveItems.map((item) => item && item._v7Id).filter(Boolean));
        const deletedRows = Array.from(baseline.values()).filter((row) => !liveIds.has(row.id));
        for (const item of liveItems.filter((entry) => !entry._v7Id)) {
          const created = await this.client.createModule(item);
          this.assertOperationContext(operationContext, 'persist_report_data');
          item._v7Id = created._v7Id;
          item._v7Revision = created._v7Revision;
          this.syncModuleBaseline(item);
        }
        for (const row of deletedRows) {
          const item = Object.assign({}, clone(row.payload), { _v7Id: row.id, _v7Revision: Number(row.revision) });
          await this.client.deleteModule(item);
          this.assertOperationContext(operationContext, 'persist_report_data');
          this.client.snapshot.modules = this.client.snapshot.modules.filter((entry) => entry.id !== row.id);
        }
        baseline = this.baselineModuleMap();
        const reportId = String((this.currentReport() && this.currentReport().id) || '');
        const batchPendingKey = reportId ? `save_module_batch:${reportId}` : '';
        const batchPendingTargets = batchPendingKey
          ? this.client.pendingOperationTargets('monthly_v7_save_module_batch', batchPendingKey)
          : new Set();
        const changed = liveItems.filter((item) => {
          const row = baseline.get(item._v7Id);
          if (!row) return false;
          const livePayload = this.client.modulePayload(item);
          let payloadChanged = canonical(livePayload) !== canonical(row.payload);
          const draft = this.client.readDraft('module', item._v7Id);
          const draftChanged = !!(draft && canonical(draft.payload) !== canonical(row.payload));
          if (!payloadChanged && draftChanged) {
            const entityId = item._v7Id;
            Object.assign(item, clone(draft.payload), {
              _v7Id: entityId,
              _v7Revision: Number(draft.baseRevision ?? item._v7Revision ?? row.revision)
            });
            payloadChanged = true;
          }
          const hasPending = this.client.hasPendingOperation(`save_module:${item._v7Id}`)
            || batchPendingTargets.has(String(item._v7Id));
          if (!payloadChanged && !draftChanged && !hasPending && draft) {
            this.client.clearDraft('module', item._v7Id);
          }
          return payloadChanged || draftChanged || hasPending;
        });
        if (changed.length > 0) await this.saveChangedModules(changed, options, operationContext);
        this.assertOperationContext(operationContext, 'persist_report_data');
        const liveOrder = liveItems.map((item) => item._v7Id);
        const baseOrder = (this.client.snapshot.modules || []).map((row) => row.id);
        if (liveOrder.length && canonical(liveOrder) !== canonical(baseOrder)) {
          await this.client.reorderModules(liveItems);
          this.assertOperationContext(operationContext, 'persist_report_data');
          const ranks = new Map(liveOrder.map((id, index) => [id, index]));
          this.client.snapshot.modules.sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
        }
        this.decorateEditorRows();
        this.scheduleInactiveCleanModuleReleases();
        return { mode: 'v7', saved: true, watermark: this.client.watermark };
      }, 'persist-report-data', options);
    }

    async persistReportMeta(meta, options = {}) {
      if (!this.isActive()) return { mode: 'legacy' };
      if (this.isPendingRecoveryBlocked()) return this.pendingRecoveryBlockedResult();
      if (this.authorityWriteBlock) return this.writeFailureBlockedResult('', '');
      if (!this.isWriteReady()) return { mode: 'v7', localOnly: true };
      const report = this.currentReport();
      if (report && this.isWriteFailureBlocked('report_meta', report.id)) {
        return this.writeFailureBlockedResult('report_meta', report.id);
      }
      const nextMeta = {
        title: String(meta && meta.title || report && report.title || ''),
        date: String(meta && meta.date || report && report.date || ''),
        period: clone(meta && meta.period || report && report.period || {}),
        settings: clone(meta && meta.settings || report && report.settings || {})
      };
      const currentMeta = report ? {
        title: String(report.title || ''),
        date: String(report.date || ''),
        period: clone(report.period || {}),
        settings: clone(report.settings || {})
      } : null;
      const hasMetaDraft = !!(report && this.client.readDraft('report_meta', report.id));
      if (currentMeta && !hasMetaDraft && canonical(nextMeta) === canonical(currentMeta)) {
        return { ok: true, skipped: true, revision: Number(report.revision) };
      }
      return this.enqueue(async (operationContext) => {
        if (this.isRevisionConflictBlocked('report_meta', report.id)) {
          if (options.resolveRevisionConflict !== true) {
            this.publishRevisionConflictStatus();
            return {
              mode: 'v7', localOnly: true, conflictBlocked: true,
              state: 'REVISION_CONFLICT_BLOCKED'
            };
          }
          const conflict = new Error('REVISION_CONFLICT');
          conflict.code = 'REVISION_CONFLICT';
          conflict.result = clone(
            this.revisionConflictBlocks.get(
              this.revisionConflictKey('report_meta', report.id)
            )?.result || { ok: false, error: 'REVISION_CONFLICT' }
          );
          await this.rebaseReportMetaForConfirmedRetry(nextMeta, conflict, operationContext);
          this.assertOperationContext(operationContext, 'persist_report_meta');
        }
        let cloudConfirmed = false;
        try {
          let result;
          try {
            result = await this.client.saveReportMeta(nextMeta, options);
          } catch (error) {
            if (error && error.code === 'REVISION_CONFLICT'
              && options.resolveRevisionConflict === true) {
              await this.rebaseReportMetaForConfirmedRetry(nextMeta, error, operationContext);
              this.assertOperationContext(operationContext, 'persist_report_meta');
              result = await this.client.saveReportMeta(nextMeta, options);
            } else {
              throw error;
            }
          }
          this.assertOperationContext(operationContext, 'persist_report_meta');
          cloudConfirmed = true;
          this.setStatus(`月報資訊已保存｜${cloudSaveTime()}`, 'ok');
          return result;
        } finally {
          if (this.isOperationContextCurrent(operationContext)
            && typeof this.host.getLocalEntity === 'function') {
            let live = null;
            try {
              live = await this.host.getLocalEntity('report_meta', report.id);
              this.assertOperationContext(operationContext, 'persist_report_meta_cleanup');
            } catch (error) {
              this.assertOperationContext(operationContext, 'persist_report_meta_cleanup');
              live = null;
            }
            const liveMeta = live && {
              title: String(live.title || ''),
              date: String(live.date || ''),
              period: clone(live.period || {}),
              settings: clone(live.settings || {})
            };
            if (liveMeta && canonical(liveMeta) !== canonical(nextMeta)) {
              const baseRevision = Number(report.revision);
              if (!cloudConfirmed && typeof this.client.saveSupersedingDraft === 'function') {
                this.client.saveSupersedingDraft(
                  'report_meta', report.id, liveMeta, baseRevision,
                  'monthly_v7_save_report_meta', `save_report_meta:${report.id}`
                );
              } else {
                this.client.saveDraft('report_meta', report.id, liveMeta, baseRevision);
              }
            }
          }
        }
      }, 'persist-report-meta', options);
    }

    recordGroupsFromSnapshot() {
      const groups = { inspections: [], deficiencies: [], detentions: [], actions: [], trainings: [] };
      for (const row of (this.client.snapshot && this.client.snapshot.records) || []) {
        if (!groups[row.recordType]) groups[row.recordType] = [];
        groups[row.recordType].push(Object.assign({}, clone(row.payload), { _v7Id: row.id, _v7Revision: Number(row.revision) }));
      }
      return groups;
    }

    syncRecordBaseline(recordType, record) {
      if (!this.client.snapshot) return;
      if (!Array.isArray(this.client.snapshot.records)) this.client.snapshot.records = [];
      let row = this.client.snapshot.records.find((entry) => entry.id === record._v7Id);
      if (!row) {
        row = { id: record._v7Id, recordType };
        this.client.snapshot.records.push(row);
      }
      row.revision = Number(record._v7Revision);
      row.payload = clone(this.client.recordPayload(record));
    }

    async persistRecords(records) {
      if (!this.isActive()) return { mode: 'legacy' };
      if (this.isPendingRecoveryBlocked()) return this.pendingRecoveryBlockedResult();
      if (this.authorityWriteBlock) return this.writeFailureBlockedResult('', '');
      if (!this.isWriteReady()) {
        this.setStatus('資料記錄只保存為本機草稿；請先登入。', 'warn');
        return { mode: 'v7', localOnly: true };
      }
      return this.enqueue(async (operationContext) => {
        if (!this.client.snapshot) {
          await this.client.loadSnapshot();
          this.assertOperationContext(operationContext, 'persist_records');
        }
        const groups = records || {};
        const live = [];
        for (const [recordType, rows] of Object.entries(groups)) {
          for (const row of Array.isArray(rows) ? rows : []) live.push({ recordType, row });
        }
        const liveIds = new Set(live.map(({ row }) => row._v7Id).filter(Boolean));
        const deleted = ((this.client.snapshot && this.client.snapshot.records) || []).filter((row) => !liveIds.has(row.id));
        for (const entry of live.filter(({ row }) => !row._v7Id)) {
          const created = await this.client.createRecord(entry.recordType, entry.row);
          this.assertOperationContext(operationContext, 'persist_records');
          Object.assign(entry.row, created);
          this.syncRecordBaseline(entry.recordType, entry.row);
        }
        for (const old of deleted) {
          const record = Object.assign({}, clone(old.payload), { _v7Id: old.id, _v7Revision: Number(old.revision) });
          await this.client.deleteRecord(old.recordType, record);
          this.assertOperationContext(operationContext, 'persist_records');
          this.client.snapshot.records = this.client.snapshot.records.filter((entry) => entry.id !== old.id);
        }
        const baseline = new Map(((this.client.snapshot && this.client.snapshot.records) || []).map((row) => [row.id, row]));
        for (const entry of live) {
          const old = baseline.get(entry.row._v7Id);
          if (old && canonical(this.client.recordPayload(entry.row)) !== canonical(old.payload)) {
            await this.client.saveRecord(entry.recordType, entry.row);
            this.assertOperationContext(operationContext, 'persist_records');
            this.syncRecordBaseline(entry.recordType, entry.row);
          }
        }
        this.setStatus(`資料記錄已保存｜${cloudSaveTime()}`, 'ok');
        return { mode: 'v7', saved: true, watermark: this.client.watermark };
      }, 'persist-records');
    }

    async flush(meta, options = {}) {
      const operationContext = this.captureOperationContext();
      await this.persistChain.catch(() => undefined);
      this.assertOperationContext(operationContext, 'flush');
      const result = meta && this.isActive() && this.currentUser()
        ? await this.persistReportMeta(meta, options)
        : true;
      this.assertOperationContext(operationContext, 'flush');
      return result;
    }

    async claimModule(entityId) {
      if (!this.isActive() || !this.currentUser() || !entityId) return null;
      const key = `module:${entityId}`;
      if (this.client.getLease('module', entityId)) return this.client.getLease('module', entityId);
      if (this.claimPromises.has(key)) return this.claimPromises.get(key);
      const request = this.client.claimLease('module', entityId).then((lease) => {
        this.writeFailureBlocks.delete(this.revisionConflictKey('module', entityId));
        this.decorateLease(lease);
        return lease;
      }).finally(() => this.claimPromises.delete(key));
      this.claimPromises.set(key, request);
      return request;
    }

    decorateLease(lease) {
      if (!root.document || !lease) return;
      const row = root.document.querySelector(`#tableBody tr[data-v7-entity-id="${CSS.escape(String(lease.entityId))}"]`);
      if (!row) return;
      row.dataset.v7LeaseState = 'owned';
      row.querySelectorAll('[data-v7-editable="1"]').forEach((element) => {
        if (element.getAttribute('contenteditable') !== 'true') element.setAttribute('contenteditable', 'true');
      });
      let badge = row.querySelector('.v7-item-lock-badge');
      if (!badge) {
        badge = root.document.createElement('span');
        badge.className = 'v7-item-lock-badge no-print';
        (row.querySelector('.module-actions-cell') || row.lastElementChild || row.querySelector('td'))?.appendChild(badge);
      }
      badge.textContent = '你正在編輯';
      badge.className = 'v7-item-lock-badge no-print text-[10px] text-emerald-700 font-bold';
    }

    decorateEditorRows() {
      if (!this.isActive() || !root.document) return;
      const formalPrintLocked = root.document.body?.dataset?.v7FormalPrintLock === 'true';
      root.document.querySelectorAll('#tableBody tr[data-v7-entity-id]').forEach((row) => {
        const id = row.dataset.v7EntityId;
        const owned = !!this.client.getLease('module', id);
        row.dataset.v7LeaseState = owned ? 'owned' : 'idle';
        row.querySelectorAll('.editable-div').forEach((element) => {
          element.dataset.v7Editable = '1';
          const editable = owned && !formalPrintLocked ? 'true' : 'false';
          if (element.getAttribute('contenteditable') !== editable) {
            element.setAttribute('contenteditable', editable);
          }
        });
        let badge = row.querySelector('.v7-item-lock-badge');
        if (!badge) {
          badge = root.document.createElement('span');
          badge.className = 'v7-item-lock-badge no-print text-[10px] font-bold';
          (row.querySelector('.module-actions-cell') || row.lastElementChild || row.querySelector('td'))?.appendChild(badge);
        }
        badge.textContent = owned ? '你正在編輯' : '點一下取得編輯權';
        badge.className = `v7-item-lock-badge no-print text-[10px] font-bold ${owned ? 'text-emerald-700' : 'text-slate-400'}`;
      });
    }

    scheduleInactiveCleanModuleReleases() {
      if (!this.client || !root.document) return;
      root.document.querySelectorAll('#tableBody tr[data-v7-entity-id]').forEach((row) => {
        const entityId = String(row.dataset.v7EntityId || '');
        if (!entityId || !this.client.getLease('module', entityId)) return;
        if (row.contains(root.document.activeElement)) return;
        this.scheduleUnchangedModuleRelease(row);
      });
    }

    cancelModuleRelease(entityId) {
      const id = String(entityId || '');
      const timer = this.moduleReleaseTimers.get(id);
      if (timer) root.clearTimeout(timer);
      this.moduleReleaseTimers.delete(id);
    }

    scheduleUnchangedModuleRelease(row, delayMs = 350) {
      if (!row || !this.client) return;
      const entityId = String(row.dataset.v7EntityId || '');
      if (root.document?.body?.dataset?.v7FormalPrintLock === 'true') {
        this.cancelModuleRelease(entityId);
        return;
      }
      const operationLease = entityId ? this.client.getLease('module', entityId) : null;
      const operationContext = operationLease ? this.captureOperationContext() : null;
      if (!entityId || !operationLease || !operationContext) return;
      this.cancelModuleRelease(entityId);
      const timer = root.setTimeout(async () => {
        this.moduleReleaseTimers.delete(entityId);
        if (root.document?.body?.dataset?.v7FormalPrintLock === 'true') return;
        if (!this.client || !this.isOperationContextCurrent(operationContext)
          || this.client.getLease('module', entityId) !== operationLease) return;
        const currentRow = Array.from(root.document.querySelectorAll('#tableBody tr[data-v7-entity-id]'))
          .find((candidate) => String(candidate.dataset.v7EntityId || '') === entityId);
        if (currentRow && currentRow.contains(root.document.activeElement)) return;
        const baseline = this.baselineModuleMap().get(entityId);
        if (!baseline || typeof this.host.getLocalEntity !== 'function') return;
        let local;
        try {
          local = await this.host.getLocalEntity('module', entityId);
          this.assertOperationContext(operationContext, 'release_clean_module');
        } catch (error) {
          if (!this.isOperationContextCurrent(operationContext)) return;
          this.reportError(error);
          return;
        }
        if (!local || this.client.getLease('module', entityId) !== operationLease
          || (currentRow && currentRow.contains(root.document.activeElement))) return;
        const changed = canonical(this.client.modulePayload(local)) !== canonical(baseline.payload);
        if (changed) return;
        try { await this.client.releaseCapturedLease(operationLease, operationContext); }
        catch {
          // releaseCapturedLease drops only the captured local heartbeat in finally;
          // the server lease will expire at its existing TTL if the ack is lost.
          this.setStatus('項目釋放確認失敗；編輯權將在逾時後自動釋放。', 'warn');
        }
        if (this.isOperationContextCurrent(operationContext)) this.decorateEditorRows();
      }, delayMs);
      this.moduleReleaseTimers.set(entityId, timer);
    }

    installEditGuards() {
      if (this.guardsInstalled || !root.document) return;
      this.guardsInstalled = true;
      const rowFor = (target) => target && target.closest ? target.closest('#tableBody tr[data-v7-entity-id]') : null;
      const request = (row, focusTarget) => {
        if (!row || !this.currentUser()) return;
        const id = row.dataset.v7EntityId;
        this.claimModule(id).then(() => {
          this.decorateEditorRows();
          if (focusTarget && focusTarget.dataset.v7Editable === '1') focusTarget.focus({ preventScroll: true });
          this.toast('已取得此項目編輯權，可開始修改。');
        }).catch((error) => {
          if (error.code === 'LEASE_HELD') {
            this.setStatus(error.message, 'warn', { protectForMs: 10000 });
            this.toast(error.message);
          } else {
            this.reportError(error);
            this.toast(`無法取得編輯權：${error.message}`);
          }
        });
      };
      root.document.addEventListener('pointerdown', (event) => {
        const row = rowFor(event.target);
        const independentAction = event.target && event.target.closest
          ? event.target.closest('[data-v7-independent-action="1"]')
          : null;
        root.document.querySelectorAll('#tableBody tr[data-v7-entity-id]').forEach((candidate) => {
          const id = candidate.dataset.v7EntityId;
          if (candidate === row) this.cancelModuleRelease(id);
          else if (this.client.getLease('module', id)) this.scheduleUnchangedModuleRelease(candidate);
        });
        if (independentAction) return;
        if (row && !this.client.getLease('module', row.dataset.v7EntityId)) request(row, event.target);
      }, true);
      root.document.addEventListener('focusout', (event) => {
        const row = rowFor(event.target);
        if (!row || (event.relatedTarget && row.contains(event.relatedTarget))) return;
        this.scheduleUnchangedModuleRelease(row);
      }, true);
      ['beforeinput', 'paste', 'drop'].forEach((type) => root.document.addEventListener(type, (event) => {
        const row = rowFor(event.target);
        if (!row || !this.currentUser()) return;
        if (!this.client.getLease('module', row.dataset.v7EntityId)) {
          event.preventDefault();
          event.stopPropagation();
          request(row, event.target);
        }
      }, true));
      root.document.addEventListener('click', (event) => {
        const row = rowFor(event.target);
        if (!row || !this.currentUser() || this.client.getLease('module', row.dataset.v7EntityId)) return;
        if (event.target.closest('[data-v7-independent-action="1"]')) return;
        if (event.target.closest('button,select,input,label,[contenteditable]')) {
          event.preventDefault();
          event.stopPropagation();
          request(row, event.target);
        }
      }, true);
      const metaSelector = '#mainTitle,#reportDate,#startMonth,#startDay,#endMonth,#endDay,#globalFontEnSelector,#globalFontZhSelector';
      const requestMeta = () => {
        const report = this.currentReport();
        if (!report || !this.currentUser() || this.client.getLease('report_meta', report.id)) return;
        const key = `report_meta:${report.id}`;
        if (this.claimPromises.has(key)) return;
        const requestPromise = this.client.claimLease('report_meta', report.id)
          .then(() => this.toast('已取得月報資訊編輯權。'))
          .catch((error) => this.reportError(error))
          .finally(() => this.claimPromises.delete(key));
        this.claimPromises.set(key, requestPromise);
      };
      root.document.addEventListener('pointerdown', (event) => {
        if (event.target && event.target.matches && event.target.matches(metaSelector)) requestMeta();
      }, true);
      ['beforeinput', 'change'].forEach((type) => root.document.addEventListener(type, (event) => {
        if (!event.target || !event.target.matches || !event.target.matches(metaSelector) || !this.currentUser()) return;
        const report = this.currentReport();
        if (report && !this.client.getLease('report_meta', report.id)) {
          event.preventDefault();
          event.stopPropagation();
          requestMeta();
        }
      }, true));
      root.addEventListener('focus', () => {
        if (this.currentUser()) this.client.catchUp().catch((error) => this.reportError(error));
      });
    }

    acceptRemoteEntity(entity) {
      if (!entity || !this.client || !this.client.snapshot) return;
      const type = entity.entityType || entity.entity_type;
      const id = entity.entityId || entity.entity_id;
      if (type === 'module') {
        let row = (this.client.snapshot.modules || []).find((entry) => entry.id === id);
        if (entity.deleted) this.client.snapshot.modules = (this.client.snapshot.modules || []).filter((entry) => entry.id !== id);
        else {
          if (!row) { row = { id, legacyItemId: id }; this.client.snapshot.modules.push(row); }
          row.revision = Number(entity.revision);
          row.payload = clone(entity.payload);
        }
      } else if (type && type.startsWith('record:')) {
        let row = (this.client.snapshot.records || []).find((entry) => entry.id === id);
        if (entity.deleted) this.client.snapshot.records = (this.client.snapshot.records || []).filter((entry) => entry.id !== id);
        else {
          if (!row) { row = { id, recordType: type.slice(7) }; this.client.snapshot.records.push(row); }
          row.revision = Number(entity.revision);
          row.payload = clone(entity.payload);
        }
      } else if (type === 'report_meta' && entity.payload) {
        Object.assign(this.client.snapshot.report, clone(entity.payload), { revision: Number(entity.revision) });
      }
    }

    prepareImportedBundle(bundle) {
      const next = clone(bundle || {});
      if (!this.isActive() || !this.client || !this.client.snapshot) return next;
      const moduleByLegacyId = new Map((this.client.snapshot.modules || []).map((row) => [String(row.legacyItemId || row.payload && row.payload.id || ''), row]));
      for (const item of (next.report && next.report.modules) || []) {
        const row = moduleByLegacyId.get(String(item.id || ''));
        if (row) { item._v7Id = row.id; item._v7Revision = Number(row.revision); }
      }
      const recordByLegacyKey = new Map((this.client.snapshot.records || []).map((row) => [
        `${row.recordType}:${String(row.payload && row.payload.id || '')}`, row
      ]));
      for (const [recordType, rows] of Object.entries(next.records || {})) {
        for (const item of Array.isArray(rows) ? rows : []) {
          const row = recordByLegacyKey.get(`${recordType}:${String(item.id || '')}`);
          if (row) { item._v7Id = row.id; item._v7Revision = Number(row.revision); }
        }
      }
      delete next.users;
      delete next.siteAccess;
      return next;
    }

    async beginRecordEdit(recordType, record) {
      if (!this.isActive() || !this.currentUser() || !record || !record._v7Id) return null;
      return this.client.claimLease(`record:${recordType}`, record._v7Id);
    }

    async createModule(payload) {
      const item = await this.client.createModule(payload);
      this.syncModuleBaseline(item);
      return item;
    }

    async deleteModule(item) {
      const result = await this.client.deleteModule(item);
      if (this.client.snapshot) this.client.snapshot.modules = (this.client.snapshot.modules || []).filter((row) => row.id !== item._v7Id);
      return result;
    }

    async reorderModules(items) {
      const result = await this.client.reorderModules(items);
      if (this.client.snapshot) {
        const ranks = new Map(items.map((item, index) => [item._v7Id, index]));
        this.client.snapshot.modules.sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
      }
      return result;
    }

    async deleteRecord(recordType, record) {
      const result = await this.client.deleteRecord(recordType, record);
      if (this.client.snapshot) this.client.snapshot.records = (this.client.snapshot.records || []).filter((row) => row.id !== record._v7Id);
      return result;
    }

    async createUser(profile) { return this.client.createUser(profile); }
    async updateUser(id, profile) { return this.client.updateUser(id, profile); }
    async deleteUser(id) { return this.client.deleteUser(id); }
    async updateSitePassword(password) { return this.client.updateSitePassword(password); }
    async createReportSnapshot(kind, options = {}) {
      return this.client.createReportSnapshot(kind, options);
    }

    setStatus(text, kind, options) {
      if (typeof this.host.setStatus === 'function') this.host.setStatus(text, kind, options);
    }

    toast(text) {
      if (typeof this.host.toast === 'function') this.host.toast(text);
    }

    reportError(error) {
      if (typeof this.host.onTransportError === 'function') this.host.onTransportError(error);
      else if (root.console) root.console.error(error);
      if (this.client && this.client.sessionErrorCode(error)) return;
      const authorityCode = this.authorityFailureCode(error);
      if (authorityCode) {
        this.markWriteFailureBlock({
          result: {
            ok: false,
            error: authorityCode,
            rpcName: String(error && error.rpcName || ''),
            authorityState: String(error && error.result
              && (error.result.authorityState || error.result.authority_state) || '')
          }
        });
        this.publishWriteFailureStatus();
        return;
      }
      if (this.markPendingRecoveryBlock(error)) {
        this.publishPendingRecoveryStatus();
        return;
      }
      const code = String(error && error.code || '');
      const message = String(error && error.message || error || '');
      const responseUnavailable = code === 'RPC_TIMEOUT'
        || /failed to fetch|networkerror|network request failed/i.test(message);
      if (responseUnavailable) {
        this.setStatus('雲端連線暫時中斷；目前結果暫時無法確認。本機草稿仍完整保留，系統稍後會再同步。', 'warn');
        return;
      }
      this.setStatus(`逐項雲端操作失敗：${message}`, 'error');
    }
  }

  return Object.freeze({
    BUILD_ID: buildId,
    REQUIRED_BUILD_ASSETS,
    startupBuildReceipt,
    assertStartupBuild,
    SupabaseV7Transport,
    MonthlyV7BrowserApp,
    canonical
  });
});
