'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const packageJson = require('../../package.json');
const { acquireFileLock } = require('./telemetry-state-lock');

const EVENT_SCHEMA_VERSION = 'ecc.cli-telemetry.v1';
const DELETION_SCHEMA_VERSION = 'ecc.cli-telemetry-deletion.v1';
const CONSENT_SCHEMA_VERSION = 'ecc.cli-telemetry-consent.v2';
const CONSENT_VERSION = 2;
const IDENTITY_ROTATION_DAYS = 30;
const EVENT_RETENTION_DAYS = 30;
const DELIVERY_TIMEOUT_MS = 750;
const DELETE_BATCH_SIZE = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

const COMMAND_IDS = Object.freeze([
  'install',
  'plan',
  'catalog',
  'consult',
  'control-pane',
  'list-installed',
  'doctor',
  'repair',
  'auto-update',
  'status',
  'platform-audit',
  'security-ioc-scan',
  'sessions',
  'work-items',
  'session-inspect',
  'loop-status',
  'uninstall',
  'other',
]);

const COMMAND_ID_SET = new Set(COMMAND_IDS);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveHomeDir(options = {}) {
  const env = options.env || process.env;
  const explicitHome = options.homeDir || env.HOME || env.USERPROFILE;
  return path.resolve(explicitHome || os.homedir());
}

function getTelemetryConfigPath(options = {}) {
  const env = options.env || process.env;
  const configRoot = options.configDir
    || (options.homeDir ? path.join(resolveHomeDir(options), '.config') : null)
    || env.XDG_CONFIG_HOME
    || path.join(resolveHomeDir(options), '.config');
  return path.join(path.resolve(configRoot), 'ecc', 'telemetry.json');
}

function getTelemetryLockPath(options = {}) {
  return `${getTelemetryConfigPath(options)}.lock`;
}

function parseInstant(value, fieldName) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return instant;
}

function normalizeNow(now) {
  return parseInstant(now || new Date().toISOString(), 'now').toISOString();
}

function normalizeEndpoint(endpoint) {
  return resolveTelemetryEndpoint({ ECC_TELEMETRY_ENDPOINT: endpoint });
}

function isValidIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!UUID_PATTERN.test(value.anonymousId || '')) return false;
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    return false;
  }
  if (
    value.retiredAt !== null
    && (typeof value.retiredAt !== 'string' || Number.isNaN(Date.parse(value.retiredAt)))
  ) {
    return false;
  }
  if (!Array.isArray(value.endpoints)) return false;
  if (new Set(value.endpoints).size !== value.endpoints.length) return false;
  return value.endpoints.every(endpoint => {
    if (typeof endpoint !== 'string') return false;
    try {
      return normalizeEndpoint(endpoint) === endpoint;
    } catch {
      return false;
    }
  });
}

function isValidConsentState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== CONSENT_SCHEMA_VERSION) return false;
  if (value.consentVersion !== CONSENT_VERSION) return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) return false;
  if (!Array.isArray(value.identities) || !value.identities.every(isValidIdentity)) return false;

  const identityIds = value.identities.map(identity => identity.anonymousId);
  if (new Set(identityIds).size !== identityIds.length) return false;
  if (value.activeAnonymousId !== null && !UUID_PATTERN.test(value.activeAnonymousId || '')) {
    return false;
  }

  const activeIdentity = value.activeAnonymousId === null
    ? null
    : value.identities.find(identity => identity.anonymousId === value.activeAnonymousId);
  if (value.activeAnonymousId !== null && (!activeIdentity || activeIdentity.retiredAt !== null)) {
    return false;
  }
  if (value.enabled && !activeIdentity) return false;

  return value.identities.every(identity => (
    identity.anonymousId === value.activeAnonymousId || identity.retiredAt !== null
  ));
}

function readConsentState(options = {}) {
  const configPath = getTelemetryConfigPath(options);
  if (!fs.existsSync(configPath)) {
    return { state: 'absent', configPath, value: null };
  }

  try {
    const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!isValidConsentState(value)) {
      return { state: 'invalid', configPath, value: null };
    }
    return { state: 'valid', configPath, value };
  } catch {
    return { state: 'invalid', configPath, value: null };
  }
}

