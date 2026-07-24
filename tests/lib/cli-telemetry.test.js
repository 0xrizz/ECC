const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const telemetry = require('../../scripts/lib/cli-telemetry');
const eventSchema = require('../../schemas/ecc-cli-telemetry-event.schema.json');
const deletionSchema = require('../../schemas/ecc-cli-telemetry-deletion.schema.json');
const TELEMETRY_LIBRARY = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'lib',
  'cli-telemetry.js'
);

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      return true;
    })
    .catch(error => {
      console.log(`  ✗ ${name}`);
      console.error(`    ${error.stack || error.message}`);
      return false;
    });
}

function runChild(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', status => {
      if (status === 0) resolve({ stdout, stderr });
      else reject(new Error(`child exited ${status}: ${stderr}`));
    });
  });
}

async function waitForFile(filePath, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function main() {
  console.log('\n=== Testing privacy-safe CLI telemetry library ===\n');

  const tests = [
    ['builds the exact allowlisted event shape without arguments or paths', () => {
      const event = telemetry.buildUsageEvent({
        anonymousId: '11111111-1111-4111-8111-111111111111',
        commandId: 'consult',
        exitCode: 0,
        elapsedMs: 874,
        platform: 'darwin',
        arch: 'arm64',
        ignoredArguments: ['secret prompt', '/Users/example/private-repo'],
      });

      assert.deepStrictEqual(Object.keys(event).sort(), [
        'anonymousId',
        'arch',
        'commandId',
        'latencyBucket',
        'os',
        'packageName',
        'packageVersion',
        'result',
        'schemaVersion',
      ]);
      assert.strictEqual(event.commandId, 'consult');
      assert.strictEqual(event.result, 'success');
      assert.strictEqual(event.latencyBucket, '100ms_to_1s');
      assert.strictEqual(event.os, 'macos');
      assert.strictEqual(event.arch, 'arm64');
      assert.ok(!JSON.stringify(event).includes('secret prompt'));
      assert.ok(!JSON.stringify(event).includes('/Users/example'));
    }],
    ['keeps implementation fields and command IDs aligned with the public schema', () => {
      const event = telemetry.buildUsageEvent({
        anonymousId: '11111111-1111-4111-8111-111111111111',
        commandId: 'doctor',
        exitCode: 0,
        elapsedMs: 10,
      });

      assert.deepStrictEqual(Object.keys(event).sort(), [...eventSchema.required].sort());
      assert.deepStrictEqual(
        [...telemetry.COMMAND_IDS].sort(),
        [...eventSchema.properties.commandId.enum].sort()
      );
      assert.strictEqual(event.schemaVersion, eventSchema.properties.schemaVersion.const);
      assert.strictEqual(event.packageName, eventSchema.properties.packageName.const);
      assert.strictEqual(eventSchema.additionalProperties, false);
      assert.strictEqual(deletionSchema.additionalProperties, false);
      assert.strictEqual(deletionSchema.properties.anonymousIds.maxItems, 64);
    }],
    ['coarsens commands, results, latency, OS, and architecture', () => {
      assert.strictEqual(telemetry.coarsenCommandId('ito'), 'other');
      assert.strictEqual(telemetry.coarsenCommandId('not-a-real-command'), 'other');
      assert.strictEqual(telemetry.coarsenResult(0), 'success');
      assert.strictEqual(telemetry.coarsenResult(9), 'failure');
      assert.strictEqual(telemetry.bucketLatency(99), 'under_100ms');
      assert.strictEqual(telemetry.bucketLatency(100), '100ms_to_1s');
      assert.strictEqual(telemetry.bucketLatency(1000), '1s_to_10s');
      assert.strictEqual(telemetry.bucketLatency(10000), '10s_or_more');
      assert.strictEqual(telemetry.coarsenOs('win32'), 'windows');
      assert.strictEqual(telemetry.coarsenOs('freebsd'), 'other');
      assert.strictEqual(telemetry.coarsenArch('x64'), 'x64');
      assert.strictEqual(telemetry.coarsenArch('riscv64'), 'other');
    }],
    ['defaults to disabled when no consent state exists', () => {
      const homeDir = createTempDir('ecc-telemetry-default-');
      const status = telemetry.getTelemetryStatus({ homeDir, env: {} });

      assert.strictEqual(status.persistedEnabled, false);
      assert.strictEqual(status.effectiveEnabled, false);
      assert.strictEqual(status.state, 'absent');
      assert.strictEqual(status.deliveryConfigured, false);
    }],
    ['enables only through persisted explicit consent and disables cleanly', () => {
      const homeDir = createTempDir('ecc-telemetry-consent-');
      const enabled = telemetry.enableTelemetry({
        homeDir,
        now: '2026-07-23T00:00:00.000Z',
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
      });
      const enabledStatus = telemetry.getTelemetryStatus({ homeDir, env: {} });

      assert.strictEqual(enabled.enabled, true);
      assert.strictEqual(enabledStatus.persistedEnabled, true);
      assert.strictEqual(enabledStatus.effectiveEnabled, true);
      assert.strictEqual(enabledStatus.anonymousIdPresent, true);

      telemetry.disableTelemetry({
        homeDir,
        now: '2026-07-23T01:00:00.000Z',
      });
      const disabledStatus = telemetry.getTelemetryStatus({ homeDir, env: {} });
      assert.strictEqual(disabledStatus.persistedEnabled, false);
      assert.strictEqual(disabledStatus.effectiveEnabled, false);
      assert.strictEqual(disabledStatus.anonymousIdPresent, true);
    }],
    ['ECC_TELEMETRY=0 is a hard override over persisted consent', () => {
      const homeDir = createTempDir('ecc-telemetry-override-');
      telemetry.enableTelemetry({ homeDir });
      const status = telemetry.getTelemetryStatus({
        homeDir,
        env: {
          ECC_TELEMETRY: '0',
          ECC_TELEMETRY_ENDPOINT: 'https://telemetry.example.test/v1/events',
        },
      });

      assert.strictEqual(status.persistedEnabled, true);
      assert.strictEqual(status.effectiveEnabled, false);
      assert.strictEqual(status.override, 'ECC_TELEMETRY=0');
      assert.strictEqual(status.deliveryConfigured, true);
    }],
    ['corrupt consent state fails closed', () => {
      const homeDir = createTempDir('ecc-telemetry-corrupt-');
      const configPath = telemetry.getTelemetryConfigPath({ homeDir });
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{not-json', 'utf8');

      const status = telemetry.getTelemetryStatus({ homeDir, env: {} });
      assert.strictEqual(status.state, 'invalid');
      assert.strictEqual(status.persistedEnabled, false);
      assert.strictEqual(status.effectiveEnabled, false);
      assert.throws(
        () => telemetry.enableTelemetry({ homeDir }),
        /state is invalid/
      );
      assert.deepStrictEqual(
        telemetry.disableTelemetry({ homeDir }),
        { enabled: false, state: 'invalid' }
      );
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), '{not-json');
    }],
    ['rejects malformed consent and identity state without recovering it as enabled', () => {
      const seedHome = createTempDir('ecc-telemetry-state-seed-');
      const seed = telemetry.enableTelemetry({
        homeDir: seedHome,
        randomUUID: () => '23232323-2323-4232-8232-232323232323',
      });
      const malformedStates = [
        null,
        { ...seed, schemaVersion: 'unexpected' },
        { ...seed, consentVersion: 99 },
        { ...seed, enabled: 'yes' },
        { ...seed, updatedAt: 'not-a-date' },
        { ...seed, identities: {} },
        { ...seed, identities: [null] },
        {
          ...seed,
          identities: [{ ...seed.identities[0], anonymousId: 'not-a-uuid' }],
        },
        {
          ...seed,
          identities: [{ ...seed.identities[0], createdAt: 'not-a-date' }],
        },
        {
          ...seed,
          identities: [{ ...seed.identities[0], retiredAt: 'not-a-date' }],
        },
        {
          ...seed,
          identities: [{ ...seed.identities[0], endpoints: 'not-an-array' }],
        },
        {
          ...seed,
          identities: [{
            ...seed.identities[0],
            endpoints: [
              'https://collector.example.test/events',
              'https://collector.example.test/events',
            ],
          }],
        },
        {
          ...seed,
          identities: [{ ...seed.identities[0], endpoints: [42] }],
        },
        {
          ...seed,
          identities: [{ ...seed.identities[0], endpoints: ['http://insecure.test'] }],
        },
        {
          ...seed,
          identities: [
            seed.identities[0],
            { ...seed.identities[0], retiredAt: seed.updatedAt },
          ],
        },
        { ...seed, activeAnonymousId: 'not-a-uuid' },
        {
          ...seed,
          activeAnonymousId: '24242424-2424-4242-8242-242424242424',
        },
        { ...seed, activeAnonymousId: null },
        {
          ...seed,
          enabled: false,
          activeAnonymousId: null,
        },
      ];

      for (const value of malformedStates) {
        const homeDir = createTempDir('ecc-telemetry-malformed-state-');
        const configPath = telemetry.getTelemetryConfigPath({ homeDir });
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(value), 'utf8');
        const status = telemetry.getTelemetryStatus({ homeDir, env: {} });
        assert.strictEqual(status.state, 'invalid');
        assert.strictEqual(status.effectiveEnabled, false);
      }
    }],
    ['rotates the pseudonymous client identifier after thirty days', () => {
      const homeDir = createTempDir('ecc-telemetry-rotation-');
      telemetry.enableTelemetry({
        homeDir,
        now: '2026-06-01T00:00:00.000Z',
        randomUUID: () => '33333333-3333-4333-8333-333333333333',
      });

      const state = telemetry.getActiveConsentState({
        homeDir,
        now: '2026-07-02T00:00:00.000Z',
        randomUUID: () => '44444444-4444-4444-8444-444444444444',
      });

      assert.strictEqual(state.anonymousId, '44444444-4444-4444-8444-444444444444');
      assert.strictEqual(state.identityCreatedAt, '2026-07-02T00:00:00.000Z');
      assert.deepStrictEqual(state.previousAnonymousIds, [{
        anonymousId: '33333333-3333-4333-8333-333333333333',
        retiredAt: '2026-07-02T00:00:00.000Z',
        endpoints: [],
      }]);
    }],
    ['serializes parallel first-use rotation without losing an emitted identifier', async () => {
      const homeDir = createTempDir('ecc-telemetry-parallel-rotation-');
      const outputDir = createTempDir('ecc-telemetry-parallel-events-');
      telemetry.enableTelemetry({
        homeDir,
        now: '2026-06-01T00:00:00.000Z',
        randomUUID: () => '34343434-3434-4434-8434-343434343434',
      });
      const childSource = `
        const fs = require('fs');
        const telemetry = require(process.argv[1]);
        let emittedId = null;
        telemetry.recordCommandUsage({
          homeDir: process.argv[2],
          now: '2026-07-23T00:00:00.000Z',
          env: { ECC_TELEMETRY_ENDPOINT: 'https://collector.example.test/events' },
          commandId: 'doctor',
          exitCode: 0,
          elapsedMs: 1,
          lockTimeoutMs: 10000,
          transport: async (_endpoint, event) => { emittedId = event.anonymousId; },
        }).then(result => {
          fs.writeFileSync(
            process.argv[3],
            JSON.stringify({ result, emittedId }),
            'utf8'
          );
        }).catch(error => {
          console.error(error.stack || error.message);
          process.exitCode = 1;
        });
      `;
      // Eight independent processes exercise the cross-process boundary without
      // turning slower Windows runners into a scheduler stress benchmark.
      const childCount = 8;
      await Promise.all(Array.from({ length: childCount }, (_, index) => (
        runChild([
          '-e',
          childSource,
          TELEMETRY_LIBRARY,
          homeDir,
          path.join(outputDir, `${index}.json`),
        ])
      )));

      const emittedIds = Array.from({ length: childCount }, (_, index) => {
        const payload = JSON.parse(
          fs.readFileSync(path.join(outputDir, `${index}.json`), 'utf8')
        );
        assert.strictEqual(
          payload.result.sent,
          true,
          `telemetry child ${index} did not send: ${payload.result.reason || 'unknown reason'}`
        );
        return payload.emittedId;
      });
      assert.strictEqual(new Set(emittedIds).size, 1);

      const state = telemetry.readConsentState({ homeDir });
      assert.strictEqual(state.state, 'valid');
      const retainedIds = new Set(
        state.value.identities.map(identity => identity.anonymousId)
      );
      for (const emittedId of emittedIds) {
        assert.ok(retainedIds.has(emittedId), `missing emitted identity ${emittedId}`);
      }
    }],
    ['recovers an abandoned lock without stealing a live process lock', () => {
      const staleHome = createTempDir('ecc-telemetry-stale-lock-');
      const staleLockPath = `${telemetry.getTelemetryConfigPath({ homeDir: staleHome })}.lock`;
      fs.mkdirSync(path.dirname(staleLockPath), { recursive: true });
      fs.writeFileSync(staleLockPath, 'incomplete-owner-record', 'utf8');
      fs.utimesSync(staleLockPath, new Date(0), new Date(0));
      const enabled = telemetry.enableTelemetry({ homeDir: staleHome });
      assert.strictEqual(enabled.enabled, true);
      assert.strictEqual(fs.existsSync(staleLockPath), false);

      const liveHome = createTempDir('ecc-telemetry-live-lock-');
      const liveLockPath = `${telemetry.getTelemetryConfigPath({ homeDir: liveHome })}.lock`;
      fs.mkdirSync(path.dirname(liveLockPath), { recursive: true });
      fs.writeFileSync(liveLockPath, JSON.stringify({
        pid: process.pid,
        token: 'live-owner',
        createdAtMs: 1,
      }), 'utf8');
      fs.utimesSync(liveLockPath, new Date(0), new Date(0));
      assert.throws(
        () => telemetry.enableTelemetry({
          homeDir: liveHome,
          lockTimeoutMs: 0,
        }),
        /state is busy/
      );
      fs.unlinkSync(liveLockPath);
    }],
    ['does not invoke transport while disabled or without an endpoint', async () => {
      const homeDir = createTempDir('ecc-telemetry-no-send-');
      let calls = 0;
      const transport = async () => {
        calls += 1;
      };

      const disabled = await telemetry.recordCommandUsage({
        homeDir,
        env: { ECC_TELEMETRY_ENDPOINT: 'https://telemetry.example.test/v1/events' },
        commandId: 'doctor',
        exitCode: 0,
        elapsedMs: 12,
        transport,
      });
      assert.strictEqual(disabled.reason, 'disabled');

      telemetry.enableTelemetry({ homeDir });
      const noEndpoint = await telemetry.recordCommandUsage({
        homeDir,
        env: {},
        commandId: 'doctor',
        exitCode: 0,
        elapsedMs: 12,
        transport,
      });
      assert.strictEqual(noEndpoint.reason, 'endpoint_not_configured');
      assert.strictEqual(calls, 0);
    }],
    ['excludes the sponsor-specific Ito command without creating a binding', async () => {
      const homeDir = createTempDir('ecc-telemetry-ito-excluded-');
      telemetry.enableTelemetry({ homeDir });
      let calls = 0;

      const result = await telemetry.recordCommandUsage({
        homeDir,
        env: { ECC_TELEMETRY_ENDPOINT: 'https://collector.example.test/events' },
        commandId: 'ito',
        exitCode: 0,
        elapsedMs: 12,
        transport: async () => {
          calls += 1;
        },
      });

      assert.deepStrictEqual(result, {
        sent: false,
        reason: 'excluded_command',
      });
      assert.strictEqual(calls, 0);
      assert.strictEqual(
        telemetry.getTelemetryStatus({ homeDir, env: {} }).boundEndpointCount,
        0
      );
    }],
    ['sends one minimized event through an injected transport after consent', async () => {
      const homeDir = createTempDir('ecc-telemetry-send-');
      telemetry.enableTelemetry({
        homeDir,
        randomUUID: () => '55555555-5555-4555-8555-555555555555',
      });
      const calls = [];

      const result = await telemetry.recordCommandUsage({
        homeDir,
        env: { ECC_TELEMETRY_ENDPOINT: 'https://telemetry.example.test/v1/events' },
        commandId: 'catalog',
        exitCode: 1,
        elapsedMs: 2800,
        platform: 'linux',
        arch: 'x64',
        transport: async (endpoint, event) => {
          calls.push({ endpoint, event });
        },
      });

      assert.strictEqual(result.sent, true);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].endpoint, 'https://telemetry.example.test/v1/events');
      assert.strictEqual(calls[0].event.commandId, 'catalog');
      assert.strictEqual(calls[0].event.result, 'failure');
      assert.strictEqual(calls[0].event.latencyBucket, '1s_to_10s');
    }],
    ['rejects insecure or credential-bearing telemetry endpoints', () => {
      assert.throws(
        () => telemetry.resolveTelemetryEndpoint({ ECC_TELEMETRY_ENDPOINT: 'http://example.com/events' }),
        /must use HTTPS/
      );
      assert.throws(
        () => telemetry.resolveTelemetryEndpoint({ ECC_TELEMETRY_ENDPOINT: 'https://user:pass@example.com/events' }),
        /must not contain credentials/
      );
      assert.throws(
        () => telemetry.resolveTelemetryEndpoint({ ECC_TELEMETRY_ENDPOINT: 'https://example.com/events?token=secret' }),
        /must not contain a query/
      );
    }],
    ['remote deletion follows every original endpoint after the environment changes', async () => {
      const homeDir = createTempDir('ecc-telemetry-delete-');
      telemetry.enableTelemetry({
        homeDir,
        now: '2026-06-01T00:00:00.000Z',
        randomUUID: () => '66666666-6666-4666-8666-666666666666',
      });
      await telemetry.recordCommandUsage({
        homeDir,
        now: '2026-06-01T00:00:00.000Z',
        env: { ECC_TELEMETRY_ENDPOINT: 'https://collector-a.example/events' },
        commandId: 'doctor',
        exitCode: 0,
        elapsedMs: 1,
        transport: async () => {},
      });
      await telemetry.recordCommandUsage({
        homeDir,
        now: '2026-07-02T00:00:00.000Z',
        env: { ECC_TELEMETRY_ENDPOINT: 'https://collector-a.example/events' },
        randomUUID: () => '77777777-7777-4777-8777-777777777777',
        commandId: 'doctor',
        exitCode: 0,
        elapsedMs: 1,
        transport: async () => {},
      });
      const calls = [];

      const result = await telemetry.deleteTelemetryData({
        homeDir,
        now: '2026-07-02T00:00:00.000Z',
        env: { ECC_TELEMETRY_ENDPOINT: 'https://collector-b.example/events' },
        transport: async (endpoint, payload, options) => {
          calls.push({ endpoint, payload, options });
        },
      });

      assert.strictEqual(result.deleted, true);
      assert.strictEqual(calls[0].endpoint, 'https://collector-a.example/events');
      assert.deepStrictEqual(calls[0].payload, {
        schemaVersion: 'ecc.cli-telemetry-deletion.v1',
        anonymousIds: [
          '66666666-6666-4666-8666-666666666666',
          '77777777-7777-4777-8777-777777777777',
        ],
      });
      assert.deepStrictEqual(
        Object.keys(calls[0].payload).sort(),
        [...deletionSchema.required].sort()
      );
      assert.strictEqual(calls[0].options.method, 'DELETE');
      assert.strictEqual(telemetry.getTelemetryStatus({ homeDir, env: {} }).state, 'absent');
    }],
    ['partial deletion retains only bindings that still need deletion', async () => {
      const homeDir = createTempDir('ecc-telemetry-delete-partial-');
      telemetry.enableTelemetry({
        homeDir,
        randomUUID: () => '78787878-7878-4878-8878-787878787878',
      });
      for (const endpoint of [
        'https://collector-a.example/events',
        'https://collector-b.example/events',
      ]) {
        await telemetry.recordCommandUsage({
          homeDir,
          env: { ECC_TELEMETRY_ENDPOINT: endpoint },
          commandId: 'doctor',
          exitCode: 0,
          elapsedMs: 1,
          transport: async () => {},
        });
      }

      await assert.rejects(
        telemetry.deleteTelemetryData({
          homeDir,
          env: {},
          transport: async endpoint => {
            if (endpoint === 'https://collector-b.example/events') {
              throw new Error('collector unavailable');
            }
          },
        }),
        /retained local deletion state/
      );

      const retained = telemetry.readConsentState({ homeDir });
      assert.strictEqual(retained.state, 'valid');
      assert.strictEqual(retained.value.enabled, false);
      assert.strictEqual(retained.value.activeAnonymousId, null);
      assert.deepStrictEqual(
        retained.value.identities.flatMap(identity => identity.endpoints),
        ['https://collector-b.example/events']
      );

      await telemetry.deleteTelemetryData({
        homeDir,
        env: {},
        transport: async endpoint => {
          assert.strictEqual(endpoint, 'https://collector-b.example/events');
        },
      });
      assert.strictEqual(telemetry.readConsentState({ homeDir }).state, 'absent');
    }],
    ['serializes deletion behind an in-flight event across processes', async () => {
      const homeDir = createTempDir('ecc-telemetry-delete-race-');
      const evidenceDir = createTempDir('ecc-telemetry-delete-race-evidence-');
      const enteredPath = path.join(evidenceDir, 'entered');
      const orderPath = path.join(evidenceDir, 'order');
      telemetry.enableTelemetry({
        homeDir,
        randomUUID: () => '79797979-7979-4979-8979-797979797979',
      });

      const recordSource = `
        const fs = require('fs');
        const telemetry = require(process.argv[1]);
        telemetry.recordCommandUsage({
          homeDir: process.argv[2],
          env: { ECC_TELEMETRY_ENDPOINT: 'https://collector.example.test/events' },
          commandId: 'doctor',
          exitCode: 0,
          elapsedMs: 1,
          transport: async () => {
            fs.writeFileSync(process.argv[3], 'entered', 'utf8');
            await new Promise(resolve => setTimeout(resolve, 250));
            fs.appendFileSync(process.argv[4], 'POST\\n', 'utf8');
          },
        }).then(result => {
          if (!result.sent) throw new Error(JSON.stringify(result));
        }).catch(error => {
          console.error(error.stack || error.message);
          process.exitCode = 1;
        });
      `;
      const recordPromise = runChild([
        '-e',
        recordSource,
        TELEMETRY_LIBRARY,
        homeDir,
        enteredPath,
        orderPath,
      ]);
      await waitForFile(enteredPath);

      const deleteSource = `
        const fs = require('fs');
        const telemetry = require(process.argv[1]);
        telemetry.deleteTelemetryData({
          homeDir: process.argv[2],
          env: {},
          transport: async () => {
            fs.appendFileSync(process.argv[3], 'DELETE\\n', 'utf8');
          },
        }).catch(error => {
          console.error(error.stack || error.message);
          process.exitCode = 1;
        });
      `;
      const deletePromise = runChild([
        '-e',
        deleteSource,
        TELEMETRY_LIBRARY,
        homeDir,
        orderPath,
      ]);
      await Promise.all([recordPromise, deletePromise]);

      assert.deepStrictEqual(
        fs.readFileSync(orderPath, 'utf8').trim().split('\n'),
        ['POST', 'DELETE']
      );
      assert.strictEqual(telemetry.readConsentState({ homeDir }).state, 'absent');
    }],
    ['local-only deletion never invokes transport', async () => {
      const homeDir = createTempDir('ecc-telemetry-delete-local-');
      telemetry.enableTelemetry({ homeDir });
      let calls = 0;

      const result = await telemetry.deleteTelemetryData({
        homeDir,
        env: { ECC_TELEMETRY_ENDPOINT: 'https://telemetry.example.test/v1/events' },
        localOnly: true,
        transport: async () => {
          calls += 1;
        },
      });

      assert.strictEqual(result.deleted, true);
      assert.strictEqual(result.localOnly, true);
      assert.strictEqual(calls, 0);
      assert.strictEqual(telemetry.getTelemetryStatus({ homeDir, env: {} }).state, 'absent');
    }],
    ['hard override prevents even a deletion network request', async () => {
      const homeDir = createTempDir('ecc-telemetry-delete-override-');
      telemetry.enableTelemetry({ homeDir });
      let calls = 0;

      await assert.rejects(
        telemetry.deleteTelemetryData({
          homeDir,
          env: {
            ECC_TELEMETRY: '0',
            ECC_TELEMETRY_ENDPOINT: 'https://telemetry.example.test/v1/events',
          },
          transport: async () => {
            calls += 1;
          },
        }),
        /ECC_TELEMETRY=0/
      );
      assert.strictEqual(calls, 0);
    }],
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    if (await runTest(name, fn)) passed += 1;
    else failed += 1;
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
