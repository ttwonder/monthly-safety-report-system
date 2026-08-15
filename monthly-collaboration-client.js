(function (root, factory) {
  const buildId = '7.0.21';
  const api = factory(
    typeof module === 'object' && module.exports ? require('./monthly-collaboration-core.js') : root.MonthlyCollaborationCore,
    buildId
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MonthlyCollaborationClient = api;
    root.MONTHLY_REPORT_ASSET_BUILDS = Object.assign({}, root.MONTHLY_REPORT_ASSET_BUILDS, { client: buildId });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, buildId) {
  'use strict';

  class MonthlyV7Client {
    constructor(options = {}) {
      if (!options.transport || typeof options.transport.rpc !== 'function') throw new TypeError('transport.rpc is required');
      this.transport = options.transport;
      this.sessionStorage = options.sessionStorage || null;
      this.draftStorage = options.draftStorage || null;
      this.resumeStorage = options.resumeStorage || null;
      this.core = options.core || core;
      this.host = options.host || {};
      this.idFactory = options.idFactory || (() => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      });
      this.operationIdFactory = options.operationIdFactory || this.idFactory;
      this.clientVersion = Number.isFinite(Number(options.clientVersion)) ? Number(options.clientVersion) : 7;
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
      this.siteSessionPendingValidation = false;
      this.userSessionPendingValidation = false;
      this.loginAttemptEpoch = 0;
      this.snapshotCommitQueue = Promise.resolve();
      this.operationReceipt = null;
      this.operationReceiptHistory = [];
      this.lastRpcName = '';
    }

    siteResumeStorageKey() { return 'monthly_v7_site_resume_marker'; }
    userResumeStorageKey() { return 'monthly_v7_user_resume_marker'; }

    readSiteResumeMarker() {
      if (!this.resumeStorage) return null;
      let raw = null;
      try { raw = this.resumeStorage.getItem(this.siteResumeStorageKey()); }
      catch (_error) { return null; }
      if (raw === null) return null;
      try {
        const marker = JSON.parse(raw);
        const expiresAt = Date.parse(String(marker && marker.expiresAt || ''));
        if (!marker || marker.version !== 1 || marker.purpose !== 'site'
          || !/^[0-9a-f]{64}$/.test(String(marker.token || ''))
          || !Number.isInteger(Number(marker.authorityEpoch)) || Number(marker.authorityEpoch) <= 0
          || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
          return null;
        }
        return Object.assign({}, marker);
      } catch (_error) {
        this.clearSiteResumeMarker();
        this.clearUserResumeMarker();
        return null;
      }
    }

    writeSiteResumeMarker(result) {
      if (!this.resumeStorage) return false;
      const marker = {
        version: 1,
        purpose: 'site',
        token: String(result && (result.resume_token || result.resumeToken) || ''),
        expiresAt: String(result && (result.expires_at || result.expiresAt) || ''),
        authorityEpoch: Number(result && (result.authority_epoch ?? result.authorityEpoch) || this.status.authorityEpoch || 0)
      };
      if (!/^[0-9a-f]{64}$/.test(marker.token)
        || !Number.isFinite(Date.parse(marker.expiresAt))
        || !Number.isInteger(marker.authorityEpoch) || marker.authorityEpoch <= 0) {
        throw new Error('SITE_RESUME_MARKER_INVALID');
      }
      this.resumeStorage.setItem(this.siteResumeStorageKey(), JSON.stringify(marker));
      return true;
    }

    clearSiteResumeMarker() {
      if (!this.resumeStorage) return false;
      try { this.resumeStorage.removeItem(this.siteResumeStorageKey()); return true; }
      catch (_error) { return false; }
    }

    readUserResumeMarker() {
      if (!this.resumeStorage) return null;
      let raw = null;
      try { raw = this.resumeStorage.getItem(this.userResumeStorageKey()); }
      catch (_error) { return null; }
      if (raw === null) return null;
      try {
        const marker = JSON.parse(raw);
        const expiresAt = Date.parse(String(marker && marker.expiresAt || ''));
        if (!marker || marker.version !== 1 || marker.purpose !== 'user'
          || !/^[0-9a-f]{64}$/.test(String(marker.token || ''))
          || !String(marker.trustedDeviceId || '').trim()
          || !Number.isInteger(Number(marker.authorityEpoch)) || Number(marker.authorityEpoch) <= 0
          || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          this.clearUserResumeMarker();
          return null;
        }
        return Object.assign({}, marker);
      } catch (_error) {
        this.clearUserResumeMarker();
        return null;
      }
    }

    writeUserResumeMarker(result) {
      if (!this.resumeStorage) return false;
      const marker = {
        version: 1,
        purpose: 'user',
        token: String(result && (result.resume_token || result.resumeToken) || ''),
        expiresAt: String(result && (result.expires_at || result.expiresAt) || ''),
        authorityEpoch: Number(this.status.authorityEpoch || 0),
        trustedDeviceId: String(result && (result.trusted_device_id || result.trustedDeviceId) || '')
      };
      if (!/^[0-9a-f]{64}$/.test(marker.token)
        || !Number.isFinite(Date.parse(marker.expiresAt)) || Date.parse(marker.expiresAt) <= Date.now()
        || !Number.isInteger(marker.authorityEpoch) || marker.authorityEpoch <= 0
        || !marker.trustedDeviceId) {
        throw new Error('USER_RESUME_MARKER_INVALID');
      }
      this.resumeStorage.setItem(this.userResumeStorageKey(), JSON.stringify(marker));
      return true;
    }

    clearUserResumeMarker() {
      if (!this.resumeStorage) return false;
      try { this.resumeStorage.removeItem(this.userResumeStorageKey()); return true; }
      catch (_error) { return false; }
    }

    isSiteResumeCapabilityMissing(error) {
      const code = String(error && error.code || '');
      const detail = [error && error.message, error && error.details, error && error.hint]
        .map((value) => String(value || ''))
        .join(' ');
      return code === 'PGRST202' && detail.includes('monthly_v7_exchange_site_resume');
    }

    isUserResumeCapabilityMissing(error) {
      const code = String(error && error.code || '');
      const detail = [error && error.message, error && error.details, error && error.hint]
        .map((value) => String(value || ''))
        .join(' ');
      return code === 'PGRST202'
        && (detail.includes('monthly_v7_issue_user_resume') || detail.includes('monthly_v7_exchange_user_resume'));
    }

    async issueSiteResume() {
      if (!this.isSiteUnlocked()) throw new Error('SITE_SESSION_REQUIRED');
      const result = await this.rpc('monthly_v7_issue_site_resume', {
        p_workspace_key: this.config.workspaceKey,
        p_site_session_id: this.siteSession.id,
        p_client_session_id: this.clientSessionId
      });
      if (!result || result.ok !== true) throw new Error(result && result.error || 'SITE_RESUME_ISSUE_FAILED');
      this.siteSession.trustedDeviceId = String(result.trusted_device_id || result.trustedDeviceId || '');
      if (!this.siteSession.trustedDeviceId) throw new Error('SITE_RESUME_DEVICE_INVALID');
      if (this.sessionStorage) this.sessionStorage.setItem('monthly_v7_site_session', JSON.stringify(this.siteSession));
      this.writeSiteResumeMarker(result);
      return this.readSiteResumeMarker();
    }

    async restoreSiteFromMarker() {
      const marker = this.readSiteResumeMarker();
      if (!marker) return null;
      if (Number(marker.authorityEpoch) !== Number(this.status.authorityEpoch)) {
        this.clearSiteResumeMarker();
        this.clearUserResumeMarker();
        const error = new Error('SITE_RESUME_AUTHORITY_CHANGED');
        error.code = 'SITE_RESUME_AUTHORITY_CHANGED';
        throw error;
      }
      let result;
      try {
        result = await this.rpc('monthly_v7_exchange_site_resume', {
          p_workspace_key: this.config.workspaceKey,
          p_resume_token: marker.token,
          p_client_session_id: this.clientSessionId
        });
      } catch (error) {
        if (String(error && (error.code || error.message) || '').includes('SITE_RESUME_INVALID')) {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
        }
        throw error;
      }
      if (!result || result.ok !== true) {
        const code = String(result && result.error || 'SITE_RESUME_FAILED');
        if (code === 'SITE_RESUME_INVALID') {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
        }
        const error = new Error(code);
        error.code = code;
        throw error;
      }
      this.siteSession = {
        id: result.site_session_id || result.siteSessionId,
        expiresAt: result.expires_at || result.expiresAt || '',
        trustedDeviceId: String(result.trusted_device_id || result.trustedDeviceId || '')
      };
      if (!this.siteSession.trustedDeviceId) throw new Error('SITE_RESUME_DEVICE_INVALID');
      this.siteSessionPendingValidation = true;
      if (this.sessionStorage) this.sessionStorage.setItem('monthly_v7_site_session', JSON.stringify(this.siteSession));
      this.writeSiteResumeMarker(result);
      this.sessionGeneration += 1;
      return Object.assign({}, this.siteSession);
    }

    async issueUserResume() {
      if (!this.isWriteReady()) throw new Error('USER_SESSION_REQUIRED');
      const trustedDeviceId = String(this.siteSession && this.siteSession.trustedDeviceId || '');
      if (!trustedDeviceId) throw new Error('TRUSTED_DEVICE_REQUIRED');
      const result = await this.rpc('monthly_v7_issue_user_resume', {
        p_workspace_key: this.config.workspaceKey,
        p_site_session_id: this.siteSession.id,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId
      });
      if (!result || result.ok !== true) throw new Error(result && result.error || 'USER_RESUME_ISSUE_FAILED');
      const resultDeviceId = String(result.trusted_device_id || result.trustedDeviceId || '');
      if (!resultDeviceId || resultDeviceId !== trustedDeviceId) throw new Error('USER_RESUME_DEVICE_MISMATCH');
      this.writeUserResumeMarker(result);
      const stored = this.readUserResumeMarker();
      if (!stored) throw new Error('USER_RESUME_MARKER_INVALID');
      return stored;
    }

    async restoreUserFromMarker() {
      const marker = this.readUserResumeMarker();
      if (!marker) return null;
      if (!this.isSiteUnlocked()) throw new Error('SITE_SESSION_REQUIRED');
      if (Number(marker.authorityEpoch) !== Number(this.status.authorityEpoch)) {
        this.clearUserResumeMarker();
        const error = new Error('USER_RESUME_AUTHORITY_CHANGED');
        error.code = 'USER_RESUME_AUTHORITY_CHANGED';
        throw error;
      }
      const trustedDeviceId = String(this.siteSession && this.siteSession.trustedDeviceId || '');
      if (!trustedDeviceId) throw new Error('TRUSTED_DEVICE_REQUIRED');
      if (trustedDeviceId !== String(marker.trustedDeviceId)) {
        this.clearUserResumeMarker();
        const error = new Error('USER_RESUME_DEVICE_CHANGED');
        error.code = 'USER_RESUME_DEVICE_CHANGED';
        throw error;
      }
      const attemptId = ++this.loginAttemptEpoch;
      const siteSessionId = String(this.siteSession.id || '');
      let result;
      try {
        result = await this.rpc('monthly_v7_exchange_user_resume', {
          p_workspace_key: this.config.workspaceKey,
          p_site_session_id: siteSessionId,
          p_resume_token: marker.token,
          p_client_session_id: this.clientSessionId
        });
      } catch (error) {
        const code = String(error && (error.code || error.message) || '');
        if (['USER_RESUME_INVALID', 'USER_RESUME_AUTHORITY_CHANGED', 'USER_RESUME_DEVICE_CHANGED'].includes(code)) {
          this.clearUserResumeMarker();
        }
        throw error;
      }
      this.assertLoginAttempt(attemptId, siteSessionId);
      if (!result || result.ok !== true) {
        const code = String(result && result.error || 'USER_RESUME_FAILED');
        if (code === 'USER_RESUME_INVALID') this.clearUserResumeMarker();
        const error = new Error(code);
        error.code = code;
        throw error;
      }
      const resultDeviceId = String(result.trusted_device_id || result.trustedDeviceId || '');
      if (!resultDeviceId || resultDeviceId !== trustedDeviceId) {
        this.clearUserResumeMarker();
        const error = new Error('USER_RESUME_DEVICE_MISMATCH');
        error.code = 'USER_RESUME_DEVICE_MISMATCH';
        throw error;
      }
      const provisionalSession = { id: result.user_session_id || result.userSessionId };
      const provisionalUser = Object.assign({}, result.user || {});
      try {
        this.writeUserResumeMarker(result);
      } catch (error) {
        this.clearUserResumeMarker();
        throw error;
      }
      this.userSession = provisionalSession;
      this.user = provisionalUser;
      this.userSessionPendingValidation = true;
      this.sessionGeneration += 1;
      try {
        await this.loadSnapshot({
          retryTransient: true,
          loginAttempt: { attemptId, siteSessionId, userSessionId: provisionalSession.id }
        });
        this.assertLoginAttempt(attemptId, siteSessionId);
        if (String(this.userSession && this.userSession.id || '') !== String(provisionalSession.id)
          || this.userSessionPendingValidation === true) {
          throw this.staleLoginAttemptError(attemptId);
        }
      } catch (error) {
        const ownsProvisional = this.isLoginAttemptCurrent(attemptId, siteSessionId)
          && String(this.userSession && this.userSession.id || '') === String(provisionalSession.id)
          && this.userSessionPendingValidation === true;
        if (ownsProvisional) this.clearUserSession('user-resume-snapshot-failed');
        const code = String(error && (error.code || error.message) || '');
        if (['USER_RESUME_INVALID', 'USER_SESSION_INVALID', 'READ_SESSION_INVALID'].includes(code)) {
          this.clearUserResumeMarker();
        }
        if (error && error.sessionInvalidHandled === true) {
          error.resumeStage = 'snapshot';
          throw error;
        }
        if (!this.isLoginAttemptCurrent(attemptId, siteSessionId)) throw this.staleLoginAttemptError(attemptId);
        error.resumeStage = 'snapshot';
        throw error;
      }
      if (this.sessionStorage) {
        this.sessionStorage.setItem('monthly_v7_user_session', JSON.stringify(this.userSession));
        this.sessionStorage.setItem('monthly_v7_user_projection', JSON.stringify(this.user));
      }
      return this.currentUser();
    }

    lastRpc() {
      return String(this.lastRpcName || '');
    }

    lastOperationReceipt() {
      return this.operationReceipt ? Object.assign({}, this.operationReceipt) : null;
    }

    operationReceipts() {
      return this.operationReceiptHistory.map((receipt) => Object.assign({}, receipt));
    }

    setOperationReceipt(receipt) {
      this.operationReceipt = Object.assign({}, receipt || {});
      const operationId = String(this.operationReceipt.operationId || '');
      const existingIndex = this.operationReceiptHistory.findIndex((entry) => (
        String(entry.operationId || '') === operationId
      ));
      if (existingIndex >= 0) this.operationReceiptHistory.splice(existingIndex, 1);
      this.operationReceiptHistory.push(Object.assign({}, this.operationReceipt));
      if (this.operationReceiptHistory.length > 32) {
        this.operationReceiptHistory.splice(0, this.operationReceiptHistory.length - 32);
      }
      return this.operationReceipt;
    }

    operationFailureState(code, options = {}) {
      const errorCode = String(code || '');
      if (options.resultUnknown === true) return 'RESULT_UNKNOWN_PENDING_RECONCILIATION';
      if (this.sessionErrorCode(options.error || errorCode)) return 'SESSION_INVALID_LOCAL_ONLY';
      if (errorCode === 'REVISION_CONFLICT') return 'REVISION_CONFLICT_BLOCKED';
      if (errorCode === 'LEASE_LOST') return 'LEASE_LOST_BLOCKED';
      if (this.isAuthorityFailureCode(errorCode)) return 'AUTHORITY_CHANGED_BLOCKED';
      if ([
        'PENDING_OPERATION_UNRESOLVED',
        'PENDING_OPERATION_ACTOR_MISMATCH',
        'PENDING_OPERATION_ACTOR_UNRESOLVED'
      ].includes(errorCode)) return 'PENDING_OPERATION_BLOCKED';
      return 'LOCAL_DIRTY';
    }

    authorityFailureCode(value) {
      const candidates = [];
      const sources = [value, value && value.error, value && value.cause];
      for (const source of sources) {
        if (typeof source === 'string') candidates.push(source);
        else if (source && typeof source === 'object') {
          candidates.push(source.code, source.error, source.message, source.details, source.hint);
        }
      }
      for (const candidate of candidates) {
        const text = String(candidate || '');
        const code = ['AUTHORITY_CHANGED', 'AUTHORITY_NOT_ACTIVE']
          .find((sentinel) => text.includes(sentinel));
        if (code) return code;
      }
      return '';
    }

    isAuthorityFailureCode(value) {
      return !!this.authorityFailureCode(value);
    }

    publishAuthorityFailure(result, rpcName = '') {
      const code = this.authorityFailureCode(result);
      if (!this.isAuthorityFailureCode(code)) return false;
      if (typeof this.host.onAuthorityFailure === 'function') {
        this.host.onAuthorityFailure({
          code,
          rpcName: String(rpcName || ''),
          authorityState: String(result && (result.authorityState || result.authority_state) || '')
        });
      }
      return true;
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
        this.clearUserResumeMarker();
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

    staleLoginAttemptError(attemptId) {
      const error = new Error('STALE_LOGIN_ATTEMPT');
      error.code = 'STALE_LOGIN_ATTEMPT';
      error.loginAttemptId = Number(attemptId);
      error.currentLoginAttemptId = Number(this.loginAttemptEpoch);
      error.silent = true;
      return error;
    }

    isLoginAttemptCurrent(attemptId, siteSessionId = '') {
      return Number(attemptId) === Number(this.loginAttemptEpoch)
        && (!siteSessionId || String(this.siteSession && this.siteSession.id || '') === String(siteSessionId));
    }

    assertLoginAttempt(attemptId, siteSessionId = '') {
      if (this.isLoginAttemptCurrent(attemptId, siteSessionId)) return attemptId;
      throw this.staleLoginAttemptError(attemptId);
    }

    async rpc(name, params) {
      this.lastRpcName = String(name || '');
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
        this.publishAuthorityFailure(result, name);
        return result;
      } catch (error) {
        if (error && (error.staleSessionResponse === true || error.sessionInvalidHandled === true)) throw error;
        if (requestGeneration !== this.sessionGeneration) {
          throw this.staleSessionResponseError(name, requestGeneration, this.sessionErrorCode(error));
        }
        this.handleSessionError(error, requestGeneration);
        const authorityCode = this.authorityFailureCode(error);
        if (authorityCode) {
          this.publishAuthorityFailure({ error: authorityCode }, name);
          try { error.authorityFailureCode = authorityCode; } catch (_error) { /* original transport error remains authoritative */ }
        }
        throw error;
      }
    }

    async initialize(config) {
      this.config = Object.assign({}, config || {});
      if (!String(this.config.workspaceKey || '').trim()) throw new Error('workspaceKey is required');
      let raw;
      try {
        if (typeof this.transport.ensureAnonymous === 'function') await this.transport.ensureAnonymous(this.config);
        raw = await this.rpc('monthly_v7_get_status', { p_workspace_key: this.config.workspaceKey });
      } catch (error) {
        this.status = {
          mode: 'error', authorityState: '', authorityEpoch: 0,
          minimumClientVersion: 0,
          errorCode: String(error && (error.code || error.message) || 'V7_AUTHORITY_STATUS_UNAVAILABLE')
        };
        throw error;
      }
      const failAuthority = (code, authorityState = '', authorityEpoch = 0, minimumClientVersion = 0) => {
        this.status = { mode: 'error', authorityState, authorityEpoch, minimumClientVersion, errorCode: code };
        const error = new Error(code);
        error.code = code;
        throw error;
      };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.ok !== true) {
        failAuthority('V7_AUTHORITY_STATUS_INVALID');
      }
      const authorityState = String(raw && (raw.authority_state || raw.authorityState) || '');
      const rawAuthorityEpoch = raw.authority_epoch ?? raw.authorityEpoch;
      const rawMinimumClientVersion = raw.minimum_client_version ?? raw.minimumClientVersion;
      const authorityEpoch = Number(rawAuthorityEpoch);
      const minimumClientVersion = Number(rawMinimumClientVersion);
      if (!authorityState) failAuthority('V7_AUTHORITY_STATUS_INVALID');
      if (rawAuthorityEpoch == null || rawMinimumClientVersion == null
        || typeof rawAuthorityEpoch !== 'number' || !Number.isInteger(authorityEpoch) || authorityEpoch <= 0
        || typeof rawMinimumClientVersion !== 'number' || !Number.isInteger(minimumClientVersion) || minimumClientVersion <= 0) {
        failAuthority('V7_AUTHORITY_STATUS_INVALID', authorityState);
      }
      if (minimumClientVersion > this.clientVersion) {
        failAuthority('V7_CLIENT_VERSION_UNSUPPORTED', authorityState, authorityEpoch, minimumClientVersion);
      }
      if (authorityState !== 'NORMALIZED_ACTIVE' && authorityState !== 'LEGACY_ACTIVE') {
        failAuthority('V7_AUTHORITY_STATE_UNSUPPORTED', authorityState, authorityEpoch, minimumClientVersion);
      }
      this.status = {
        mode: authorityState === 'NORMALIZED_ACTIVE' ? 'v7' : 'legacy',
        authorityState,
        authorityEpoch,
        minimumClientVersion,
        errorCode: '',
        siteResumeErrorCode: '',
        userResumeErrorCode: ''
      };
      if (this.status.mode === 'v7' && this.sessionStorage) {
        try { this.siteSession = JSON.parse(this.sessionStorage.getItem('monthly_v7_site_session') || 'null'); } catch { this.siteSession = null; }
        try { this.userSession = JSON.parse(this.sessionStorage.getItem('monthly_v7_user_session') || 'null'); } catch { this.userSession = null; }
        try { this.user = JSON.parse(this.sessionStorage.getItem('monthly_v7_user_projection') || 'null'); } catch { this.user = null; }
        this.siteSessionPendingValidation = !!(this.siteSession && this.siteSession.id);
        this.userSessionPendingValidation = !!(this.userSession && this.userSession.id && this.user);
      }
      if (this.status.mode === 'v7' && !this.hasSiteSession()) {
        try {
          await this.restoreSiteFromMarker();
        } catch (error) {
          const code = String(error && (error.code || error.message) || '');
          if (['SITE_RESUME_INVALID', 'SITE_RESUME_AUTHORITY_CHANGED', 'RPC_TIMEOUT'].includes(code)) {
            this.status.siteResumeErrorCode = code;
          }
          if (this.isSiteResumeCapabilityMissing(error)) {
            this.status.siteResumeErrorCode = 'SITE_RESUME_CAPABILITY_MISSING';
          }
          if (!['SITE_RESUME_INVALID', 'SITE_RESUME_AUTHORITY_CHANGED', 'RPC_TIMEOUT'].includes(code)
            && !this.isSiteResumeCapabilityMissing(error)) throw error;
        }
      }
      return Object.assign({}, this.status);
    }

    isActive() { return this.status.mode === 'v7'; }
    hasSiteSession() { return this.isActive() && !!(this.siteSession && this.siteSession.id); }
    isSiteSessionPendingValidation() { return this.hasSiteSession() && this.siteSessionPendingValidation === true; }
    isSiteUnlocked() { return this.hasSiteSession() && !this.siteSessionPendingValidation; }
    isWriteReady() {
      return !!(this.userSession && this.userSession.id && this.user && !this.userSessionPendingValidation);
    }
    currentUser() { return this.isWriteReady() ? Object.assign({}, this.user) : null; }

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
      this.siteSessionPendingValidation = false;
      if (this.sessionStorage) this.sessionStorage.setItem('monthly_v7_site_session', JSON.stringify(this.siteSession));
      this.sessionGeneration += 1;
      return Object.assign({}, this.siteSession);
    }

    async login(username, password) {
      if (!this.isSiteUnlocked()) throw new Error('SITE_SESSION_REQUIRED');
      const attemptId = ++this.loginAttemptEpoch;
      const siteSessionId = String(this.siteSession.id || '');
      if (this.userSessionPendingValidation) {
        this.clearUserSession();
        this.sessionGeneration += 1;
      }
      let result;
      try {
        result = await this.transport.rpc('monthly_v7_login_user', {
          p_workspace_key: this.config.workspaceKey,
          p_site_session_id: siteSessionId,
          p_client_session_id: this.clientSessionId,
          p_username: String(username || '').trim(),
          p_password: String(password || '')
        });
      } catch (error) {
        this.assertLoginAttempt(attemptId, siteSessionId);
        this.handleSessionError(error, this.sessionGeneration);
        throw error;
      }
      this.assertLoginAttempt(attemptId, siteSessionId);
      const sessionCode = this.sessionErrorCode(result);
      if (sessionCode) {
        this.handleSessionError(result, this.sessionGeneration);
        const error = new Error(sessionCode);
        error.code = sessionCode;
        error.sessionInvalidHandled = true;
        error.silent = true;
        throw error;
      }
      if (!result || result.ok !== true) throw new Error(result && result.error || 'USER_LOGIN_FAILED');
      const provisionalSession = { id: result.user_session_id || result.userSessionId };
      const provisionalUser = Object.assign({}, result.user || {});
      this.userSession = provisionalSession;
      this.user = provisionalUser;
      this.userSessionPendingValidation = true;
      this.sessionGeneration += 1;
      try {
        await this.loadSnapshot({
          retryTransient: true,
          loginAttempt: { attemptId, siteSessionId, userSessionId: provisionalSession.id }
        });
        this.assertLoginAttempt(attemptId, siteSessionId);
        if (String(this.userSession && this.userSession.id || '') !== String(provisionalSession.id)
          || this.userSessionPendingValidation === true) {
          throw this.staleLoginAttemptError(attemptId);
        }
      } catch (error) {
        const ownsProvisional = this.isLoginAttemptCurrent(attemptId, siteSessionId)
          && String(this.userSession && this.userSession.id || '') === String(provisionalSession.id)
          && this.userSessionPendingValidation === true;
        if (ownsProvisional) this.clearUserSession('login-snapshot-failed');
        if (error && error.sessionInvalidHandled === true) {
          error.loginStage = 'snapshot';
          error.credentialsAccepted = true;
          throw error;
        }
        if (!this.isLoginAttemptCurrent(attemptId, siteSessionId)) throw this.staleLoginAttemptError(attemptId);
        error.loginStage = 'snapshot';
        error.credentialsAccepted = true;
        throw error;
      }
      if (this.sessionStorage) {
        this.sessionStorage.setItem('monthly_v7_user_session', JSON.stringify(this.userSession));
        this.sessionStorage.setItem('monthly_v7_user_projection', JSON.stringify(this.user));
      }
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

    pendingReorderOrder(snapshot) {
      const reportId = String(snapshot && snapshot.report && snapshot.report.id || '');
      if (!this.draftStorage || !reportId) return null;
      const raw = this.draftStorage.getItem(`monthly_v7_pending:reorder_modules:${reportId}`);
      if (raw === null) return null;
      try {
        const pending = JSON.parse(raw);
        const params = this.validatePendingEnvelope(pending);
        const actorId = String(this.user && this.user.id || '');
        const order = params && params.p_module_order;
        const authorityIds = (snapshot.modules || []).map((row) => String(row.id));
        const orderIds = Array.isArray(order) ? order.map(String) : [];
        const exactSet = orderIds.length === authorityIds.length
          && new Set(orderIds).size === authorityIds.length
          && authorityIds.every((id) => orderIds.includes(id));
        if (!actorId || String(pending.actorUserId || '') !== actorId
          || String(params.p_workspace_key || '') !== String(this.config && this.config.workspaceKey || '')
          || String(params.p_report_id || '') !== reportId
          || !Number.isFinite(Number(params.p_expected_report_revision))
          || !exactSet) return null;
        return orderIds;
      } catch (_error) {
        // Keep malformed or ambiguous pending data untouched. A later write will
        // surface PENDING_OPERATION_UNRESOLVED; it must never influence display.
        return null;
      }
    }

    applyPendingReorderDisplay(snapshot) {
      const order = this.pendingReorderOrder(snapshot);
      if (!order) return false;
      const ranks = new Map(order.map((id, index) => [id, index + 1]));
      for (const row of snapshot.modules || []) row._displaySortRank = ranks.get(String(row.id));
      return true;
    }

    async mergeSnapshotWithProtectedLocal(snapshot) {
      const incoming = this.cloneJson(snapshot, {});
      const previous = this.snapshot || {
        report: this.cloneJson(incoming.report, {}),
        modules: this.cloneJson(incoming.modules, []),
        records: this.cloneJson(incoming.records, []),
        localOnlyModules: this.cloneJson(incoming.localOnlyModules, [])
      };
      // Legacy-only rows are quarantine evidence, never live create intents. Do
      // not carry localOnlyModules from an older client/snapshot into authority.
      incoming.localOnlyModules = [];
      const preserveAcceptedRecoveryOrder = previous.legacyLocalRecovery
        && previous.legacyLocalRecovery.hasAcceptedRecovery === true
        && previous.legacyLocalRecovery.orderChanged === true;
      if (preserveAcceptedRecoveryOrder) {
        const previousModuleRanks = new Map((previous.modules || []).map((row) => [
          String(row.id),
          Number(row._displaySortRank)
        ]));
        for (const row of incoming.modules || []) {
          const previousRank = previousModuleRanks.get(String(row.id));
          if (Number.isFinite(previousRank)) row._displaySortRank = previousRank;
        }
      }
      if (!incoming.legacyLocalRecovery && previous.legacyLocalRecovery) {
        incoming.legacyLocalRecovery = this.cloneJson(previous.legacyLocalRecovery, null);
      }
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
          incoming.report._serverRevision = Number(server.revision || 0);
          incoming.report._serverPayload = {
            title: String(server.title || ''),
            date: String(server.date || ''),
            period: this.cloneJson(server.period, {}),
            settings: this.cloneJson(server.settings, {})
          };
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
      if (!this.hasSiteSession()) throw new Error('SITE_SESSION_REQUIRED');
      const retryTransient = options.retryTransient === true;
      const loginAttempt = options.loginAttempt || null;
      const assertLoadOwnership = () => {
        if (!loginAttempt) return;
        this.assertLoginAttempt(loginAttempt.attemptId, loginAttempt.siteSessionId);
        if (String(this.userSession && this.userSession.id || '') !== String(loginAttempt.userSessionId || '')
          || this.userSessionPendingValidation !== true) {
          throw this.staleLoginAttemptError(loginAttempt.attemptId);
        }
      };
      assertLoadOwnership();
      let snapshot;
      let attempt = 0;
      while (true) {
        try {
          snapshot = await this.rpc('monthly_v7_get_snapshot', {
            p_workspace_key: this.config.workspaceKey,
            p_site_session_id: this.siteSession.id,
            p_user_session_id: this.userSession ? this.userSession.id : null
          });
          assertLoadOwnership();
          break;
        } catch (error) {
          if (error && error.sessionInvalidHandled === true) throw error;
          assertLoadOwnership();
          attempt += 1;
          if (!retryTransient || attempt >= 2 || error?.code !== 'RPC_TIMEOUT') throw error;
        }
      }
      if (!snapshot || snapshot.ok !== true) throw new Error(snapshot && snapshot.error || 'SNAPSHOT_FAILED');
      const normalizedSnapshot = this.cloneJson(snapshot, {});
      if (!normalizedSnapshot.workspace) {
        normalizedSnapshot.workspace = {
          id: snapshot.workspaceId || snapshot.workspace_id || '',
          authorityState: snapshot.authorityState || snapshot.authority_state || this.status.authorityState,
          authorityEpoch: Number(snapshot.authorityEpoch ?? snapshot.authority_epoch ?? this.status.authorityEpoch ?? 0)
        };
      }
      let candidate = normalizedSnapshot;
      if (!this.snapshot && options.preserveLegacyLocal !== false
        && typeof this.host.getLegacyLocalState === 'function'
        && this.core && typeof this.core.reconcileLegacyLocalModules === 'function') {
        const legacyLocal = await this.host.getLegacyLocalState(normalizedSnapshot);
        assertLoadOwnership();
        const authoritySourceId = String(normalizedSnapshot.report && normalizedSnapshot.report.legacyFileId || '');
        const recoverySourceId = String(legacyLocal && legacyLocal.recoverySourceId || '');
        const reportMatches = legacyLocal
          && authoritySourceId
          && recoverySourceId === authoritySourceId
          && String(legacyLocal.fileId || '') === authoritySourceId;
        if (reportMatches && Array.isArray(legacyLocal.modules) && legacyLocal.modules.length) {
          const reconciled = this.core.reconcileLegacyLocalModules(
            normalizedSnapshot.modules,
            legacyLocal.modules,
            { localTimestamp: Number(legacyLocal.timestamp || 0) }
          );
          candidate = this.cloneJson(normalizedSnapshot, {});
          candidate.modules = reconciled.serverRows;
          candidate.localOnlyModules = reconciled.localOnlyModules;
          const legacyRecoveries = [];
          for (const recovery of reconciled.recovered) {
            const existingDraft = this.readDraft('module', recovery.entityId);
            if (existingDraft) {
              // A V7 draft/pending intent is newer and more specific than a legacy
              // IndexedDB snapshot.  Never replace it with the cutover recovery.
              // Restore the authoritative server row before protected-merge so the
              // draft keeps the true server payload/revision as its CAS baseline.
              const authoritative = (normalizedSnapshot.modules || [])
                .find((row) => String(row.id) === String(recovery.entityId));
              const index = (candidate.modules || [])
                .findIndex((row) => String(row.id) === String(recovery.entityId));
              if (authoritative && index >= 0) {
                const displayRank = Number(candidate.modules[index]._displaySortRank);
                candidate.modules[index] = this.cloneJson(authoritative, {});
                if (Number.isFinite(displayRank)) candidate.modules[index]._displaySortRank = displayRank;
              }
              continue;
            }
            this.saveDraft('module', recovery.entityId, recovery.payload, recovery.baseRevision);
            legacyRecoveries.push(recovery);
          }
          // The snapshot does not expose a comparable report updatedAt value, so
          // legacy report metadata can never prove freshness here. Preserve it in
          // the durable recovery row/quarantine, but do not create a writable draft.
          const localMeta = legacyLocal.reportMeta;
          const serverMeta = normalizedSnapshot.report;
          let reportMetaQuarantined = false;
          if (localMeta && serverMeta) {
            const localCore = {
              title: String(localMeta.title || ''),
              date: String(localMeta.date || ''),
              period: this.cloneJson(localMeta.period, {})
            };
            const serverCore = {
              title: String(serverMeta.title || ''),
              date: String(serverMeta.date || ''),
              period: this.cloneJson(serverMeta.period, {})
            };
            reportMetaQuarantined = JSON.stringify(localCore) !== JSON.stringify(serverCore);
          }
          const quarantinedCount = Array.isArray(reconciled.quarantinedModules)
            ? reconciled.quarantinedModules.length
            : 0;
          if (legacyRecoveries.length > 0 || reconciled.orderChanged === true
            || quarantinedCount > 0 || reportMetaQuarantined) {
            candidate.legacyLocalRecovery = {
              recoveredCount: legacyRecoveries.length,
              localOnlyCount: 0,
              quarantinedCount,
              orderChanged: reconciled.orderChanged === true,
              reportMetaRecovered: false,
              reportMetaQuarantined,
              hasAcceptedRecovery: legacyRecoveries.length > 0 || reconciled.orderChanged === true,
              sourceTimestamp: Number(legacyLocal.timestamp || 0),
              recoverySourceId
            };
          } else if (typeof this.host.clearLegacyRecovery === 'function') {
            await this.host.clearLegacyRecovery(normalizedSnapshot.report && normalizedSnapshot.report.id);
            assertLoadOwnership();
          }
        } else if (legacyLocal && Array.isArray(legacyLocal.modules) && legacyLocal.modules.length) {
          candidate = this.cloneJson(normalizedSnapshot, {});
          candidate.localOnlyModules = [];
          candidate.legacyLocalRecovery = {
            recoveredCount: 0,
            localOnlyCount: 0,
            quarantinedCount: legacyLocal.modules.length,
            orderChanged: false,
            reportMetaRecovered: false,
            reportMetaQuarantined: !!legacyLocal.reportMeta,
            hasAcceptedRecovery: false,
            sourceMismatch: true,
            sourceTimestamp: Number(legacyLocal.timestamp || 0),
            recoverySourceId
          };
        }
      }
      const merged = options.preserveLocalIntents === false ? candidate : await this.mergeSnapshotWithProtectedLocal(candidate);
      this.applyPendingReorderDisplay(merged);
      assertLoadOwnership();
      this.snapshot = merged;
      const bundle = this.core.legacyBundleFromSnapshot(merged);
      this.watermark = Number(snapshot.watermark || 0);
      if (typeof this.host.applyBundle === 'function') await this.host.applyBundle(bundle, merged);
      assertLoadOwnership();
      const siteSessionWasPendingValidation = this.siteSessionPendingValidation === true;
      this.siteSessionPendingValidation = false;
      if (this.userSession && this.user && this.userSessionPendingValidation) {
        this.userSessionPendingValidation = false;
        this.notifySessionStateChanged('user-session-validated');
      } else if (siteSessionWasPendingValidation) {
        this.notifySessionStateChanged('site-session-validated');
      }
      return merged;
    }

    currentReport() {
      return this.snapshot && this.snapshot.report ? this.snapshot.report : null;
    }

    reportAuthorityRevision(report = this.currentReport()) {
      const serverRevision = Number(report && report._serverRevision);
      if (Number.isFinite(serverRevision) && serverRevision > 0) return serverRevision;
      return Number(report && report.revision || 0);
    }

    setReportAuthorityRevision(report, value) {
      const revision = Number(value);
      if (!report || !Number.isFinite(revision) || revision <= 0) return revision;
      report.revision = revision;
      report._serverRevision = revision;
      return revision;
    }

    requireUserSession() {
      if (!this.isActive()) throw new Error('V7 authority is not active');
      if (!this.isWriteReady()) throw new Error('USER_SESSION_REQUIRED');
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

    captureCurrentActorPendingSaveIntents() {
      const intents = new Map();
      const ambiguous = new Set();
      if (!this.draftStorage) return intents;
      const actorUserId = String(this.currentUser() && this.currentUser().id || '');
      if (!actorUserId) return intents;
      const addIntent = (entityType, entityId, expectedRevision, payload) => {
        const type = String(entityType || '');
        const id = String(entityId || '');
        const baseRevision = Number(expectedRevision);
        if (!['module', 'report_meta'].includes(type)
          || !id || !Number.isSafeInteger(baseRevision) || baseRevision < 0
          || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const key = this.leaseKey(type, id);
        if (ambiguous.has(key)) return;
        const intent = {
          entityType: type, entityId: id, revision: baseRevision + 1,
          payload: this.cloneJson(payload, {})
        };
        const existing = intents.get(key);
        if (existing && (existing.revision !== intent.revision
          || this.operationCanonical(existing.payload) !== this.operationCanonical(intent.payload))) {
          intents.delete(key);
          ambiguous.add(key);
          return;
        }
        intents.set(key, intent);
      };
      const readPending = (rpcName, pendingKey, consume) => {
        const raw = this.draftStorage.getItem(`monthly_v7_pending:${pendingKey}`);
        if (raw === null) return;
        try {
          const pending = JSON.parse(raw);
          const params = this.validatePendingEnvelope(pending);
          if (String(pending.actorUserId || '') !== actorUserId) return;
          consume(params);
        } catch (_error) {
          // Invalid/ambiguous pending evidence can never identify an own hint.
        }
      };
      const moduleIds = new Set((this.snapshot && this.snapshot.modules || [])
        .map((row) => String(row && row.id || '')).filter(Boolean));
      for (const lease of this.leases.values()) {
        if (String(lease && lease.entityType || '') === 'module' && lease.entityId) {
          moduleIds.add(String(lease.entityId));
        }
      }
      for (const entityId of moduleIds) {
        const pendingKey = `save_module:${entityId}`;
        readPending('monthly_v7_save_module', pendingKey, (params) => {
          if (!this.pendingTargetsEntity('monthly_v7_save_module', pendingKey, params, 'module', entityId)) return;
          addIntent('module', entityId, params.p_expected_revision, params.p_payload);
        });
      }
      const reportId = String(this.currentReport() && this.currentReport().id || '');
      if (reportId) {
        const pendingKey = `save_module_batch:${reportId}`;
        readPending('monthly_v7_save_module_batch', pendingKey, (params) => {
          for (const row of Array.isArray(params.p_changes) ? params.p_changes : []) {
            const entityId = String(row && row.moduleId || '');
            if (!this.pendingTargetsEntity('monthly_v7_save_module_batch', pendingKey, params, 'module', entityId)) continue;
            addIntent('module', entityId, row.expectedRevision, row.payload);
          }
        });
        const metaPendingKey = `save_report_meta:${reportId}`;
        readPending('monthly_v7_save_report_meta', metaPendingKey, (params) => {
          if (!this.pendingTargetsEntity('monthly_v7_save_report_meta', metaPendingKey, params, 'report_meta', reportId)) return;
          addIntent(
            'report_meta', reportId, params.p_expected_revision,
            this.pendingEntityPayload('monthly_v7_save_report_meta', params, reportId)
          );
        });
      }
      return intents;
    }

    changeConvergesWithLocalAuthority(event, entity, pendingIntent = null) {
      if (!event || !entity || entity.ok !== true || entity.deleted === true) return false;
      const entityType = String(event.entityType || event.entity_type || '');
      if (!['module', 'report_meta'].includes(entityType)) return false;
      const eventRevision = Number(event.revision);
      const entityRevision = Number(entity.revision);
      if (!Number.isSafeInteger(eventRevision) || eventRevision <= 0
        || !Number.isSafeInteger(entityRevision) || entityRevision <= 0
        || eventRevision > entityRevision) return false;
      const payloadMatches = (payload) => payload && typeof payload === 'object'
        && !Array.isArray(payload)
        && this.operationCanonical(payload) === this.operationCanonical(entity.payload);
      if (pendingIntent && entityRevision === Number(pendingIntent.revision)
        && payloadMatches(pendingIntent.payload)) return true;
      const entityId = String(event.entityId || event.entity_id || '');
      let row = null;
      let confirmedPayload = null;
      if (entityType === 'module') {
        row = (this.snapshot && this.snapshot.modules || [])
          .find((entry) => String(entry && entry.id || '') === entityId);
      } else {
        row = this.currentReport();
        if (String(row && row.id || '') === entityId) {
          confirmedPayload = {
            title: String(row.title || ''),
            date: String(row.date || ''),
            period: this.cloneJson(row.period, {}),
            settings: this.cloneJson(row.settings, {})
          };
        } else {
          row = null;
        }
      }
      if (!row) return false;
      const protectedRevision = Number(row._serverRevision);
      const hasProtectedAuthority = Number.isSafeInteger(protectedRevision) && protectedRevision > 0
        && (entityType !== 'module' || (row._serverPayload && typeof row._serverPayload === 'object'));
      const confirmedRevision = hasProtectedAuthority ? protectedRevision : Number(row.revision);
      if (entityType === 'module') {
        confirmedPayload = hasProtectedAuthority ? row._serverPayload : row.payload;
      }
      return Number.isSafeInteger(confirmedRevision) && confirmedRevision > 0
        && entityRevision === confirmedRevision
        && payloadMatches(confirmedPayload);
    }

    confirmModuleAuthority(entityId, revision, payload) {
      const id = String(entityId || '');
      const confirmedRevision = Number(revision);
      if (!id || !Number.isSafeInteger(confirmedRevision) || confirmedRevision <= 0
        || !this.snapshot || !Array.isArray(this.snapshot.modules)) return null;
      const row = this.snapshot.modules.find((entry) => String(entry && entry.id || '') === id);
      if (!row) return null;
      row.revision = confirmedRevision;
      row.payload = this.cloneJson(payload, {});
      delete row._serverRevision;
      delete row._serverPayload;
      return row;
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

    async reconcileSupersededPending(rpcName, pendingKey, targets, options = {}) {
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
        result: await this.executeOperation(rpcName, previousParams, pendingKey, options),
        previousParams
      };
    }

    async replayPendingBeforeLease(rpcName, pendingKey, desiredParams, options = {}) {
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
      return this.executeOperation(rpcName, previousParams, pendingKey, options);
    }

    async executeOperation(rpcName, params, pendingKey, options = {}) {
      const storageKey = `monthly_v7_pending:${pendingKey}`;
      const signature = JSON.stringify(params);
      const requestedOrigin = String(options.saveOrigin || 'unspecified');
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
      const startedAt = new Date().toISOString();
      this.setOperationReceipt({
        state: 'SAVING', rpcName: String(rpcName || ''), pendingKey: String(pendingKey || ''),
        operationId: String(operationId || ''), requestedOrigin,
        saveOrigin: pending ? 'pending-replay' : requestedOrigin,
        attempt: 0, errorCode: '', startedAt, updatedAt: startedAt
      });
      const storedEnvelope = { operationId, signature: operationSignature, createdAt: new Date().toISOString() };
      if (pending && pending.actorUserId) storedEnvelope.actorUserId = pending.actorUserId;
      else if (!pending && currentActorId) storedEnvelope.actorUserId = currentActorId;
      if (this.draftStorage) this.draftStorage.setItem(storageKey, JSON.stringify(storedEnvelope));
      const request = Object.assign({}, operationParams, { p_operation_id: operationId });
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.setOperationReceipt(Object.assign({}, this.operationReceipt, {
          state: 'SAVING', attempt: attempt + 1, errorCode: '', updatedAt: new Date().toISOString()
        }));
        try {
          const result = await this.rpc(rpcName, request);
          const preserveMismatch = result && result.ok === false && result.error === 'IDEMPOTENCY_MISMATCH';
          if (this.draftStorage && !preserveMismatch) this.draftStorage.removeItem(storageKey);
          const resultCode = result && result.ok === false ? String(result.error || '') : '';
          this.setOperationReceipt(Object.assign({}, this.operationReceipt, {
            state: result && result.ok === true
              ? 'CLOUD_CONFIRMED'
              : this.operationFailureState(resultCode),
            errorCode: resultCode,
            updatedAt: new Date().toISOString()
          }));
          return result;
        } catch (error) {
          lastError = error;
          const authorityCode = this.authorityFailureCode(error);
          const code = authorityCode || String(error && (error.code || error.message) || '');
          const message = String(error && error.message || error || '');
          const resultUnknown = code === 'RPC_TIMEOUT'
            || /failed to fetch|networkerror|network request failed/i.test(message);
          this.setOperationReceipt(Object.assign({}, this.operationReceipt, {
            state: this.operationFailureState(code, { error, resultUnknown }),
            errorCode: code,
            updatedAt: new Date().toISOString()
          }));
          if (authorityCode || this.sessionErrorCode(error) || error?.code === 'STALE_SESSION_RESPONSE') throw error;
        }
      }
      throw lastError;
    }

    async executeSensitiveOperation(rpcName, params, pendingKey, options = {}) {
      const storageKey = `monthly_v7_pending:${pendingKey}`;
      const requestedOrigin = String(options.saveOrigin || 'manual');
      const currentActorId = String((this.currentUser() && this.currentUser().id) || '');
      const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      let pending = null;
      if (this.draftStorage) {
        const raw = this.draftStorage.getItem(storageKey);
        if (raw !== null) {
          try { pending = JSON.parse(raw); }
          catch (_error) { throw this.pendingOperationError(); }
          const keys = pending && typeof pending === 'object' && !Array.isArray(pending)
            ? Object.keys(pending).sort()
            : [];
          const expectedKeys = [
            'actorUserId', 'createdAt', 'operationId', 'pendingKey', 'resultUnknown',
            'rpcName', 'sensitive'
          ].sort();
          if (keys.length !== expectedKeys.length
            || !keys.every((key, index) => key === expectedKeys[index])
            || pending.sensitive !== true
            || pending.resultUnknown !== true
            || pending.rpcName !== rpcName
            || pending.pendingKey !== pendingKey
            || typeof pending.operationId !== 'string' || !operationIdPattern.test(pending.operationId)
            || typeof pending.createdAt !== 'string'
            || !canonicalTimestampPattern.test(pending.createdAt)
            || !Number.isFinite(Date.parse(pending.createdAt))
            || new Date(pending.createdAt).toISOString() !== pending.createdAt
            || typeof pending.actorUserId !== 'string' || !pending.actorUserId) {
            throw this.pendingOperationError();
          }
          if (pending.actorUserId !== currentActorId) {
            throw this.pendingOperationError('PENDING_OPERATION_ACTOR_MISMATCH');
          }
        }
      }
      const operationId = pending ? pending.operationId : this.operationIdFactory();
      const startedAt = new Date().toISOString();
      const envelope = {
        operationId: String(operationId || ''),
        createdAt: pending ? pending.createdAt : startedAt,
        actorUserId: currentActorId,
        sensitive: true,
        rpcName: String(rpcName || ''),
        pendingKey: String(pendingKey || ''),
        resultUnknown: true
      };
      if (this.draftStorage) this.draftStorage.setItem(storageKey, JSON.stringify(envelope));
      this.setOperationReceipt({
        state: 'SAVING', rpcName: String(rpcName || ''), pendingKey: String(pendingKey || ''),
        operationId: String(operationId || ''), requestedOrigin,
        saveOrigin: pending ? 'pending-replay' : requestedOrigin,
        attempt: 0, errorCode: '', startedAt, updatedAt: startedAt
      });
      const request = Object.assign({}, params, { p_operation_id: operationId });
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.draftStorage) this.draftStorage.setItem(storageKey, JSON.stringify(envelope));
        this.setOperationReceipt(Object.assign({}, this.operationReceipt, {
          state: 'SAVING', attempt: attempt + 1, errorCode: '', updatedAt: new Date().toISOString()
        }));
        try {
          const result = await this.rpc(rpcName, request);
          const preserveMismatch = result && result.ok === false && result.error === 'IDEMPOTENCY_MISMATCH';
          if (this.draftStorage && !preserveMismatch) this.draftStorage.removeItem(storageKey);
          const resultCode = result && result.ok === false ? String(result.error || '') : '';
          this.setOperationReceipt(Object.assign({}, this.operationReceipt, {
            state: result && result.ok === true
              ? 'CLOUD_CONFIRMED'
              : this.operationFailureState(resultCode),
            errorCode: resultCode,
            updatedAt: new Date().toISOString()
          }));
          return result;
        } catch (error) {
          lastError = error;
          const authorityCode = this.authorityFailureCode(error);
          const code = authorityCode || String(error && (error.code || error.message) || '');
          const message = String(error && error.message || error || '');
          const resultUnknown = code === 'RPC_TIMEOUT'
            || /failed to fetch|networkerror|network request failed/i.test(message);
          this.setOperationReceipt(Object.assign({}, this.operationReceipt, {
            state: this.operationFailureState(code, { error, resultUnknown }),
            errorCode: code,
            updatedAt: new Date().toISOString()
          }));
          if (!resultUnknown && this.draftStorage) this.draftStorage.removeItem(storageKey);
          if (authorityCode || this.sessionErrorCode(error) || error?.code === 'STALE_SESSION_RESPONSE') throw error;
        }
      }
      throw lastError;
    }

    async saveModule(item, options = {}) {
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
        [{ entityType: 'module', entityId, payload: this.modulePayload(item) }],
        options
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
        } else if (code === 'LEASE_LOST' || code === 'REVISION_CONFLICT' || this.isAuthorityFailureCode(code)) {
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
        this.confirmModuleAuthority(entityId, item._v7Revision, payload);
        this.watermark = Math.max(this.watermark, Number(result.watermark || 0));
        this.clearDraft('module', entityId);
        if (typeof this.host.onItemSaved === 'function') this.host.onItemSaved({ entityType: 'module', entityId, revision: item._v7Revision });
        return result;
      };

      replayLease = this.getLease('module', entityId);
      const replayed = await this.replayPendingBeforeLease(
        'monthly_v7_save_module', pendingKey, desiredParams, options
      );
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
      }), pendingKey, options);
      this.assertSessionContext(operationContext, 'save_module');
      if (!result || result.ok !== true) return fail(result, false);
      return complete(result, false);
    }

    async saveReportMeta(meta, options = {}) {
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
      let replayLease = null;
      let operationLease = null;
      const supersededLease = this.getLease('report_meta', report.id);
      const command = (result) => {
        try {
          return this.commandResult(result, 'SAVE_REPORT_META_FAILED');
        } catch (error) {
          if (error && (['REVISION_CONFLICT', 'LEASE_LOST'].includes(error.code)
            || this.isAuthorityFailureCode(error.code))) {
            if (['REVISION_CONFLICT', 'LEASE_LOST'].includes(error.code)) {
              this.forgetCapturedLease(operationLease || replayLease || supersededLease);
            }
            if (typeof this.host.onConflict === 'function') {
              this.host.onConflict({
                entityType: 'report_meta', entityId: report.id,
                draft: payload, baseRevision: Number(report.revision), result: error.result
              });
            }
          }
          throw error;
        }
      };
      const superseded = await this.reconcileSupersededPending(
        'monthly_v7_save_report_meta', pendingKey,
        [{ entityType: 'report_meta', entityId: report.id, payload }],
        options
      );
      this.assertSessionContext(operationContext, 'save_report_meta');
      if (superseded) {
        const priorResult = superseded.result;
        if (priorResult && priorResult.ok === true) {
          this.setReportAuthorityRevision(report, priorResult.revision);
          report.title = String(superseded.previousParams.p_title || '');
          report.date = String(superseded.previousParams.p_report_date || '');
          report.period = this.cloneJson(superseded.previousParams.p_period, {});
          report.settings = this.cloneJson(superseded.previousParams.p_settings, {});
          this.watermark = Math.max(this.watermark, Number(priorResult.watermark || 0));
          this.forgetCapturedLease(supersededLease);
        } else if (priorResult && priorResult.error === 'LEASE_LOST') {
          this.forgetCapturedLease(supersededLease);
        } else {
          return command(priorResult);
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
      const complete = async (result, releaseCurrent = false) => {
        if (releaseCurrent) {
          await this.releaseCapturedLease(operationLease || replayLease || supersededLease, operationContext);
          this.assertSessionContext(operationContext, 'save_report_meta_cleanup');
        } else {
          this.forgetCapturedLease(operationLease);
        }
        this.assertSessionContext(operationContext, 'save_report_meta');
        this.setReportAuthorityRevision(report, result.revision);
        Object.assign(report, payload);
        this.clearDraft('report_meta', report.id);
        if (typeof this.host.onItemSaved === 'function') {
          this.host.onItemSaved({ entityType: 'report_meta', entityId: report.id, revision: Number(result.revision) });
        }
        return result;
      };
      replayLease = this.getLease('report_meta', report.id);
      const replayed = await this.replayPendingBeforeLease(
        'monthly_v7_save_report_meta', pendingKey, desiredParams, options
      );
      this.assertSessionContext(operationContext, 'save_report_meta');
      if (replayed) {
        if (replayed.ok === true) return complete(command(replayed), true);
        if (replayed.error !== 'LEASE_LOST') {
          await this.releaseCapturedLease(replayLease, operationContext);
          this.assertSessionContext(operationContext, 'save_report_meta_cleanup');
          return command(replayed);
        }
        this.forgetCapturedLease(replayLease);
      }
      operationLease = this.getLease('report_meta', report.id) || await this.claimLease('report_meta', report.id);
      this.assertSessionContext(operationContext, 'save_report_meta');
      const result = command(await this.executeOperation('monthly_v7_save_report_meta', Object.assign({}, desiredParams, {
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken
      }), pendingKey, options));
      this.assertSessionContext(operationContext, 'save_report_meta');
      return complete(result, false);
    }

    async reconcilePendingCreateModule(items) {
      this.requireUserSession();
      const operationContext = this.captureSessionContext();
      this.assertSessionContext(operationContext, 'reconcile_create_module');
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      const pendingKey = `create_module:${report.id}`;
      if (!this.draftStorage) return null;
      const storageKey = `monthly_v7_pending:${pendingKey}`;
      const pendingRaw = this.draftStorage.getItem(storageKey);
      if (pendingRaw === null) return null;
      let pending;
      try { pending = JSON.parse(pendingRaw); }
      catch (_error) { throw this.pendingOperationError(); }
      const previousParams = this.validatePendingEnvelope(pending);
      pending = this.bindPendingActor('monthly_v7_create_module', pending, previousParams);
      const expectedKeys = [
        'p_workspace_key', 'p_user_session_id', 'p_client_session_id',
        'p_report_id', 'p_expected_report_revision',
        'p_lease_id', 'p_fencing_token', 'p_payload'
      ].sort();
      const actualKeys = Object.keys(previousParams).sort();
      if (actualKeys.length !== expectedKeys.length
        || !actualKeys.every((key, index) => key === expectedKeys[index])
        || String(previousParams.p_workspace_key || '') !== String(this.config.workspaceKey || '')
        || String(previousParams.p_report_id || '') !== String(report.id)
        || !Number.isSafeInteger(previousParams.p_expected_report_revision)
        || previousParams.p_expected_report_revision < 0
        || !previousParams.p_payload || typeof previousParams.p_payload !== 'object'
        || Array.isArray(previousParams.p_payload)) {
        throw this.pendingOperationError();
      }
      const pendingPayload = this.cloneJson(previousParams.p_payload, {});
      const matches = (Array.isArray(items) ? items : []).filter((item) => (
        this.operationCanonical(this.modulePayload(item)) === this.operationCanonical(pendingPayload)
      ));
      if (matches.length !== 1) throw this.pendingOperationError();
      const item = matches[0];
      previousParams.p_user_session_id = operationContext.userSessionId;
      previousParams.p_client_session_id = operationContext.clientSessionId;
      const result = await this.executeOperation(
        'monthly_v7_create_module', previousParams, pendingKey
      );
      this.assertSessionContext(operationContext, 'reconcile_create_module');
      if (!result || result.ok !== true) {
        if (result && result.error === 'LEASE_LOST') {
          const replayLease = this.getLease('report_structure', report.id);
          this.forgetCapturedLease(replayLease);
          return result;
        }
        return this.commandResult(result, 'CREATE_MODULE_FAILED');
      }
      const entityId = String(result.entityId || result.entity_id || '');
      const revision = Number(result.revision);
      if (!entityId || !Number.isFinite(revision)
        || (item._v7Id && String(item._v7Id) !== entityId)) {
        const envelope = {
          operationId: pending.operationId,
          signature: JSON.stringify(previousParams),
          createdAt: pending.createdAt,
          actorUserId: pending.actorUserId
        };
        this.draftStorage.setItem(storageKey, JSON.stringify(envelope));
        throw this.pendingOperationError();
      }
      item._v7Id = entityId;
      item._v7Revision = revision;
      this.setReportAuthorityRevision(report, result.reportRevision ?? result.report_revision);
      this.watermark = Math.max(this.watermark, Number(result.watermark || 0));
      if (!Array.isArray(this.snapshot.modules)) this.snapshot.modules = [];
      let row = this.snapshot.modules.find((entry) => String(entry && entry.id || '') === entityId);
      if (!row) {
        row = {
          id: entityId,
          legacyItemId: `v7:${entityId}`,
          sortRank: Number(result.sortRank ?? result.sort_rank ?? this.snapshot.modules.length + 1)
        };
        this.snapshot.modules.push(row);
      }
      row.revision = revision;
      row.payload = this.cloneJson(pendingPayload, {});
      if (typeof this.host.onModuleCreated === 'function') this.host.onModuleCreated(item);
      return result;
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
        p_expected_report_revision: this.reportAuthorityRevision(report),
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken,
        p_payload: cleanPayload
      }, `create_module:${report.id}`), 'CREATE_MODULE_FAILED');
      this.assertSessionContext(operationContext, 'create_module');
      this.setReportAuthorityRevision(report, result.reportRevision ?? result.report_revision);
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
      const pendingKey = `reorder_modules:${report.id}`;
      const desiredParams = {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: operationContext.userSessionId,
        p_client_session_id: operationContext.clientSessionId,
        p_report_id: report.id,
        p_expected_report_revision: this.reportAuthorityRevision(report),
        p_module_order: order
      };
      const replayLease = this.getLease('report_structure', report.id);
      const replayed = await this.replayPendingBeforeLease(
        'monthly_v7_reorder_modules', pendingKey, desiredParams
      );
      this.assertSessionContext(operationContext, 'reorder_modules');
      if (replayed) {
        this.forgetCapturedLease(replayLease);
        if (replayed.ok === true) {
          this.setReportAuthorityRevision(report, replayed.reportRevision ?? replayed.report_revision);
          this.watermark = Math.max(this.watermark, Number(replayed.watermark || 0));
          return replayed;
        }
        if (replayed.error !== 'LEASE_LOST') {
          return this.commandResult(replayed, 'REORDER_MODULES_FAILED');
        }
      }
      const operationLease = this.getLease('report_structure', report.id)
        || await this.claimLease('report_structure', report.id);
      this.assertSessionContext(operationContext, 'reorder_modules');
      const result = this.commandResult(await this.executeOperation('monthly_v7_reorder_modules', Object.assign({}, desiredParams, {
        p_lease_id: operationLease.leaseId,
        p_fencing_token: operationLease.fencingToken
      }), pendingKey), 'REORDER_MODULES_FAILED');
      this.assertSessionContext(operationContext, 'reorder_modules');
      this.setReportAuthorityRevision(report, result.reportRevision ?? result.report_revision);
      this.watermark = Math.max(this.watermark, Number(result.watermark || 0));
      this.forgetCapturedLease(operationLease);
      return result;
    }

    async saveModuleBatch(items, options = {}) {
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
        })),
        options
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
        const replayed = await this.replayPendingBeforeLease(
          'monthly_v7_save_module_batch', pendingKey, desiredParams, options
        );
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
          }), pendingKey, options), 'SAVE_MODULE_BATCH_FAILED');
          this.assertSessionContext(operationContext, 'save_module_batch');
        }
      } catch (error) {
        await this.releaseCapturedLease(operationLease, operationContext);
        if ((['REVISION_CONFLICT', 'LEASE_LOST'].includes(error.code)
          || this.isAuthorityFailureCode(error.code))
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
        if (updates.has(item._v7Id)) {
          item._v7Revision = updates.get(item._v7Id);
          const submitted = changes.find((row) => String(row.moduleId) === String(item._v7Id));
          if (submitted) this.confirmModuleAuthority(item._v7Id, item._v7Revision, submitted.payload);
        }
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
          p_expected_report_revision: this.reportAuthorityRevision(report),
          p_structure_lease_id: structureLease.leaseId,
          p_structure_fencing_token: structureLease.fencingToken,
          p_module_lease_id: moduleLease.leaseId,
          p_module_fencing_token: moduleLease.fencingToken
        }, `delete_module:${entityId}`), 'DELETE_MODULE_FAILED');
        this.assertSessionContext(operationContext, 'delete_module');
        this.setReportAuthorityRevision(report, result.reportRevision ?? result.report_revision);
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
        if (['LEASE_LOST', 'REVISION_CONFLICT'].includes(error.code)
          || this.isAuthorityFailureCode(error.code)) {
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
      const result = this.commandResult(await this.executeSensitiveOperation('monthly_v7_create_user', {
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
      const params = {
        p_workspace_key: this.config.workspaceKey,
        p_user_session_id: this.userSession.id,
        p_client_session_id: this.clientSessionId,
        p_target_user_id: targetUserId,
        p_username: String(profile && profile.username || '').trim(),
        p_display_name: String(profile && profile.displayName || profile && profile.username || '').trim(),
        p_role: String(profile && profile.role || 'operator'),
        p_new_password: profile && profile.password ? String(profile.password) : null
      };
      const execute = params.p_new_password
        ? this.executeSensitiveOperation.bind(this)
        : this.executeOperation.bind(this);
      const result = this.commandResult(await execute(
        'monthly_v7_update_user', params, `update_user:${targetUserId}`
      ), 'UPDATE_USER_FAILED');
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

    async createReportSnapshot(kind = 'pdf', options = {}) {
      this.requireUserSession();
      const report = this.currentReport();
      if (!report || !report.id) throw new Error('REPORT_CONTEXT_REQUIRED');
      return this.commandResult(await this.executeOperation('monthly_v7_create_report_snapshot', {
        p_workspace_key: this.config.workspaceKey,
        p_site_session_id: this.siteSession.id,
        p_user_session_id: this.userSession.id,
        p_report_id: report.id,
        p_snapshot_kind: kind
      }, `create_snapshot:${report.id}:${kind}`, options), 'CREATE_SNAPSHOT_FAILED');
    }

    async updateSitePassword(newPassword) {
      this.requireUserSession();
      try {
        const result = this.commandResult(await this.executeSensitiveOperation('monthly_v7_update_site_password', {
          p_workspace_key: this.config.workspaceKey,
          p_user_session_id: this.userSession.id,
          p_client_session_id: this.clientSessionId,
          p_new_password: String(newPassword || '')
        }, `update_site_password:${this.config.workspaceKey}`), 'UPDATE_SITE_PASSWORD_FAILED');
        this.clearSiteResumeMarker();
        this.clearUserResumeMarker();
        this.clearSessions('site-password-rotated');
        return result;
      } catch (error) {
        const code = String(error && (error.code || error.message) || '');
        const message = String(error && error.message || error || '');
        const resultUnknown = code === 'RPC_TIMEOUT'
          || /failed to fetch|networkerror|network request failed/i.test(message);
        if (resultUnknown) {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
          this.clearSessions('site-password-rotation-unconfirmed', code);
        }
        throw error;
      }
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
        // Production change hints intentionally contain no actor/operation ID.
        // Capture exact pending save intent before this request can race its ACK.
        const pendingSaveIntents = this.captureCurrentActorPendingSaveIntents();
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
        for (const value of latestByEntity.values()) {
          value.pendingSaveIntent = pendingSaveIntents.get(this.leaseKey(value.type, value.id)) || null;
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
          const convergedOwnSaveHint = this.changeConvergesWithLocalAuthority(
            value.event, entity, value.pendingSaveIntent
          );
          if (hasLocalIntent && !convergedOwnSaveHint) {
            if (typeof this.host.onRemoteChangeWhileEditing === 'function') this.host.onRemoteChangeWhileEditing(entity, value.event);
          } else if (!hasLocalIntent && typeof this.host.applyEntity === 'function') {
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
        if (this.isSessionContextCurrent(operationContext)) {
          this.clearUserResumeMarker();
          this.clearUserSession('user-logout');
        }
      }
    }

    async logout() {
      const operationContext = this.captureSessionContext();
      const hadSiteResumeMarker = !!this.readSiteResumeMarker();
      try {
        if (this.isActive() && operationContext.siteSessionId) {
          const result = await this.rpc('monthly_v7_logout', {
            p_workspace_key: this.config.workspaceKey,
            p_site_session_id: operationContext.siteSessionId,
            p_user_session_id: operationContext.userSessionId || null
          });
          this.assertSessionContext(operationContext, 'logout_site');
          const confirmed = this.commandResult(result, 'LOGOUT_NOT_CONFIRMED');
          const trustedDeviceRevoked = confirmed.trustedDeviceRevoked ?? confirmed.trusted_device_revoked;
          if (hadSiteResumeMarker && trustedDeviceRevoked !== true) {
            const error = new Error('TRUSTED_DEVICE_REVOCATION_NOT_CONFIRMED');
            error.code = 'TRUSTED_DEVICE_REVOCATION_NOT_CONFIRMED';
            error.result = confirmed;
            throw error;
          }
        }
      } finally {
        if (this.isSessionContextCurrent(operationContext)) {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
          this.clearSessions('site-logout');
        } else if (!this.hasSiteSession()) {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
        }
      }
    }

    async forgetTrustedDevice() {
      const operationContext = this.captureSessionContext();
      try {
        if (!this.isActive() || !operationContext.siteSessionId) {
          throw new Error('SITE_SESSION_REQUIRED');
        }
        const result = await this.rpc('monthly_v7_forget_trusted_device', {
          p_workspace_key: this.config.workspaceKey,
          p_site_session_id: operationContext.siteSessionId,
          p_client_session_id: this.clientSessionId
        });
        this.assertSessionContext(operationContext, 'forget_trusted_device');
        const confirmed = this.commandResult(result, 'FORGET_TRUSTED_DEVICE_FAILED');
        if (confirmed.forgotten !== true) {
          const error = new Error('FORGET_TRUSTED_DEVICE_NOT_CONFIRMED');
          error.code = 'FORGET_TRUSTED_DEVICE_NOT_CONFIRMED';
          error.result = confirmed;
          throw error;
        }
        return confirmed;
      } finally {
        if (this.isSessionContextCurrent(operationContext)) {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
          this.clearSessions('trusted-device-forgotten');
        } else if (!this.hasSiteSession()) {
          this.clearSiteResumeMarker();
          this.clearUserResumeMarker();
        }
      }
    }

    clearLocalSiteSession(reason = 'local-site-session-cleared', code = '') {
      this.clearSessions(reason, code);
      return true;
    }

    clearUserSession(reason = '', code = '') {
      this.stopHeartbeat();
      this.stopRealtime();
      this.userSession = null;
      this.user = null;
      this.userSessionPendingValidation = false;
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
      this.siteSessionPendingValidation = false;
      if (this.sessionStorage) {
        this.sessionStorage.removeItem('monthly_v7_site_session');
      }
      if (reason) this.notifySessionStateChanged(reason, code);
    }
  }

  return Object.freeze({ BUILD_ID: buildId, MonthlyV7Client });
});