function writeConsentState(value, options = {}) {
  if (!isValidConsentState(value)) {
    throw new Error('Refusing to write invalid telemetry consent state');
  }

  const configPath = getTelemetryConfigPath(options);
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    configDir,
    `.telemetry-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let tempFile = null;

  try {
    tempFile = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(tempFile);
    const completedFile = tempFile;
    tempFile = null;
    fs.closeSync(completedFile);
    fs.renameSync(tempPath, configPath);
    try {
      const configDirectory = fs.openSync(configDir, 'r');
      try {
        fs.fsyncSync(configDirectory);
      } finally {
        fs.closeSync(configDirectory);
      }
    } catch {
      // Directory fsync is unavailable on some platforms.
    }
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // File modes are advisory or unsupported on some platforms.
    }
  } finally {
    if (tempFile !== null) fs.closeSync(tempFile);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  return value;
}

function acquireTelemetryLock(options = {}) {
  return acquireFileLock(getTelemetryLockPath(options), options);
}

function withTelemetryLockSync(options, fn) {
  const release = acquireTelemetryLock(options);
  try {
    return fn();
  } finally {
    release();
  }
}

async function withTelemetryLock(options, fn) {
  const release = acquireTelemetryLock(options);
  try {
    return await fn();
  } finally {
    release();
  }
}

function createIdentity(options = {}) {
  const now = normalizeNow(options.now);
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const anonymousId = randomUUID();
  if (!UUID_PATTERN.test(anonymousId)) {
    throw new Error('Generated telemetry identity must be a UUID');
  }
  return {
    anonymousId,
    createdAt: now,
    retiredAt: null,
    endpoints: [],
  };
}

function createConsentState(identity, now) {
  return {
    schemaVersion: CONSENT_SCHEMA_VERSION,
    consentVersion: CONSENT_VERSION,
    enabled: true,
    activeAnonymousId: identity.anonymousId,
    identities: [identity],
    updatedAt: now,
  };
}

function enableTelemetry(options = {}) {
  return withTelemetryLockSync(options, () => {
    const now = normalizeNow(options.now);
    const current = readConsentState(options);
    if (current.state === 'absent') {
      const identity = createIdentity({ ...options, now });
      return writeConsentState(createConsentState(identity, now), options);
    }
    if (current.state !== 'valid') {
      throw new Error(
        'Telemetry state is invalid; use telemetry delete --local-only before enabling'
      );
    }

    let identities = current.value.identities;
    let activeAnonymousId = current.value.activeAnonymousId;
    if (!activeAnonymousId) {
      const identity = createIdentity({ ...options, now });
      identities = [...identities, identity];
      activeAnonymousId = identity.anonymousId;
    }

    return writeConsentState({
      ...current.value,
      enabled: true,
      activeAnonymousId,
      identities,
      updatedAt: now,
    }, options);
  });
}

function disableTelemetry(options = {}) {
  return withTelemetryLockSync(options, () => {
    const now = normalizeNow(options.now);
    const current = readConsentState(options);
    if (current.state === 'absent') {
      return { enabled: false, state: 'absent' };
    }
    if (current.state !== 'valid') {
      return { enabled: false, state: 'invalid' };
    }

    return writeConsentState({
      ...current.value,
      enabled: false,
      updatedAt: now,
    }, options);
  });
}

function clearTelemetryStateUnlocked(options = {}) {
  const configPath = getTelemetryConfigPath(options);
  let removed = false;
  try {
    fs.unlinkSync(configPath);
    removed = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (removed) {
    try {
      const configDirectory = fs.openSync(path.dirname(configPath), 'r');
      try {
        fs.fsyncSync(configDirectory);
      } finally {
        fs.closeSync(configDirectory);
      }
    } catch {
      // Directory fsync is unavailable on some platforms.
    }
  }
}

function clearTelemetryState(options = {}) {
  return withTelemetryLockSync(options, () => clearTelemetryStateUnlocked(options));
}

function getHardOverride(env = process.env) {
  return String(env.ECC_TELEMETRY || '').trim() === '0'
    ? 'ECC_TELEMETRY=0'
    : null;
}

function resolveTelemetryEndpoint(env = process.env) {
  const rawEndpoint = String(env.ECC_TELEMETRY_ENDPOINT || '').trim();
  if (!rawEndpoint) return null;

  let endpoint;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error('ECC_TELEMETRY_ENDPOINT must be a valid HTTPS URL');
  }
  if (endpoint.protocol !== 'https:') {
    throw new Error('ECC_TELEMETRY_ENDPOINT must use HTTPS');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('ECC_TELEMETRY_ENDPOINT must not contain credentials');
  }
  if (endpoint.search) {
    throw new Error('ECC_TELEMETRY_ENDPOINT must not contain a query');
  }
  if (endpoint.hash) {
    throw new Error('ECC_TELEMETRY_ENDPOINT must not contain a fragment');
  }
  return endpoint.toString();
}

function getTelemetryStatus(options = {}) {
  const env = options.env || process.env;
  const consent = readConsentState(options);
  const persistedEnabled = consent.state === 'valid' && consent.value.enabled;
  const override = getHardOverride(env);
  let deliveryConfigured = false;
  let endpointState = 'not_configured';

  try {
    deliveryConfigured = Boolean(resolveTelemetryEndpoint(env));
    if (deliveryConfigured) endpointState = 'configured';
  } catch {
    endpointState = 'invalid';
  }

  const boundEndpoints = consent.state === 'valid'
    ? new Set(consent.value.identities.flatMap(identity => identity.endpoints))
    : new Set();
  return {
    schemaVersion: CONSENT_SCHEMA_VERSION,
    state: consent.state,
    persistedEnabled,
    effectiveEnabled: Boolean(persistedEnabled && !override),
    override,
    anonymousIdPresent: Boolean(
      consent.state === 'valid' && consent.value.identities.length > 0
    ),
    boundEndpointCount: boundEndpoints.size,
    deliveryConfigured,
    endpointState,
    identityRotationDays: IDENTITY_ROTATION_DAYS,
    eventRetentionDays: EVENT_RETENTION_DAYS,
  };
}

function getOrRotateActiveIdentityUnlocked(options = {}) {
  const current = readConsentState(options);
  if (current.state !== 'valid' || !current.value.enabled) return null;

  const activeIdentity = current.value.identities.find(
    identity => identity.anonymousId === current.value.activeAnonymousId
  );
  if (!activeIdentity) return null;

  const now = parseInstant(options.now || new Date().toISOString(), 'now');
  const createdAt = parseInstant(activeIdentity.createdAt, 'createdAt');
  if (now.getTime() - createdAt.getTime() < IDENTITY_ROTATION_DAYS * DAY_MS) {
    return { state: current.value, identity: activeIdentity };
  }

  const retiredIdentity = {
    ...activeIdentity,
    retiredAt: now.toISOString(),
  };
  const nextIdentity = createIdentity({
    ...options,
    now: now.toISOString(),
  });
  const nextState = writeConsentState({
    ...current.value,
    activeAnonymousId: nextIdentity.anonymousId,
    identities: [
      ...current.value.identities
        .filter(identity => identity.anonymousId !== activeIdentity.anonymousId),
      retiredIdentity,
      nextIdentity,
    ],
    updatedAt: now.toISOString(),
  }, options);
  return { state: nextState, identity: nextIdentity };
}

function getActiveConsentState(options = {}) {
  return withTelemetryLockSync(options, () => {
    const active = getOrRotateActiveIdentityUnlocked(options);
    if (!active) return null;
    const previousAnonymousIds = active.state.identities
      .filter(identity => identity.anonymousId !== active.identity.anonymousId)
      .map(identity => ({
        anonymousId: identity.anonymousId,
        retiredAt: identity.retiredAt,
        endpoints: [...identity.endpoints],
      }));
    return {
      ...active.state,
      anonymousId: active.identity.anonymousId,
      identityCreatedAt: active.identity.createdAt,
      previousAnonymousIds,
    };
  });
}

function bindIdentityToEndpoint(state, anonymousId, endpoint, options = {}) {
  const identity = state.identities.find(item => item.anonymousId === anonymousId);
  if (!identity) throw new Error('Active telemetry identity is missing');
  if (identity.endpoints.includes(endpoint)) return { state, identity };

  const nextIdentity = {
    ...identity,
    endpoints: [...identity.endpoints, endpoint].sort(),
  };
  const nextState = writeConsentState({
    ...state,
    identities: state.identities.map(item => (
      item.anonymousId === anonymousId ? nextIdentity : item
    )),
  }, options);
  return { state: nextState, identity: nextIdentity };
}

function coarsenCommandId(commandId) {
  return COMMAND_ID_SET.has(commandId) ? commandId : 'other';
}

function coarsenResult(exitCode) {
  return Number(exitCode) === 0 ? 'success' : 'failure';
}

function bucketLatency(elapsedMs) {
  const duration = Math.max(0, Number(elapsedMs) || 0);
  if (duration < 100) return 'under_100ms';
  if (duration < 1000) return '100ms_to_1s';
  if (duration < 10000) return '1s_to_10s';
  return '10s_or_more';
}

function coarsenOs(platform) {
  const values = {
    darwin: 'macos',
    linux: 'linux',
    win32: 'windows',
  };
  return values[platform] || 'other';
}

function coarsenArch(arch) {
  return arch === 'arm64' || arch === 'x64' ? arch : 'other';
}

function buildUsageEvent(input) {
  if (!UUID_PATTERN.test(input.anonymousId || '')) {
    throw new Error('anonymousId must be a UUID');
  }

  return Object.freeze({
    schemaVersion: EVENT_SCHEMA_VERSION,
    anonymousId: input.anonymousId,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    commandId: coarsenCommandId(input.commandId),
    result: coarsenResult(input.exitCode),
    latencyBucket: bucketLatency(input.elapsedMs),
    os: coarsenOs(input.platform || process.platform),
    arch: coarsenArch(input.arch || process.arch),
  });
}

async function defaultTransport(endpoint, payload, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: options.method || 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Telemetry endpoint returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function recordCommandUsage(options = {}) {
  try {
    if (options.commandId === 'ito') {
      return { sent: false, reason: 'excluded_command' };
    }
    const env = options.env || process.env;
    if (getHardOverride(env)) return { sent: false, reason: 'disabled' };

    const initial = readConsentState(options);
    if (initial.state !== 'valid' || !initial.value.enabled) {
      return { sent: false, reason: 'disabled' };
    }

    let endpoint;
    try {
      endpoint = resolveTelemetryEndpoint(env);
    } catch {
      return { sent: false, reason: 'invalid_endpoint' };
    }
    if (!endpoint) return { sent: false, reason: 'endpoint_not_configured' };

    return await withTelemetryLock(options, async () => {
      if (getHardOverride(env)) return { sent: false, reason: 'disabled' };
      const active = getOrRotateActiveIdentityUnlocked(options);
      if (!active) return { sent: false, reason: 'disabled' };

      const bound = bindIdentityToEndpoint(
        active.state,
        active.identity.anonymousId,
        endpoint,
        options
      );
      const event = buildUsageEvent({
        anonymousId: bound.identity.anonymousId,
        commandId: options.commandId,
        exitCode: options.exitCode,
        elapsedMs: options.elapsedMs,
        platform: options.platform,
        arch: options.arch,
      });

      try {
        const transport = options.transport || defaultTransport;
        await transport(endpoint, event, { method: 'POST' });
        return { sent: true };
      } catch {
        return { sent: false, reason: 'delivery_failed' };
      }
    });
  } catch {
    return { sent: false, reason: 'telemetry_unavailable' };
  }
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function retireAllIdentities(state, now) {
  return {
    ...state,
    enabled: false,
    activeAnonymousId: null,
    identities: state.identities.map(identity => ({
      ...identity,
      retiredAt: identity.retiredAt || now,
    })),
    updatedAt: now,
  };
}

function deletionGroups(state) {
  const groups = new Map();
  for (const identity of state.identities) {
    for (const endpoint of identity.endpoints) {
      const ids = groups.get(endpoint) || [];
      groups.set(endpoint, [...ids, identity.anonymousId]);
    }
  }
  return groups;
}

function removeDeletedBindings(state, endpoint, anonymousIds) {
  const deletedIds = new Set(anonymousIds);
  return {
    ...state,
    identities: state.identities
      .map(identity => (
        deletedIds.has(identity.anonymousId)
          ? {
              ...identity,
              endpoints: identity.endpoints.filter(item => item !== endpoint),
            }
          : identity
      ))
      .filter(identity => identity.endpoints.length > 0),
  };
}

async function deleteTelemetryData(options = {}) {
  return withTelemetryLock(options, async () => {
    const current = readConsentState(options);
    if (options.localOnly) {
      clearTelemetryStateUnlocked(options);
      return { deleted: true, localOnly: true };
    }
    if (current.state === 'absent') {
      return { deleted: false, reason: 'no_local_identity' };
    }
    if (current.state !== 'valid') {
      throw new Error('Telemetry identity is invalid; use --local-only to remove local state');
    }

    const env = options.env || process.env;
    const override = getHardOverride(env);
    if (override) {
      throw new Error(
        `${override} blocks remote deletion; use --local-only or remove the override`
      );
    }

    const now = normalizeNow(options.now);
    let pendingState = retireAllIdentities(current.value, now);
    pendingState = {
      ...pendingState,
      identities: pendingState.identities.filter(identity => identity.endpoints.length > 0),
    };
    if (pendingState.identities.length === 0) {
      clearTelemetryStateUnlocked(options);
      return { deleted: true, localOnly: false, endpointCount: 0 };
    }
    pendingState = writeConsentState(pendingState, options);

    const groups = deletionGroups(pendingState);
    const transport = options.transport || defaultTransport;
    let failedBatches = 0;
    let succeededBatches = 0;

    for (const [endpoint, anonymousIds] of groups.entries()) {
      for (const anonymousIdBatch of chunk(anonymousIds, DELETE_BATCH_SIZE)) {
        try {
          await transport(endpoint, {
            schemaVersion: DELETION_SCHEMA_VERSION,
            anonymousIds: anonymousIdBatch,
          }, { method: 'DELETE' });
          succeededBatches += 1;
          pendingState = removeDeletedBindings(
            pendingState,
            endpoint,
            anonymousIdBatch
          );
          if (pendingState.identities.length === 0) {
            clearTelemetryStateUnlocked(options);
          } else {
            pendingState = writeConsentState({
              ...pendingState,
              updatedAt: normalizeNow(options.now),
            }, options);
          }
        } catch {
          failedBatches += 1;
        }
      }
    }

    if (failedBatches > 0) {
      const error = new Error(
        `Telemetry deletion failed for ${failedBatches} endpoint batch(es); retained local deletion state`
      );
      error.code = 'ECC_TELEMETRY_DELETE_PARTIAL';
      throw error;
    }
    return {
      deleted: true,
      localOnly: false,
      endpointCount: groups.size,
      succeededBatches,
    };
  });
}

module.exports = Object.freeze({
  COMMAND_IDS,
  CONSENT_SCHEMA_VERSION,
  DELETION_SCHEMA_VERSION,
  EVENT_RETENTION_DAYS,
  EVENT_SCHEMA_VERSION,
  IDENTITY_ROTATION_DAYS,
  acquireTelemetryLock,
  bucketLatency,
  buildUsageEvent,
  clearTelemetryState,
  coarsenArch,
  coarsenCommandId,
  coarsenOs,
  coarsenResult,
  defaultTransport,
  deleteTelemetryData,
  disableTelemetry,
  enableTelemetry,
  getActiveConsentState,
  getTelemetryConfigPath,
  getTelemetryStatus,
  readConsentState,
  recordCommandUsage,
  resolveTelemetryEndpoint,
});
