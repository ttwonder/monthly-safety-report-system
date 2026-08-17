(function (root, factory) {
  const buildId = '7.6.0';
  const api = factory(buildId);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.MonthlyCollaborationCore = api;
    root.MONTHLY_REPORT_ASSET_BUILDS = Object.assign({}, root.MONTHLY_REPORT_ASSET_BUILDS, { core: buildId });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (buildId) {
  'use strict';

  function requiredText(value, label) {
    const text = String(value == null ? '' : value).trim();
    if (!text) throw new TypeError(`${label} is required`);
    return text;
  }

  function entityKey(entityType, entityId) {
    const type = requiredText(entityType, 'entity type');
    const id = requiredText(entityId, 'entity id');
    return `${type}:${id}`;
  }

  function orderedTargets(targets) {
    const unique = new Map();
    for (const target of Array.isArray(targets) ? targets : []) {
      const key = entityKey(target && target.entityType, target && target.entityId);
      if (!unique.has(key)) unique.set(key, Object.freeze({ ...target, key }));
    }
    return Array.from(unique.values()).sort((left, right) => left.key.localeCompare(right.key));
  }

  function leaseCanWrite(lease, expected, now = Date.now()) {
    if (!lease || !expected) return false;
    const fields = ['entityType', 'entityId', 'leaseId', 'holderUserId', 'clientSessionId'];
    if (fields.some((field) => String(lease[field] || '') !== String(expected[field] || ''))) return false;
    if (Number(lease.fencingToken) !== Number(expected.fencingToken)) return false;
    const expiresAt = Date.parse(String(lease.expiresAt || ''));
    return Number.isFinite(expiresAt) && expiresAt > Number(now);
  }

  function jsonClone(value, fallback) {
    if (value == null) return fallback;
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function cleanLegacyModulePayload(value) {
    const payload = jsonClone(value, {});
    delete payload._v7Id;
    delete payload._v7Revision;
    delete payload._serverPayload;
    delete payload._serverRevision;
    delete payload._displaySortRank;
    return payload;
  }

  function legacyIdentity(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  function reconcileLegacyLocalModules(serverModules, localModules, options = {}) {
    const serverRows = jsonClone(Array.isArray(serverModules) ? serverModules : [], []);
    const localRows = jsonClone(Array.isArray(localModules) ? localModules : [], []);
    const parseTimestamp = (value) => {
      const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    const localTimestamp = parseTimestamp(options.localTimestamp);
    const serverByLegacyId = new Map();
    const duplicateServerIds = new Set();
    const createdServerByPayloadId = new Map();
    const duplicateCreatedPayloadIds = new Set();
    for (const row of serverRows) {
      const legacyItemId = legacyIdentity(row && (row.legacyItemId == null ? row.payload && row.payload.id : row.legacyItemId));
      if (legacyItemId) {
        if (serverByLegacyId.has(legacyItemId)) duplicateServerIds.add(legacyItemId);
        else serverByLegacyId.set(legacyItemId, row);
      }
      // monthly_v7_create_module intentionally assigns legacy_item_id=v7:<uuid>,
      // while preserving the original local id inside payload.id.  If create
      // committed but a later save/reorder step failed, this unique fallback
      // reconnects the recovery row to that committed module instead of creating
      // a duplicate on retry.  Migrated rows never use this fallback.
      if (legacyIdentity(row && row.legacyItemId).startsWith('v7:')) {
        const payloadId = legacyIdentity(row && row.payload && row.payload.id);
        if (payloadId) {
          if (createdServerByPayloadId.has(payloadId)) duplicateCreatedPayloadIds.add(payloadId);
          else createdServerByPayloadId.set(payloadId, row);
        }
      }
    }
    for (const id of duplicateServerIds) serverByLegacyId.delete(id);
    for (const id of duplicateCreatedPayloadIds) createdServerByPayloadId.delete(id);

    const authorityRows = serverRows.slice().sort((left, right) => (
      Number(left.sortRank || 0) - Number(right.sortRank || 0)
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
    const authorityRanks = new Map(authorityRows.map((row, index) => [String(row.id), index + 1]));
    for (const row of serverRows) row._displaySortRank = authorityRanks.get(String(row.id));

    const localIdCounts = new Map();
    for (const row of localRows) {
      const id = legacyIdentity(row && row.id);
      if (id) localIdCounts.set(id, Number(localIdCounts.get(id) || 0) + 1);
    }

    const recovered = [];
    // Kept for wire compatibility. Ambiguous legacy-only rows are never live write
    // intents; they are preserved solely in the durable recovery copy/quarantine.
    const localOnlyModules = [];
    const quarantinedModules = [];
    const matchedServerIds = new Set();
    const matchedRows = [];
    localRows.forEach((localRow, index) => {
      const legacyItemId = legacyIdentity(localRow && localRow.id);
      const serverRow = legacyItemId && localIdCounts.get(legacyItemId) === 1
        ? (serverByLegacyId.get(legacyItemId) || createdServerByPayloadId.get(legacyItemId))
        : null;
      const payload = cleanLegacyModulePayload(localRow);
      const displaySortRank = index + 1;
      if (!serverRow || matchedServerIds.has(String(serverRow.id))) {
        quarantinedModules.push({
          legacyItemId,
          payload,
          _displaySortRank: displaySortRank,
          reason: 'LOCAL_ONLY_AMBIGUOUS'
        });
        return;
      }
      const entityId = String(serverRow.id);
      matchedServerIds.add(entityId);
      const serverTimestamp = parseTimestamp(serverRow.updatedAt || serverRow.updated_at);
      const freshnessProven = localTimestamp !== null
        && serverTimestamp !== null
        && localTimestamp > serverTimestamp;
      matchedRows.push({ serverRow, displaySortRank, freshnessProven });
      const serverPayload = cleanLegacyModulePayload(serverRow.payload);
      if (canonicalJson(payload) !== canonicalJson(serverPayload)) {
        if (freshnessProven) {
          recovered.push({
            entityId,
            legacyItemId,
            baseRevision: Number(serverRow.revision || 0),
            payload
          });
        } else {
          quarantinedModules.push({
            entityId,
            legacyItemId,
            payload,
            _displaySortRank: displaySortRank,
            reason: localTimestamp === null || serverTimestamp === null
              ? 'FRESHNESS_EVIDENCE_MISSING'
              : 'LOCAL_NOT_NEWER'
          });
        }
      }
    });

    // Module order is one report-structure intent. Recover it only when every
    // authority row has one corresponding local row and every comparison proves
    // the local source is newer; partial freshness must not create mixed ordering.
    const canRecoverOrder = matchedRows.length === serverRows.length
      && matchedRows.every((entry) => entry.freshnessProven);
    if (canRecoverOrder) {
      for (const entry of matchedRows) entry.serverRow._displaySortRank = entry.displaySortRank;
    }
    const authorityOrder = authorityRows.map((row) => String(row.id));
    const displayOrder = serverRows
      .slice()
      .sort((left, right) => Number(left._displaySortRank || 0) - Number(right._displaySortRank || 0))
      .map((row) => String(row.id));
    const orderChanged = canRecoverOrder && canonicalJson(authorityOrder) !== canonicalJson(displayOrder);
    return { serverRows, recovered, localOnlyModules, quarantinedModules, orderChanged };
  }

  function legacyBundleFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.report) throw new TypeError('snapshot report is required');
    const report = snapshot.report;
    const moduleRows = (Array.isArray(snapshot.modules) ? snapshot.modules : []).map((row) => ({
      kind: 'server',
      sortRank: Number(row._displaySortRank ?? row.sortRank ?? 0),
      row
    }));
    moduleRows.push(...(Array.isArray(snapshot.localOnlyModules) ? snapshot.localOnlyModules : []).map((row) => ({
      kind: 'local',
      sortRank: Number(row._displaySortRank || 0),
      row
    })));
    const modules = moduleRows
      .sort((a, b) => a.sortRank - b.sortRank)
      .map((entry) => {
        if (entry.kind !== 'server') return cleanLegacyModulePayload(entry.row && entry.row.payload);
        const payload = jsonClone(entry.row.payload, {});
        const legacyItemId = legacyIdentity(entry.row.legacyItemId);
        // Server-created rows use legacy_item_id=v7:<uuid> for uniqueness, but
        // payload.id remains the user's stable visible item number. Keep that
        // visible ID while _v7Id continues to carry normalized authority.
        const visibleId = legacyItemId.startsWith('v7:') && legacyIdentity(payload.id)
          ? payload.id
          : (entry.row.legacyItemId == null
            ? (payload.id == null ? entry.row.id : payload.id)
            : entry.row.legacyItemId);
        return {
          ...payload,
          id: visibleId,
          _v7Id: String(entry.row.id),
          _v7Revision: Number(entry.row.revision || 0)
        };
      });
    const records = { inspections: [], deficiencies: [], detentions: [], actions: [], trainings: [] };
    for (const row of Array.isArray(snapshot.records) ? snapshot.records : []) {
      if (!Object.prototype.hasOwnProperty.call(records, row.recordType)) continue;
      records[row.recordType].push({
        ...jsonClone(row.payload, {}),
        id: row.legacyId == null ? row.id : row.legacyId,
        _v7Id: String(row.id),
        _v7Revision: Number(row.revision || 0)
      });
    }
    const users = (Array.isArray(snapshot.users) ? snapshot.users : []).map((user) => ({
      id: user.id == null ? undefined : String(user.id),
      username: String(user.username || ''),
      displayName: String(user.displayName || user.username || ''),
      role: String(user.role || 'operator'),
      active: user.active !== false,
      version: Number(user.version || 0)
    }));
    return {
      app: 'monthly-safety-report-system',
      version: 7,
      watermark: Number(snapshot.watermark || 0),
      fileId: report.legacyFileId || report.id,
      report: {
        id: String(report.id),
        revision: Number(report.revision || 0),
        title: String(report.title || '月度安全會議報告'),
        date: String(report.date || ''),
        period: jsonClone(report.period, {}),
        modules
      },
      records,
      users
    };
  }

  function reduceChangeEvents(currentWatermark, events) {
    const base = Number(currentWatermark || 0);
    const bySequence = new Map();
    for (const event of Array.isArray(events) ? events : []) {
      const sequence = Number(event && event.sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= base || bySequence.has(sequence)) continue;
      bySequence.set(sequence, { ...event, sequence });
    }
    const ordered = Array.from(bySequence.values()).sort((a, b) => a.sequence - b.sequence);
    const entityKeys = [];
    const seenKeys = new Set();
    for (const event of ordered) {
      const key = entityKey(event.entityType, event.entityId);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        entityKeys.push(key);
      }
    }
    return Object.freeze({
      watermark: ordered.length ? ordered[ordered.length - 1].sequence : base,
      events: ordered,
      entityKeys
    });
  }

  return Object.freeze({
    BUILD_ID: buildId,
    entityKey,
    orderedTargets,
    leaseCanWrite,
    reconcileLegacyLocalModules,
    legacyBundleFromSnapshot,
    reduceChangeEvents
  });
});
