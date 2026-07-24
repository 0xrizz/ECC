const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ECC_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'ecc.js');
const telemetry = require('../../scripts/lib/cli-telemetry');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, options = {}) {
  const homeDir = options.homeDir || createTempDir('ecc-telemetry-cli-');
  return spawnSync(process.execPath, [ECC_SCRIPT, ...args], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      ECC_TELEMETRY: '',
      ECC_TELEMETRY_ENDPOINT: '',
      ...options.env,
    },
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim());
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
    return false;
  }
}

function main() {
  console.log('\n=== Testing telemetry CLI consent flow ===\n');

  const tests = [
    ['top-level help exposes the telemetry control surface', () => {
      const result = runCli(['--help']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /telemetry/);
      assert.match(result.stdout, /default off/i);
    }],
    ['status is disabled by default', () => {
      const result = runCli(['telemetry', 'status', '--json']);
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.persistedEnabled, false);
      assert.strictEqual(payload.effectiveEnabled, false);
      assert.strictEqual(payload.deliveryConfigured, false);
    }],
    ['enable, status, and disable require explicit runtime commands', () => {
      const homeDir = createTempDir('ecc-telemetry-cli-consent-');
      const enabled = runCli(['telemetry', 'enable', '--json'], { homeDir });
      assert.strictEqual(enabled.status, 0, enabled.stderr);
      assert.strictEqual(parseJson(enabled.stdout).persistedEnabled, true);

      const status = runCli(['telemetry', 'status', '--json'], { homeDir });
      assert.strictEqual(status.status, 0, status.stderr);
      assert.strictEqual(parseJson(status.stdout).effectiveEnabled, true);

      const disabled = runCli(['telemetry', 'disable', '--json'], { homeDir });
      assert.strictEqual(disabled.status, 0, disabled.stderr);
      assert.strictEqual(parseJson(disabled.stdout).persistedEnabled, false);
    }],
    ['ECC_TELEMETRY=0 remains a hard runtime override', () => {
      const homeDir = createTempDir('ecc-telemetry-cli-override-');
      assert.strictEqual(runCli(['telemetry', 'enable'], { homeDir }).status, 0);
      const result = runCli(['telemetry', 'status', '--json'], {
        homeDir,
        env: { ECC_TELEMETRY: '0' },
      });
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.persistedEnabled, true);
      assert.strictEqual(payload.effectiveEnabled, false);
      assert.strictEqual(payload.override, 'ECC_TELEMETRY=0');
    }],
    ['preview is local, schema-constrained, and does not persist consent', () => {
      const homeDir = createTempDir('ecc-telemetry-cli-preview-');
      const result = runCli([
        'telemetry',
        'preview',
        '--command',
        'consult',
        '--result',
        'failure',
        '--latency-ms',
        '2450',
        '--json',
      ], { homeDir });
      assert.strictEqual(result.status, 0, result.stderr);
      const payload = parseJson(result.stdout);
      assert.strictEqual(payload.commandId, 'consult');
      assert.strictEqual(payload.result, 'failure');
      assert.strictEqual(payload.latencyBucket, '1s_to_10s');
      assert.deepStrictEqual(Object.keys(payload).sort(), [
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

      const status = runCli(['telemetry', 'status', '--json'], { homeDir });
      assert.strictEqual(parseJson(status.stdout).state, 'absent');
    }],
    ['schema command prints the public additionalProperties-false contract', () => {
      const result = runCli(['telemetry', 'schema']);
      assert.strictEqual(result.status, 0, result.stderr);
      const schema = parseJson(result.stdout);
      assert.strictEqual(schema.$id, 'https://github.com/affaan-m/ECC/schemas/ecc-cli-telemetry-event.schema.json');
      assert.strictEqual(schema.additionalProperties, false);
      assert.ok(schema.required.includes('commandId'));
    }],
    ['delete --local-only removes local telemetry identity without network', () => {
      const homeDir = createTempDir('ecc-telemetry-cli-delete-');
      assert.strictEqual(runCli(['telemetry', 'enable'], { homeDir }).status, 0);
      const result = runCli(['telemetry', 'delete', '--local-only', '--json'], { homeDir });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(parseJson(result.stdout).state, 'absent');
    }],
    ['deletion clears an identity that was never emitted without needing an endpoint', () => {
      const homeDir = createTempDir('ecc-telemetry-cli-delete-fail-');
      assert.strictEqual(runCli(['telemetry', 'enable'], { homeDir }).status, 0);
      const result = runCli(['telemetry', 'delete'], { homeDir });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(
        parseJson(runCli(['telemetry', 'status', '--json'], { homeDir }).stdout).state,
        'absent'
      );
    }],
    ['read-only rotation state never changes a successful parent command result', () => {
      if (process.platform === 'win32') return;
      const homeDir = createTempDir('ecc-telemetry-cli-readonly-');
      telemetry.enableTelemetry({
        homeDir,
        now: '2026-06-01T00:00:00.000Z',
        randomUUID: () => '89898989-8989-4989-8989-898989898989',
      });
      const configDir = path.dirname(telemetry.getTelemetryConfigPath({ homeDir }));
      fs.chmodSync(configDir, 0o500);
      let result;
      try {
        result = runCli(['catalog', 'profiles'], {
          homeDir,
          env: {
            ECC_TELEMETRY_ENDPOINT: 'https://collector.example.test/events',
          },
        });
      } finally {
        fs.chmodSync(configDir, 0o700);
      }

      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Install profiles:/);
      assert.doesNotMatch(result.stderr, /telemetry|EACCES/i);
    }],
    ['package contains no telemetry install lifecycle hook', () => {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
      );
      for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
        assert.ok(
          !packageJson.scripts?.[lifecycle],
          `${lifecycle} must never run telemetry`
        );
      }
    }],
    ['invalid telemetry commands and preview values fail closed', () => {
      const unknown = runCli(['telemetry', 'unknown']);
      assert.strictEqual(unknown.status, 1);
      assert.match(unknown.stderr, /Unknown telemetry command/);

      const rawCommand = runCli([
        'telemetry',
        'preview',
        '--command',
        'private-customer-name',
      ]);
      assert.strictEqual(rawCommand.status, 1);
      assert.match(rawCommand.stderr, /Unsupported preview command/);
    }],
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    if (runTest(name, fn)) passed += 1;
    else failed += 1;
  }

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
