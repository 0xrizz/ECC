#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const telemetry = require('./lib/cli-telemetry');

const EVENT_SCHEMA_PATH = path.join(
  __dirname,
  '..',
  'schemas',
  'ecc-cli-telemetry-event.schema.json'
);

function showHelp() {
  console.log(`
ECC optional CLI usage telemetry (default off)

Usage:
  ecc telemetry status [--json]
  ecc telemetry enable [--json]
  ecc telemetry disable [--json]
  ecc telemetry preview [--command <id>] [--result <success|failure>] [--latency-ms <n>] [--json]
  ecc telemetry schema
  ecc telemetry delete [--local-only] [--json]

Privacy:
  - No install-time telemetry and no collection until "enable" is run.
  - ECC_TELEMETRY=0 is a hard runtime override.
  - Events contain only package/version, a coarse command ID, result category,
    latency bucket, coarse OS/architecture, and a rotating anonymous ID.
  - Arguments, prompts, paths, usernames, repositories, credentials, RFQs,
    supplier data, and demand data are never included.
  - "preview" and "schema" are local-only and never send an event.
`);
}

function parseFlags(args, allowedFlags) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!allowedFlags.has(arg)) {
      throw new Error(`Unknown telemetry option: ${arg}`);
    }
    if (arg === '--json' || arg === '--local-only') {
      values[arg.slice(2)] = true;
      continue;
    }
    if (index + 1 >= args.length) {
      throw new Error(`${arg} requires a value`);
    }
    values[arg.slice(2)] = args[index + 1];
    index += 1;
  }
  return values;
}

function printStatus(status, asJson) {
  if (asJson) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`Telemetry consent: ${status.persistedEnabled ? 'enabled' : 'disabled'}`);
  console.log(`Effective collection: ${status.effectiveEnabled ? 'enabled' : 'disabled'}`);
  console.log(`Delivery endpoint: ${status.endpointState.replace('_', ' ')}`);
  console.log(`Anonymous identity present: ${status.anonymousIdPresent ? 'yes' : 'no'}`);
  console.log(`Bound receiving endpoints: ${status.boundEndpointCount}`);
  console.log(`Identity rotation: ${status.identityRotationDays} days`);
  console.log(`Raw-event retention ceiling: ${status.eventRetentionDays} days`);
  if (status.override) console.log(`Override: ${status.override}`);
}

function parsePreviewOptions(args) {
  const flags = parseFlags(args, new Set([
    '--command',
    '--result',
    '--latency-ms',
    '--json',
  ]));
  const commandId = flags.command || 'doctor';
  if (!telemetry.COMMAND_IDS.includes(commandId) || commandId === 'other') {
    throw new Error(`Unsupported preview command: ${commandId}`);
  }
  const result = flags.result || 'success';
  if (result !== 'success' && result !== 'failure') {
    throw new Error('Preview result must be success or failure');
  }
  const elapsedMs = Number(flags['latency-ms'] || 250);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error('Preview latency must be a non-negative number');
  }
  return {
    asJson: Boolean(flags.json),
    commandId,
    exitCode: result === 'success' ? 0 : 1,
    elapsedMs,
  };
}

function preview(args) {
  const options = parsePreviewOptions(args);
  const event = telemetry.buildUsageEvent({
    anonymousId: crypto.randomUUID(),
    commandId: options.commandId,
    exitCode: options.exitCode,
    elapsedMs: options.elapsedMs,
  });
  if (options.asJson) {
    console.log(JSON.stringify(event, null, 2));
    return;
  }
  console.log('Local preview only; nothing was sent:');
  console.log(JSON.stringify(event, null, 2));
}

function printSchema(args) {
  parseFlags(args, new Set());
  console.log(fs.readFileSync(EVENT_SCHEMA_PATH, 'utf8').trim());
}

async function handleCommand(command, args) {
  if (command === 'status') {
    const flags = parseFlags(args, new Set(['--json']));
    printStatus(telemetry.getTelemetryStatus(), Boolean(flags.json));
    return;
  }
  if (command === 'enable') {
    const flags = parseFlags(args, new Set(['--json']));
    telemetry.enableTelemetry();
    printStatus(telemetry.getTelemetryStatus(), Boolean(flags.json));
    return;
  }
  if (command === 'disable') {
    const flags = parseFlags(args, new Set(['--json']));
    telemetry.disableTelemetry();
    printStatus(telemetry.getTelemetryStatus(), Boolean(flags.json));
    return;
  }
  if (command === 'preview') {
    preview(args);
    return;
  }
  if (command === 'schema') {
    printSchema(args);
    return;
  }
  if (command === 'delete') {
    const flags = parseFlags(args, new Set(['--local-only', '--json']));
    await telemetry.deleteTelemetryData({ localOnly: Boolean(flags['local-only']) });
    printStatus(telemetry.getTelemetryStatus(), Boolean(flags.json));
    return;
  }
  throw new Error(`Unknown telemetry command: ${command}`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    showHelp();
    return;
  }
  await handleCommand(command, argv.slice(1));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  handleCommand,
  main,
  parseFlags,
  parsePreviewOptions,
});
