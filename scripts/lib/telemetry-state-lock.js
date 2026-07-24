'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_RETRY_MS = 10;
const STALE_MS = 5000;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function recoverStaleLock(lockPath, nowMs) {
  let descriptor;
  let stat;
  let owner = null;
  try {
    descriptor = fs.openSync(lockPath, 'r');
    stat = fs.fstatSync(descriptor);
    owner = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch {
    // A process can die between exclusive creation and completing the owner
    // record. The mtime still provides a conservative stale threshold.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (!stat) return false;

  const createdAtMs = Number(owner?.createdAtMs);
  const ageMs = nowMs - Math.max(
    Number.isFinite(createdAtMs) ? createdAtMs : 0,
    Number(stat.mtimeMs) || 0
  );
  if (ageMs < STALE_MS) return false;
  if (owner && processIsAlive(Number(owner.pid))) return false;

  // Serialize recovery for this exact inode. Once this exclusive guard exists,
  // no cooperating process can replace the checked lock before the rename.
  const recoveryPath = `${lockPath}.recover-${stat.dev}-${stat.ino}`;
  const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let recoveryDescriptor;
  try {
    recoveryDescriptor = fs.openSync(recoveryPath, 'wx', 0o600);
    fs.writeFileSync(recoveryDescriptor, JSON.stringify({
      pid: process.pid,
      createdAtMs: nowMs,
    }), 'utf8');
    fs.renameSync(lockPath, stalePath);
  } catch {
    return false;
  } finally {
    if (recoveryDescriptor !== undefined) {
      fs.closeSync(recoveryDescriptor);
      try {
        fs.unlinkSync(recoveryPath);
      } catch {
        // A failed recovery attempt must not affect the wrapped command.
      }
    }
  }
  try {
    fs.rmSync(stalePath, { force: true });
  } catch {
    // A stale lock already moved out of the active path cannot block progress.
  }
  return true;
}

function acquireFileLock(lockPath, options = {}) {
  const lockDir = path.dirname(lockPath);
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.lockRetryMs ?? DEFAULT_RETRY_MS;
  const startedAt = Date.now();
  const token = crypto.randomBytes(16).toString('hex');

  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  while (true) {
    const createdAtMs = Date.now();
    try {
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        token,
        createdAtMs,
      }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (recoverStaleLock(lockPath, createdAtMs)) continue;
      if (createdAtMs - startedAt >= timeoutMs) {
        const lockError = new Error('Telemetry state is busy');
        lockError.code = 'ECC_TELEMETRY_LOCK_TIMEOUT';
        throw lockError;
      }
      sleepSync(retryMs);
    }
  }

  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (owner.token === token) fs.unlinkSync(lockPath);
    } catch {
      // Releasing telemetry state must never affect the wrapped command.
    }
  };
}

module.exports = Object.freeze({
  acquireFileLock,
});
