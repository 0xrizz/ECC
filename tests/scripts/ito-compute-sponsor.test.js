/**
 * Tests for the Phase 1 Ito compute-sponsor surface.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COMPUTE_URL = 'https://compute.itomarkets.com';

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
    return false;
  }
}

function assertHonestComputeCopy(content) {
  assert.ok(content.includes(COMPUTE_URL), 'Should route compute intent to Ito');
  assert.match(content, /preferred compute sponsor/i);
  assert.match(content, /any GPU provider/i);
  assert.match(content, /managed inference[^\n.]*not live/i);
}

function main() {
  console.log('\n=== Testing Ito compute-sponsor surface ===\n');

  let passed = 0;
  let failed = 0;

  const tests = [
    ['README exposes the sponsor logo and honest self-hosting route', () => {
      const readme = read('README.md');
      assert.ok(readme.includes('assets/images/sponsors/ito.svg'));
      assertHonestComputeCopy(readme);
      assert.match(
        readme,
        /custom API endpoint or model gateway[\s\S]*Self-hosting the model behind that gateway[\s\S]*compute\.itomarkets\.com/
      );
      const sponsorMark = read('assets/images/sponsors/ito.svg');
      assert.match(sponsorMark, /<path\b/);
      assert.match(sponsorMark, /fill="#0F172A"/);
      assert.doesNotMatch(
        sponsorMark,
        /@import|<script|<foreignObject|\son[a-z]+=|(?:href|xlink:href)=/i
      );
    }],
    ['sponsor roster lists Ito alongside business sponsors', () => {
      const sponsors = read('SPONSORS.md');
      assert.ok(sponsors.includes('[**Itô**]'));
      assert.ok(sponsors.includes('assets/images/sponsors/ito.svg'));
      assert.ok(sponsors.includes(COMPUTE_URL));
    }],
    ['inference guide distinguishes rental compute from managed serving', () => {
      assertHonestComputeCopy(read('docs/ATLAS-CLOUD-GUIDE.md'));
    }],
    ['Claude plugin and Kimi harness docs route self-host intent without lock-in', () => {
      assertHonestComputeCopy(read('.claude-plugin/README.md'));
      assertHonestComputeCopy(read('.kimi/README.md'));
    }],
    ['top-level CLI help exposes the provider-neutral compute route', () => {
      const result = spawnSync('node', ['scripts/ecc.js', '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assertHonestComputeCopy(result.stdout);
    }],
    ['installer help and human dry-run expose the compute route', () => {
      const help = spawnSync('node', ['scripts/install-apply.js', '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.strictEqual(help.status, 0, help.stderr);
      assertHonestComputeCopy(help.stdout);

      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ito-home-'));
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ito-project-'));
      try {
        const dryRun = spawnSync(
          'node',
          [path.join(REPO_ROOT, 'scripts', 'install-apply.js'), '--profile', 'minimal', '--dry-run'],
          {
            cwd: projectDir,
            env: { ...process.env, HOME: homeDir },
            encoding: 'utf8',
          }
        );
        assert.strictEqual(dryRun.status, 0, dryRun.stderr);
        assertHonestComputeCopy(dryRun.stdout);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    }],
    ['npm package publishes the Ito mark and welcome route', () => {
      const packageJson = JSON.parse(read('package.json'));
      assert.ok(packageJson.files.includes('assets/images/sponsors/'));
      assert.ok(packageJson.scripts.welcome.includes(COMPUTE_URL));
      assert.ok(fs.existsSync(path.join(REPO_ROOT, 'assets', 'images', 'sponsors', 'ito.svg')));
    }],
  ];

  for (const [name, fn] of tests) {
    if (runTest(name, fn)) {
      passed += 1;
    } else {
      failed += 1;
    }
  }

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
