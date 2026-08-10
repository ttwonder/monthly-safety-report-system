(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MonthlyCollaborationCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  function legacyBundleFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.report) throw new TypeError('snapshot report is required');
    const report = snapshot.report;
    const modules = (Array.isArray(snapshot.modules) ? snapshot.modules : [])
      .slice()
      .sort((a, b) => Number(a.sortRank || 0) - Number(b.sortRank || 0))
      .map((row) => ({
        ...jsonClone(row.payload, {}),
        id: row.legacyItemId == null ? row.id : row.legacyItemId,
        _v7Id: String(row.id),
        _v7Revision: Number(row.revision || 0)
      }));
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

  return Object.freeze({ entityKey, orderedTargets, leaseCanWrite, legacyBundleFromSnapshot, reduceChangeEvents });
});
