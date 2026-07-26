'use strict';

const fs = require('fs');
const path = require('path');

const { readInstallState } = require('../install-state');
const { assertWithinTrustedRoot } = require('../path-safety');

const CLAUDE_TARGETS = new Set(['claude', 'claude-project']);

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function normalizeSourceRelativePath(sourceRelativePath) {
  const slashNormalized = String(sourceRelativePath || '').replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashNormalized).replace(/^\.\//, '');
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function comparablePath(filePath) {
  const resolvedPath = path.resolve(filePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function samePath(leftPath, rightPath) {
  return comparablePath(leftPath) === comparablePath(rightPath);
}

function assertSafeSkillPath(targetPath, targetRoot, action) {
  const resolvedRoot = path.resolve(targetRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  if (
    relativePath === ''
    || relativePath.startsWith('..')
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing to ${action} outside the install root: '${targetPath}' is not within '${targetRoot}'.`
    );
  }

  let currentPath = resolvedRoot;
  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    try {
      if (fs.lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(
          `Refusing to ${action} through symlinked Claude skill path: '${currentPath}'.`
        );
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
  }

  if (pathExists(targetRoot)) {
    assertWithinTrustedRoot(targetPath, targetRoot, action);
  }
}

function describeClaudeSkillOperation(targetRoot, operation) {
  if (!operation || operation.kind !== 'copy-file') {
    return null;
  }

  const sourceRelativePath = normalizeSourceRelativePath(operation.sourceRelativePath);
  if (!sourceRelativePath) {
    return null;
  }

  const sourceParts = sourceRelativePath.split('/');
  if (sourceParts[0] !== 'skills' || sourceParts.length < 3 || !sourceParts[1]) {
    return null;
  }

  const skillName = sourceParts[1];
  const relativeParts = sourceParts.slice(2);
  const flatSkillRoot = path.join(targetRoot, 'skills', skillName);
  const legacySkillRoot = path.join(targetRoot, 'skills', 'ecc', skillName);

  return {
    sourceKey: sourceRelativePath,
    skillName,
    flatSkillRoot,
    flatDestinationPath: path.join(flatSkillRoot, ...relativeParts),
    legacySkillRoot,
    legacyDestinationPath: path.join(legacySkillRoot, ...relativeParts),
  };
}

function assertSafeClaudeSkillOperation(plan, operation) {
  const target = plan && plan.adapter && plan.adapter.target;
  if (!CLAUDE_TARGETS.has(target)) {
    return;
  }
  const descriptor = describeClaudeSkillOperation(plan.targetRoot, operation);
  if (!descriptor || !samePath(operation.destinationPath, descriptor.flatDestinationPath)) {
    return;
  }
  assertSafeSkillPath(
    operation.destinationPath,
    plan.targetRoot,
    'install Claude skill'
  );
}

function isManagedOperation(operation) {
  return operation && operation.ownership === 'managed';
}

function uniqueOperations(operations) {
  const seen = new Set();
  return operations.filter(operation => {
    const key = [
      operation.kind,
      normalizeSourceRelativePath(operation.sourceRelativePath) || operation.sourceRelativePath,
      comparablePath(operation.destinationPath),
    ].join('\0');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildState(statePreview, operations) {
  return {
    ...statePreview,
    operations: uniqueOperations(operations).map(operation => ({ ...operation })),
  };
}

function groupCurrentSkillOperations(plan) {
  const groups = new Map();
  for (const operation of plan.operations) {
    const descriptor = describeClaudeSkillOperation(plan.targetRoot, operation);
    if (!descriptor || !samePath(operation.destinationPath, descriptor.flatDestinationPath)) {
      continue;
    }

    assertSafeSkillPath(
      operation.destinationPath,
      plan.targetRoot,
      'install Claude skill'
    );

    const current = groups.get(descriptor.flatSkillRoot) || [];
    current.push({ operation, descriptor });
    groups.set(descriptor.flatSkillRoot, current);
  }
  return groups;
}

function classifyPreviousOperations(plan, previousState) {
  const flatByDestination = new Map();
  const legacyBySource = new Map();
  const legacyBySkillRoot = new Map();

  for (const operation of (previousState && previousState.operations) || []) {
    if (!isManagedOperation(operation)) {
      continue;
    }
    const descriptor = describeClaudeSkillOperation(plan.targetRoot, operation);
    if (!descriptor) {
      continue;
    }

    if (samePath(operation.destinationPath, descriptor.flatDestinationPath)) {
      assertSafeSkillPath(
        operation.destinationPath,
        plan.targetRoot,
        'inspect managed Claude skill'
      );
      flatByDestination.set(comparablePath(operation.destinationPath), operation);
      continue;
    }

    if (!samePath(operation.destinationPath, descriptor.legacyDestinationPath)) {
      continue;
    }

    assertSafeSkillPath(
      operation.destinationPath,
      plan.targetRoot,
      'migrate managed Claude skill'
    );
    legacyBySource.set(descriptor.sourceKey, operation);
    const current = legacyBySkillRoot.get(descriptor.legacySkillRoot) || [];
    current.push({ operation, descriptor });
    legacyBySkillRoot.set(descriptor.legacySkillRoot, current);
  }

  return {
    flatByDestination,
    legacyBySource,
    legacyBySkillRoot,
  };
}

function createConflictWarning(skillName, flatSkillRoot, retainsLegacy) {
  const legacySuffix = retainsLegacy
    ? ' The existing ECC-managed nested copy was retained and remains tracked for uninstall.'
    : '';
  return `Skipped Claude skill '${skillName}' at ${flatSkillRoot}: the flat skill directory is user-owned because it is not recorded in ECC install-state.${legacySuffix}`;
}

function createFileConflictWarning(destinationPath, retainsLegacy) {
  const legacySuffix = retainsLegacy
    ? ' The matching ECC-managed nested file was retained and remains tracked for uninstall.'
    : '';
  return `Skipped user-owned Claude skill file ${destinationPath}: the existing file is not recorded in ECC install-state.${legacySuffix}`;
}

function prepareClaudeSkillMigration(plan) {
  const target = plan && plan.adapter && plan.adapter.target;
  if (!CLAUDE_TARGETS.has(target)) {
    return {
      enabled: false,
      appliedOperations: [...plan.operations],
      skippedOperations: [],
      warnings: [],
      bridgeState: plan.statePreview,
      finalState: plan.statePreview,
      legacyOperationsToRemove: [],
      requiresBridgeState: false,
    };
  }

  const previousState = pathExists(plan.installStatePath)
    ? readInstallState(plan.installStatePath)
    : null;
  const currentGroups = groupCurrentSkillOperations(plan);
  const previous = classifyPreviousOperations(plan, previousState);
  const skippedOperations = [];
  const skippedDestinations = new Set();
  const warnings = [];
  const currentSourceKeys = new Set(
    [...currentGroups.values()]
      .flat()
      .map(({ descriptor }) => descriptor.sourceKey)
  );
  const retainedLegacyOperations = new Set(
    [...previous.legacyBySource.entries()]
      .filter(([sourceKey]) => !currentSourceKeys.has(sourceKey))
      .map(([_sourceKey, operation]) => operation)
  );

  for (const [flatSkillRoot, entries] of currentGroups) {
    const hasManagedFlatFile = entries.some(({ operation }) => (
      previous.flatByDestination.has(comparablePath(operation.destinationPath))
    ));
    const legacyEntries = previous.legacyBySkillRoot.get(
      entries[0].descriptor.legacySkillRoot
    ) || [];

    if (pathExists(flatSkillRoot) && !hasManagedFlatFile) {
      for (const { operation } of entries) {
        skippedOperations.push(operation);
        skippedDestinations.add(comparablePath(operation.destinationPath));
      }
      for (const { operation } of legacyEntries) {
        retainedLegacyOperations.add(operation);
      }
      warnings.push(createConflictWarning(
        entries[0].descriptor.skillName,
        flatSkillRoot,
        legacyEntries.length > 0
      ));
      continue;
    }

    for (const { operation, descriptor } of entries) {
      const destinationKey = comparablePath(operation.destinationPath);
      const isPreviouslyManaged = previous.flatByDestination.has(destinationKey);
      if (!pathExists(operation.destinationPath) || isPreviouslyManaged) {
        continue;
      }

      skippedOperations.push(operation);
      skippedDestinations.add(destinationKey);
      const legacyOperation = previous.legacyBySource.get(descriptor.sourceKey);
      if (legacyOperation) {
        retainedLegacyOperations.add(legacyOperation);
      }
      warnings.push(createFileConflictWarning(
        operation.destinationPath,
        Boolean(legacyOperation)
      ));
    }
  }

  const appliedOperations = plan.operations.filter(operation => (
    !skippedDestinations.has(comparablePath(operation.destinationPath))
  ));
  const legacyOperations = [...previous.legacyBySource.values()];
  const legacyOperationsToRemove = legacyOperations.filter(operation => (
    !retainedLegacyOperations.has(operation)
  ));
  const finalOperations = [
    ...plan.statePreview.operations.filter(operation => (
      !skippedDestinations.has(comparablePath(operation.destinationPath))
    )),
    ...retainedLegacyOperations,
  ];
  const appliedSkillDestinations = new Set(
    [...currentGroups.values()]
      .flat()
      .map(({ operation }) => operation)
      .filter(operation => !skippedDestinations.has(comparablePath(operation.destinationPath)))
      .map(operation => comparablePath(operation.destinationPath))
  );
  const plannedFlatSkillOperations = plan.statePreview.operations.filter(operation => (
    appliedSkillDestinations.has(comparablePath(operation.destinationPath))
  ));
  const bridgeOperations = [
    ...((previousState && previousState.operations) || []),
    ...plannedFlatSkillOperations,
  ];

  return {
    enabled: true,
    appliedOperations,
    skippedOperations,
    warnings,
    bridgeState: buildState(plan.statePreview, bridgeOperations),
    finalState: buildState(plan.statePreview, finalOperations),
    legacyOperationsToRemove,
    requiresBridgeState: plannedFlatSkillOperations.length > 0,
  };
}

function cleanupEmptyLegacyParents(filePath, targetRoot) {
  const skillsRoot = path.join(targetRoot, 'skills');
  let currentPath = path.dirname(filePath);

  while (!samePath(currentPath, skillsRoot)) {
    assertSafeSkillPath(currentPath, targetRoot, 'clean Claude skill migration');
    if (!pathExists(currentPath) || fs.readdirSync(currentPath).length > 0) {
      return;
    }
    fs.rmdirSync(currentPath);
    currentPath = path.dirname(currentPath);
  }
}

function removeLegacyClaudeSkillFiles(migration, targetRoot) {
  for (const operation of migration.legacyOperationsToRemove) {
    assertSafeSkillPath(
      operation.destinationPath,
      targetRoot,
      'migrate managed Claude skill'
    );
    fs.rmSync(operation.destinationPath, { force: true });
    cleanupEmptyLegacyParents(operation.destinationPath, targetRoot);
  }
}

module.exports = {
  assertSafeClaudeSkillOperation,
  prepareClaudeSkillMigration,
  removeLegacyClaudeSkillFiles,
};
