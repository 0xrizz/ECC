/**
 * Contract tests for the installable Itô compute skill and MCP documentation.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
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

function main() {
  console.log("\n=== Testing Itô compute skill surface ===\n");

  const tests = [
    ["documents only the real CLI commands and MCP tools", () => {
      const skill = read("skills/ito-compute/SKILL.md");
      for (const command of [
        "ecc ito login",
        "ecc ito logout",
        "ecc ito auth",
        "ecc ito find",
        "ecc ito status",
        "ecc ito evals",
      ]) {
        assert.match(skill, new RegExp(command.replace(" ", "\\s+")));
      }
      assert.doesNotMatch(skill, /^\s*ito (?:auth|find|status|evals)\b/m);
      for (const tool of ["ito_auth", "ito_find", "ito_status"]) {
        assert.match(skill, new RegExp(`\\b${tool}\\b`));
      }
      assert.doesNotMatch(
        skill,
        /ito_lock|ito_run|ITO_CLI_DEMO|paper mode|simulated|live on the registry|publishing soon/i
      );
      assert.match(skill, /unpublished/i);
      assert.match(skill, /official Itô release\s+record/i);
      assert.match(skill, /publisher, provenance, and expected integrity/i);
      assert.match(skill, /npm install --global ito-compute-cli@0\.1\.0/);
      assert.doesNotMatch(skill, /git clone|npm ci/i);
      assert.match(skill, /ECC_ITO_CLI_EXECUTABLE/);
      assert.match(skill, /explicit absolute built entry/);
      assert.match(skill, /never discovers[^\n]*through `PATH`/);
      assert.match(skill, /ecc ito login --no-browser/);
      assert.match(skill, /return to the originating (?:agent|task)/i);
      assert.match(skill, /revok/i);
      assert.match(skill, /rent or purchase/i);
      assert.match(skill, /auth.*validat/i);
      assert.match(skill, /--no-browser/);
      assert.match(skill, /macOS Keychain/i);
      assert.match(skill, /(?:auth|find|status).*ITO_API_KEY/i);
      assert.match(skill, /ITO_AUTH_MODE=legacy[^.]*not required/i);
      assert.match(skill, /ECC (?:itself )?(?:does|performs) no browser automation/i);
      assert.match(skill, /ITO_ENABLE_SIXTYTWO_LIVE/);
      assert.match(skill, /sixtytwo-cli==0\.3\.33/);
      assert.match(skill, /explicit node/i);
      assert.match(skill, /cannot (?:rent|launch|recover|repair)/i);
      assert.doesNotMatch(skill, /npm link/);
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)[1];
      assert.doesNotMatch(frontmatter, /^metadata:/m);
      const interfaceMetadata = read("skills/ito-compute/agents/openai.yaml");
      assert.match(interfaceMetadata, /display_name: "Itô Compute"/);
      assert.match(interfaceMetadata, /default_prompt: .*\$ito-compute/);
    }],
    ["documents the entitlement-gated workload lifecycle without inventing node access", () => {
      const compute = read("skills/ito-compute/SKILL.md");
      const inference = read("skills/ito-inference/SKILL.md");
      const training = read("skills/ito-training/SKILL.md");
      for (const source of [compute, inference, training]) {
        assert.match(source, /server-verified[^.]*entitlement/i);
        assert.match(source, /workload-cancel/i);
        assert.match(source, /workload-cleanup/i);
        assert.match(source, /does not terminate|do not terminate|never terminate|neither operation\s+terminates/i);
        assert.match(source, /status/i);
        assert.match(source, /logs/i);
        assert.match(source, /workload-status/i);
        assert.match(source, /logs remain portal\/control-plane|logs remain[^.]*portal/i);
        assert.match(source, /portal/i);
        assert.match(source, /never.*(?:direct SSH|SSH material|node addresses)/is);
      }
      assert.match(inference, /ecc ito serve/);
      assert.match(training, /ecc ito train/);
      assert.match(training, /checkpoint-ref/);
      assert.match(inference, /ITO_WORKLOAD_CONFIRMATION_TOKEN/);
      assert.match(training, /ITO_WORKLOAD_CONFIRMATION_TOKEN/);
      for (const source of [inference, training]) {
        assert.match(source, /untrusted data/i);
        assert.match(source, /must never change agent identity/i);
        assert.match(source, /expand tool scope/i);
        assert.match(source, /bypass\s+confirmation/i);
        assert.match(source, /disclose secrets/i);
        assert.match(source, /execution is \*\*NOT READY\*\*/i);
      }
    }],
    ["keeps README and integration docs aligned with the separated auth contract", () => {
      for (const relativePath of [
        "README.md",
        "docs/design/ecc-ito-compute-integration.md",
      ]) {
        const source = read(relativePath);
        assert.match(source, /ecc ito login \[?--no-browser\]?/i, relativePath);
        assert.match(source, /ecc ito auth/i, relativePath);
        assert.match(source, /auth.*validat/i, relativePath);
        assert.match(source, /login.*(?:Keychain|device authorization)/is, relativePath);
        assert.doesNotMatch(source, /ecc ito auth --no-browser/i, relativePath);
        assert.match(source, /ITO_API_KEY.*(?:auth|find|status)/is, relativePath);
        assert.match(source, /ITO_AUTH_MODE=legacy[^.]*not required/i, relativePath);
      }
    }],
    ["registers one opt-in install module and capability", () => {
      const modules = readJson("manifests/install-modules.json").modules;
      const module = modules.find((candidate) => candidate.id === "ito-compute");
      assert.ok(module, "ito-compute install module is missing");
      assert.deepStrictEqual(module.paths, [
        "skills/ito-compute",
        "skills/ito-inference",
        "skills/ito-training",
      ]);
      assert.deepStrictEqual(module.dependencies, ["platform-configs"]);
      assert.strictEqual(module.defaultInstall, false);
      assert.strictEqual(module.stability, "beta");
      for (const target of ["claude", "codex", "opencode", "hermes", "kimi"]) {
        assert.ok(module.targets.includes(target), `${target} target is missing`);
      }

      const components = readJson("manifests/install-components.json").components;
      assert.deepStrictEqual(
        components.find((candidate) => candidate.id === "capability:ito-compute"),
        {
          id: "capability:ito-compute",
          family: "capability",
          description: "Authenticated Itô GPU inventory, RFQ, status, device revocation, and explicitly gated node-qualification workflows through the separately installed canonical CLI.",
          modules: ["ito-compute"],
        }
      );
      const profiles = readJson("manifests/install-profiles.json").profiles;
      assert.ok(profiles.full.modules.includes("ito-compute"));
    }],
    ["publishes the skill but never bundles the Itô CLI", () => {
      const packageJson = readJson("package.json");
      for (const skill of ["ito-compute", "ito-inference", "ito-training"]) {
        assert.ok(packageJson.files.includes(`skills/${skill}/`), `${skill} is missing from npm files`);
      }
      assert.ok(!packageJson.dependencies?.["ito-compute-cli"]);
      assert.ok(!packageJson.optionalDependencies?.["ito-compute-cli"]);
      assert.ok(!packageJson.bin?.ito);
    }],
    ["offers an opt-in local MCP template with the exact real tool boundary", () => {
      const mcpConfig = readJson("mcp-configs/mcp-servers.json");
      const server = mcpConfig.mcpServers["ito-compute"];
      assert.ok(server, "ito-compute MCP template is missing");
      assert.strictEqual(server.command, "node");
      assert.deepStrictEqual(server.args, [
        "/absolute/path/to/ito-cloud-runtime/cli/ito-compute-cli/dist/bin/ito-mcp.js",
      ]);
      assert.doesNotMatch(JSON.stringify(server), /npx|ito_lock|ito_run|paper|simulat/i);
      assert.match(server.description, /ito_auth, ito_find, and ito_status/);
      assert.match(server.description, /unpublished/i);
      assert.match(server.description, /ito_auth.*validat/i);
      assert.match(server.description, /macOS Keychain/i);
      assert.match(server.description, /no browser automation/i);
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
