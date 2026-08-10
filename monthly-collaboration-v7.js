(function (root, factory) {
  const api = factory(
    root,
    typeof module === 'object' && module.exports ? require('./monthly-collaboration-client.js') : root.MonthlyCollaborationClient
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MonthlyV7Browser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, clientApi) {
  'use strict';

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

  class SupabaseV7Transport {
    constructor(supabaseGlobal) {
      this.supabaseGlobal = supabaseGlobal;
      this.client = null;
      this.configKey = '';
      this.channels = new Set();
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
      const response = await this.client.rpc(name, params || {});
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
      this.initialized = false;
      this.guardsInstalled = false;
    }

    setHost(host) {
      this.host = host || {};
      if (this.client) this.client.host = this.clientHost();
    }

    clientHost() {
      return {
        applyBundle: async (bundle, snapshot) => {
          if (typeof this.host.applyBundle === 'function') await this.host.applyBundle(bundle, snapshot);
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
          this.decorateEditorRows();
          if (typeof this.host.onLeaseLost === 'function') this.host.onLeaseLost(info);
        },
        onConflict: (info) => {
          this.decorateEditorRows();
          if (typeof this.host.onConflict === 'function') this.host.onConflict(info);
        },
        onRemoteChangeWhileEditing: (entity, event) => {
          if (typeof this.host.onRemoteChangeWhileEditing === 'function') this.host.onRemoteChangeWhileEditing(entity, event);
        },
        onTransportError: (error) => this.reportError(error),
        onItemSaved: (info) => {
          this.decorateEditorRows();
          if (typeof this.host.onItemSaved === 'function') this.host.onItemSaved(info);
        },
        onUsersChanged: (...args) => {
          if (typeof this.host.onUsersChanged === 'function') this.host.onUsersChanged(...args);
        }
      };
    }

    async initialize(config, host) {
      if (host) this.setHost(host);
      if (!config || !config.workspaceKey) throw new Error('SUPABASE_CONFIG_REQUIRED');
      this.client = new clientApi.MonthlyV7Client({
        transport: this.transport,
        sessionStorage: root.sessionStorage,
        draftStorage: root.localStorage,
        host: this.clientHost()
      });
      this.status = await this.client.initialize(config);
      this.initialized = true;
      if (this.isActive()) this.installEditGuards();
      return this.status;
    }

    isActive() { return !!(this.client && this.client.isActive()); }
    isSiteUnlocked() { return !!(this.client && this.client.isSiteUnlocked()); }
    currentUser() { return this.client ? this.client.currentUser() : null; }
    currentReport() { return this.client ? this.client.currentReport() : null; }

    async openSite(password) {
      const result = await this.client.openSite(password);
      return result;
    }

    async login(username, password) {
      const user = await this.client.login(username, password);
      this.client.startHeartbeat();
      this.client.startRealtime();
      this.decorateEditorRows();
      return user;
    }

    async logout() {
      if (!this.client) return;
      for (const timer of this.moduleReleaseTimers.values()) root.clearTimeout(timer);
      this.moduleReleaseTimers.clear();
      const leases = Array.from(this.client.leases.values());
      await Promise.allSettled(leases.map((lease) => this.client.releaseLease(lease.entityType, lease.entityId)));
      await this.client.logout();
      this.decorateEditorRows();
    }

    async loadSnapshot() {
      const result = await this.client.loadSnapshot();
      if (this.client.currentUser()) {
        this.client.startHeartbeat();
        this.client.startRealtime();
      }
      this.decorateEditorRows();
      return result;
    }

    async syncLatest() {
      if (!this.client.currentUser()) return this.loadSnapshot();
      return this.client.catchUp();
    }

    enqueue(task) {
      const run = this.persistChain.catch(() => undefined).then(task);
      this.persistChain = run;
      return run.catch((error) => {
        this.reportError(error);
        throw error;
      });
    }

    baselineModuleMap() {
      return new Map(((this.client.snapshot && this.client.snapshot.modules) || []).map((row) => [row.id, row]));
    }

    syncModuleBaseline(item) {
      if (!this.client.snapshot) return;
      if (!Array.isArray(this.client.snapshot.modules)) this.client.snapshot.modules = [];
      let row = this.client.snapshot.modules.find((entry) => entry.id === item._v7Id);
      if (!row) {
        row = { id: item._v7Id, legacyItemId: String(item.id || item._v7Id) };
        this.client.snapshot.modules.push(row);
      }
      row.revision = Number(item._v7Revision);
      row.payload = clone(this.client.modulePayload(item));
    }

    async persistReportData(items) {
      if (!this.isActive()) return { mode: 'legacy' };
      if (!this.currentUser()) {
        this.setStatus('本機草稿已保存；請登入後再提交逐項變更。', 'warn');
        return { mode: 'v7', localOnly: true };
      }
      const liveItems = Array.isArray(items) ? items : [];
      return this.enqueue(async () => {
        if (!this.client.snapshot) await this.client.loadSnapshot();
        let baseline = this.baselineModuleMap();
        const liveIds = new Set(liveItems.map((item) => item && item._v7Id).filter(Boolean));
        const deletedRows = Array.from(baseline.values()).filter((row) => !liveIds.has(row.id));
        for (const item of liveItems.filter((entry) => !entry._v7Id)) {
          const created = await this.client.createModule(item);
          item._v7Id = created._v7Id;
          item._v7Revision = created._v7Revision;
          this.syncModuleBaseline(item);
        }
        for (const row of deletedRows) {
          const item = Object.assign({}, clone(row.payload), { _v7Id: row.id, _v7Revision: Number(row.revision) });
          await this.client.deleteModule(item);
          this.client.snapshot.modules = this.client.snapshot.modules.filter((entry) => entry.id !== row.id);
        }
        baseline = this.baselineModuleMap();
        const changed = liveItems.filter((item) => {
          const row = baseline.get(item._v7Id);
          return row && canonical(this.client.modulePayload(item)) !== canonical(row.payload);
        });
        if (changed.length === 1) {
          await this.client.saveModule(changed[0]);
          this.syncModuleBaseline(changed[0]);
        } else if (changed.length > 1) {
          await this.client.saveModuleBatch(changed);
          changed.forEach((item) => this.syncModuleBaseline(item));
        }
        const liveOrder = liveItems.map((item) => item._v7Id);
        const baseOrder = (this.client.snapshot.modules || []).map((row) => row.id);
        if (liveOrder.length && canonical(liveOrder) !== canonical(baseOrder)) {
          await this.client.reorderModules(liveItems);
          const ranks = new Map(liveOrder.map((id, index) => [id, index]));
          this.client.snapshot.modules.sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
        }
        this.setStatus(`逐項雲端已保存｜watermark ${this.client.watermark}`, 'ok');
        this.decorateEditorRows();
        return { mode: 'v7', saved: true, watermark: this.client.watermark };
      });
    }

    async persistReportMeta(meta) {
      if (!this.isActive()) return { mode: 'legacy' };
      if (!this.currentUser()) return { mode: 'v7', localOnly: true };
      return this.enqueue(async () => {
        const result = await this.client.saveReportMeta(meta);
        this.setStatus(`月報資訊已保存｜revision ${result.revision}`, 'ok');
        return result;
      });
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
      if (!this.currentUser()) {
        this.setStatus('資料記錄只保存為本機草稿；請先登入。', 'warn');
        return { mode: 'v7', localOnly: true };
      }
      return this.enqueue(async () => {
        if (!this.client.snapshot) await this.client.loadSnapshot();
        const groups = records || {};
        const live = [];
        for (const [recordType, rows] of Object.entries(groups)) {
          for (const row of Array.isArray(rows) ? rows : []) live.push({ recordType, row });
        }
        const liveIds = new Set(live.map(({ row }) => row._v7Id).filter(Boolean));
        const deleted = ((this.client.snapshot && this.client.snapshot.records) || []).filter((row) => !liveIds.has(row.id));
        for (const entry of live.filter(({ row }) => !row._v7Id)) {
          const created = await this.client.createRecord(entry.recordType, entry.row);
          Object.assign(entry.row, created);
          this.syncRecordBaseline(entry.recordType, entry.row);
        }
        for (const old of deleted) {
          const record = Object.assign({}, clone(old.payload), { _v7Id: old.id, _v7Revision: Number(old.revision) });
          await this.client.deleteRecord(old.recordType, record);
          this.client.snapshot.records = this.client.snapshot.records.filter((entry) => entry.id !== old.id);
        }
        const baseline = new Map(((this.client.snapshot && this.client.snapshot.records) || []).map((row) => [row.id, row]));
        for (const entry of live) {
          const old = baseline.get(entry.row._v7Id);
          if (old && canonical(this.client.recordPayload(entry.row)) !== canonical(old.payload)) {
            await this.client.saveRecord(entry.recordType, entry.row);
            this.syncRecordBaseline(entry.recordType, entry.row);
          }
        }
        this.setStatus(`逐筆資料記錄已保存｜watermark ${this.client.watermark}`, 'ok');
        return { mode: 'v7', saved: true, watermark: this.client.watermark };
      });
    }

    async flush(meta) {
      await this.persistChain.catch(() => undefined);
      if (meta && this.isActive() && this.currentUser()) await this.persistReportMeta(meta);
      return true;
    }

    async claimModule(entityId) {
      if (!this.isActive() || !this.currentUser() || !entityId) return null;
      const key = `module:${entityId}`;
      if (this.client.getLease('module', entityId)) return this.client.getLease('module', entityId);
      if (this.claimPromises.has(key)) return this.claimPromises.get(key);
      const request = this.client.claimLease('module', entityId).then((lease) => {
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
      row.querySelectorAll('[data-v7-editable="1"]').forEach((element) => element.setAttribute('contenteditable', 'true'));
      let badge = row.querySelector('.v7-item-lock-badge');
      if (!badge) {
        badge = root.document.createElement('span');
        badge.className = 'v7-item-lock-badge no-print';
        row.querySelector('td')?.appendChild(badge);
      }
      badge.textContent = '你正在編輯';
      badge.className = 'v7-item-lock-badge no-print text-[10px] text-emerald-700 font-bold';
    }

    decorateEditorRows() {
      if (!this.isActive() || !root.document) return;
      root.document.querySelectorAll('#tableBody tr[data-v7-entity-id]').forEach((row) => {
        const id = row.dataset.v7EntityId;
        const owned = !!this.client.getLease('module', id);
        row.dataset.v7LeaseState = owned ? 'owned' : 'idle';
        row.querySelectorAll('.editable-div').forEach((element) => {
          element.dataset.v7Editable = '1';
          element.setAttribute('contenteditable', owned ? 'true' : 'false');
        });
        let badge = row.querySelector('.v7-item-lock-badge');
        if (!badge) {
          badge = root.document.createElement('span');
          badge.className = 'v7-item-lock-badge no-print text-[10px] font-bold';
          row.querySelector('td')?.appendChild(badge);
        }
        badge.textContent = owned ? '你正在編輯' : '點一下取得編輯權';
        badge.className = `v7-item-lock-badge no-print text-[10px] font-bold ${owned ? 'text-emerald-700' : 'text-slate-400'}`;
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
      if (!entityId || !this.client.getLease('module', entityId)) return;
      this.cancelModuleRelease(entityId);
      const timer = root.setTimeout(async () => {
        this.moduleReleaseTimers.delete(entityId);
        if (!this.client || !this.client.getLease('module', entityId)) return;
        const currentRow = Array.from(root.document.querySelectorAll('#tableBody tr[data-v7-entity-id]'))
          .find((candidate) => String(candidate.dataset.v7EntityId || '') === entityId);
        if (currentRow && currentRow.contains(root.document.activeElement)) return;
        const baseline = this.baselineModuleMap().get(entityId);
        if (!baseline || typeof this.host.getLocalEntity !== 'function') return;
        let local;
        try { local = await this.host.getLocalEntity('module', entityId); }
        catch (error) { this.reportError(error); return; }
        if (!local || (currentRow && currentRow.contains(root.document.activeElement))) return;
        const changed = canonical(this.client.modulePayload(local)) !== canonical(baseline.payload);
        if (changed) return;
        try { await this.client.releaseLease('module', entityId); }
        catch {
          // releaseLease drops the local heartbeat in finally; the server lease
          // will therefore expire at its existing TTL even if the ack is lost.
          this.setStatus('項目釋放確認失敗；編輯權將在逾時後自動釋放。', 'warn');
        }
        this.decorateEditorRows();
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
            this.setStatus(error.message, 'warn');
            this.toast(error.message);
          } else {
            this.reportError(error);
            this.toast(`無法取得編輯權：${error.message}`);
          }
        });
      };
      root.document.addEventListener('pointerdown', (event) => {
        const row = rowFor(event.target);
        root.document.querySelectorAll('#tableBody tr[data-v7-entity-id]').forEach((candidate) => {
          const id = candidate.dataset.v7EntityId;
          if (candidate === row) this.cancelModuleRelease(id);
          else if (this.client.getLease('module', id)) this.scheduleUnchangedModuleRelease(candidate);
        });
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
    async createReportSnapshot(kind) { return this.client.createReportSnapshot(kind); }

    setStatus(text, kind) {
      if (typeof this.host.setStatus === 'function') this.host.setStatus(text, kind);
    }

    toast(text) {
      if (typeof this.host.toast === 'function') this.host.toast(text);
    }

    reportError(error) {
      if (typeof this.host.onTransportError === 'function') this.host.onTransportError(error);
      else if (root.console) root.console.error(error);
      this.setStatus(`逐項雲端操作失敗：${error && error.message || error}`, 'error');
    }
  }

  return Object.freeze({ SupabaseV7Transport, MonthlyV7BrowserApp, canonical });
});
