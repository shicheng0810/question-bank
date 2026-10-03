/**
 * Safety boundaries for the static Pages build.
 *
 * This module deliberately knows nothing about question semantics. It protects
 * the filesystem transaction and validates the release inputs that the build
 * actually consumes, before an old output directory can be replaced.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SAFE_BANK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROTECTED_SOURCE_DIRS = ['.git', 'src', 'public', 'scripts', 'tests', 'functions', 'do-worker', 'node_modules', 'documents', 'commands'];

function fail(message) {
  throw new Error(`[build-pages safety] ${message}`);
}

function isSameOrDescendant(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSameOrAncestor(candidate, child) {
  return isSameOrDescendant(child, candidate);
}

function requireRegularFile(file, label) {
  if (!existsSync(file)) fail(`${label} does not exist: ${file}`);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular, non-symlink file: ${file}`);
  return realpathSync(file);
}

function requireRealDirectory(directory, label) {
  if (!existsSync(directory)) fail(`${label} does not exist: ${directory}`);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real, non-symlink directory: ${directory}`);
  return realpathSync(directory);
}

function assertSafeArtifactTree(directory, label, parent = path.dirname(directory)) {
  requireRealSibling(directory, parent, label);
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const entry = path.join(current, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) fail(`${label} contains a symlink: ${entry}`);
      if (stat.isDirectory()) {
        stack.push(entry);
      } else if (!stat.isFile()) {
        fail(`${label} contains an unsupported filesystem node: ${entry}`);
      }
    }
  }
}

function isRecognizedBuildOutput(directory) {
  const required = ['index.html', 'player.html', 'local.html', '.nojekyll', path.join('banks', 'index.json')];
  try {
    assertSafeArtifactTree(directory, 'existing output');
    return required.every((file) => {
      const target = path.join(directory, file);
      return existsSync(target) && lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink();
    });
  } catch (_error) {
    return false;
  }
}

function assertRecognizedBuildOutput(directory, label, parent) {
  assertSafeArtifactTree(directory, label, parent);
  const required = ['index.html', 'player.html', 'local.html', '.nojekyll', path.join('banks', 'index.json')];
  if (!required.every((file) => {
    const target = path.join(directory, file);
    return existsSync(target) && lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink();
  })) {
    fail(`${label} is not a recognized build artifact: ${directory}`);
  }
}

function physicalPath(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) fail(`could not resolve a physical path for: ${target}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...suffix);
}

/**
 * Reject a replace target before any destructive operation. Repository outputs
 * such as docs/ and .e2e-pages/ remain valid, while source trees never are.
 */
export function assertSafeOutputTarget({ root, output, home = os.homedir(), inputPaths = [], banksRoot }) {
  const realRoot = requireRealDirectory(path.resolve(root), 'repository root');
  const requested = path.resolve(output);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) fail(`refusing symlink output target: ${requested}`);
  const physicalOutput = physicalPath(requested);
  const realHome = physicalPath(home);

  if (isSameOrAncestor(physicalOutput, realRoot) || isSameOrAncestor(physicalOutput, realHome)) {
    fail(`refusing output that is the repository/home directory or an ancestor: ${physicalOutput}`);
  }
  for (const dir of PROTECTED_SOURCE_DIRS) {
    const lexicalProtectedPath = path.join(realRoot, dir);
    const protectedPath = existsSync(lexicalProtectedPath) ? physicalPath(lexicalProtectedPath) : lexicalProtectedPath;
    if (isSameOrDescendant(physicalOutput, protectedPath)) {
      fail(`refusing output inside protected source directory ${dir}: ${physicalOutput}`);
    }
  }
  if (banksRoot && isSameOrDescendant(physicalOutput, physicalPath(banksRoot))) {
    fail(`refusing output inside BANKS_ROOT: ${physicalOutput}`);
  }
  for (const input of inputPaths) {
    const realInput = physicalPath(input);
    if (isSameOrAncestor(physicalOutput, realInput)) {
      fail(`refusing output that would replace an actual build input: ${physicalOutput}`);
    }
  }
  if (existsSync(physicalOutput)) {
    const stat = lstatSync(physicalOutput);
    if (stat.isSymbolicLink()) fail(`refusing symlink output target: ${physicalOutput}`);
    if (!stat.isDirectory()) fail(`output target must be a directory when it exists: ${physicalOutput}`);
    if (readdirSync(physicalOutput).length && !isRecognizedBuildOutput(physicalOutput)) {
      fail(`refusing non-empty output that is not a recognized prior build artifact: ${physicalOutput}`);
    }
  }
  return { root: realRoot, output: physicalOutput };
}

function readJsonInput(file, label) {
  const text = readFileSync(file, 'utf8');
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    fail(`${label} is not valid JSON: ${file} (${error.message})`);
  }
}

function resolveEntrySource({ entry, banksRoot, id }) {
  const isProtected = entry.mode === 'protected';
  if (entry.mode != null && entry.mode !== 'protected' && entry.mode !== 'public') {
    fail(`bank ${id} has unsupported mode: ${entry.mode}`);
  }
  const key = isProtected ? 'payload' : 'json';
  if (typeof entry[key] !== 'string' || !entry[key].trim()) fail(`published bank ${id} is missing ${key}`);
  const rel = entry[key];
  if (path.isAbsolute(rel)) fail(`published bank ${id} must use a relative ${key} path`);
  const source = path.resolve(banksRoot, rel);
  if (!isSameOrDescendant(source, banksRoot)) fail(`published bank ${id} escapes BANKS_ROOT: ${rel}`);
  const realSource = requireRegularFile(source, `published bank ${id} source`);
  if (!isSameOrDescendant(realSource, banksRoot)) fail(`published bank ${id} resolves outside BANKS_ROOT: ${rel}`);
  const sourceInput = readJsonInput(realSource, `published bank ${id} source`);
  const parsed = sourceInput.value;
  if (!isProtected) {
    if (!Array.isArray(parsed)) fail(`published public bank ${id} must be a JSON array`);
    if (parsed.some((question) => !question || typeof question !== 'object' || Array.isArray(question))) {
      fail(`published public bank ${id} must contain object records (legacy question shapes remain supported)`);
    }
  } else {
    validateProtectedEnvelope(parsed, id);
  }
  return { path: realSource, rawText: sourceInput.text, parsed, isProtected };
}

function isBase64(value, minimumBytes) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return ((value.length / 4) * 3 - padding) >= minimumBytes;
}

function validateProtectedEnvelope(envelope, id) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail(`published protected bank ${id} must be a qbpack-v1 object`);
  if (envelope.format !== 'qbpack-v1' || envelope.cipher !== 'AES-GCM-256') fail(`published protected bank ${id} has an unsupported qbpack envelope`);
  if (!['gzip', 'none'].includes(envelope.compression)) fail(`published protected bank ${id} has invalid compression`);
  if (!envelope.kdf || typeof envelope.kdf !== 'object' || Array.isArray(envelope.kdf)
    || envelope.kdf.name !== 'PBKDF2' || envelope.kdf.hash !== 'SHA-256'
    || !Number.isSafeInteger(envelope.kdf.iterations) || envelope.kdf.iterations < 1) {
    fail(`published protected bank ${id} has invalid PBKDF2 parameters`);
  }
  if (!isBase64(envelope.salt_b64, 16) || !isBase64(envelope.iv_b64, 12) || !isBase64(envelope.ciphertext_b64, 16)) {
    fail(`published protected bank ${id} has invalid qbpack base64 material`);
  }
}

/** Validate every input that a published entry will consume. */
export function validateBuildInputs({ root, output, manifestPath, banksRoot, templatePath, allowEmpty, markers = [] }) {
  const realRoot = requireRealDirectory(path.resolve(root), 'repository root');
  const realBanksRoot = requireRealDirectory(path.resolve(banksRoot), 'BANKS_ROOT');
  const realManifestPath = requireRegularFile(path.resolve(manifestPath), 'BANKS_MANIFEST');
  const realTemplatePath = requireRegularFile(path.resolve(templatePath), 'question-bank template');
  const template = readFileSync(realTemplatePath, 'utf8');
  for (const marker of markers) if (!template.includes(marker)) fail(`question-bank template is missing marker: ${marker}`);
  const { value: manifest } = readJsonInput(realManifestPath, 'BANKS_MANIFEST');
  if (!Array.isArray(manifest)) fail('BANKS_MANIFEST must be a JSON array');

  const entrySources = new Map();
  const publishedIds = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('BANKS_MANIFEST entries must be objects');
    if (entry.deploy === false) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!SAFE_BANK_ID.test(id)) fail(`published bank has unsafe id: ${String(entry.id)}`);
    if (publishedIds.has(id)) fail(`BANKS_MANIFEST has duplicate published id: ${id}`);
    publishedIds.add(id);
    entrySources.set(entry, resolveEntrySource({ entry, banksRoot: realBanksRoot, id }));
  }
  if (!publishedIds.size && !allowEmpty) fail('BANKS_MANIFEST has no published banks; old output is preserved (set ALLOW_EMPTY_SITE=1 only for an intentional empty site)');

  const safe = assertSafeOutputTarget({
    root: realRoot,
    output,
    banksRoot: realBanksRoot,
    inputPaths: [realBanksRoot, realManifestPath, realTemplatePath, ...[...entrySources.values()].map((source) => source.path)],
  });
  return { ...safe, banksRoot: realBanksRoot, manifestPath: realManifestPath, templatePath: realTemplatePath, template, manifest, entrySources };
}

function siblingPath(target, label) {
  const parent = path.dirname(target);
  const base = path.basename(target);
  return path.join(parent, `.${base}.${label}-${process.pid}-${crypto.randomUUID()}`);
}

const OWNER_FORMAT = 'qb-build-owner-v1';
const OWNER_FILE = 'owner.json';
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerPath(plan) {
  return path.join(path.dirname(plan.output), `.${path.basename(plan.output)}.build-owner`);
}

function transactionPath(plan, label, token) {
  return path.join(path.dirname(plan.output), `.${path.basename(plan.output)}.${label}-${token}`);
}

function requireRealSibling(directory, parent, label) {
  let stat;
  try { stat = lstatSync(directory); } catch (error) {
    if (error && error.code === 'ENOENT') fail(`${label} does not exist: ${directory}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real, non-symlink directory: ${directory}`);
  if (path.dirname(directory) !== parent || physicalPath(directory) !== directory) fail(`${label} escapes the physical output parent: ${directory}`);
  return directory;
}

function ownerJournalPath(lockPath) {
  return path.join(lockPath, OWNER_FILE);
}

function ownerLayout(plan, token = crypto.randomUUID()) {
  if (!TOKEN.test(token)) fail('owner token is invalid');
  return {
    format: OWNER_FORMAT,
    token,
    output: plan.output,
    parent: path.dirname(plan.output),
    lock: ownerPath(plan),
    staging: transactionPath(plan, 'staging', token),
    backup: transactionPath(plan, 'previous', token),
    state: 'owned',
    createdAt: new Date().toISOString(),
    pid: process.pid,
  };
}

function assertOwnerJournal(plan, layout) {
  if (!layout || layout.format !== OWNER_FORMAT || !TOKEN.test(layout.token)
    || layout.output !== plan.output || layout.parent !== path.dirname(plan.output)
    || layout.lock !== ownerPath(plan)
    || layout.staging !== transactionPath(plan, 'staging', layout.token)
    || layout.backup !== transactionPath(plan, 'previous', layout.token)
    || typeof layout.state !== 'string') {
    fail('owner journal is malformed or does not bind this physical output');
  }
  return layout;
}

function readOwner(plan) {
  const lock = ownerPath(plan);
  requireRealSibling(lock, path.dirname(plan.output), 'build owner lock');
  const journalPath = ownerJournalPath(lock);
  if (!existsSync(journalPath) || lstatSync(journalPath).isSymbolicLink() || !lstatSync(journalPath).isFile()) {
    fail(`build owner lock has no regular journal: ${lock}`);
  }
  let layout;
  try { layout = JSON.parse(readFileSync(journalPath, 'utf8')); } catch (_error) { fail(`build owner journal is not valid JSON: ${lock}`); }
  return assertOwnerJournal(plan, layout);
}

function writeOwner(plan, layout, state) {
  const next = { ...layout, state, updatedAt: new Date().toISOString() };
  const lock = ownerPath(plan);
  requireRealSibling(lock, path.dirname(plan.output), 'build owner lock');
  const journalPath = ownerJournalPath(lock);
  if (!existsSync(journalPath) || lstatSync(journalPath).isSymbolicLink() || !lstatSync(journalPath).isFile()) {
    fail(`build owner journal is not a regular file: ${journalPath}`);
  }
  writeFileSync(journalPath, `${JSON.stringify(next)}\n`, { encoding: 'utf8' });
  return next;
}

function transactionArtifacts(plan) {
  const parent = path.dirname(plan.output);
  const base = `.${path.basename(plan.output)}.`;
  return readdirSync(parent)
    .filter((name) => name.startsWith(`${base}previous-`) || name.startsWith(`${base}staging-`))
    .map((name) => path.join(parent, name));
}

function assertNoUnownedArtifacts(plan) {
  const lock = ownerPath(plan);
  if (existsSync(lock)) fail(`another or unknown build owner exists; refusing recovery or output mutation: ${lock}`);
  const artifacts = transactionArtifacts(plan);
  if (artifacts.length) fail(`unowned build transaction artifacts require explicit recovery/manual review: ${artifacts.join(', ')}`);
}

function acquireOwner(plan) {
  assertNoUnownedArtifacts(plan);
  const layout = ownerLayout(plan);
  try {
    mkdirSync(layout.lock, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') fail(`another or unknown build owner exists; refusing recovery or output mutation: ${layout.lock}`);
    throw error;
  }
  try {
    requireRealSibling(layout.lock, layout.parent, 'build owner lock');
    writeFileSync(ownerJournalPath(layout.lock), `${JSON.stringify(layout)}\n`, { encoding: 'utf8', flag: 'wx' });
    return layout;
  } catch (error) {
    // The new lock has no safe journal if this fails; leave it visible rather
    // than risk a different build interpreting it as recoverable state.
    throw error;
  }
}

function releaseOwner(plan, layout, state = 'complete') {
  const current = readOwner(plan);
  if (current.token !== layout.token) fail('build owner token changed; refusing to release another owner');
  writeOwner(plan, current, state);
  requireRealSibling(ownerPath(plan), path.dirname(plan.output), 'build owner lock');
  rmSync(ownerPath(plan), { recursive: true, force: false });
}

function pauseAfterBackup(plan, layout, readyFile) {
  if (!readyFile) return;
  const ready = physicalPath(readyFile);
  if (path.dirname(ready) !== path.dirname(plan.output) || existsSync(ready)) fail('test pause file must be a new sibling of the disposable output');
  writeFileSync(ready, `${JSON.stringify({ token: layout.token, backup: layout.backup })}\n`, { encoding: 'utf8', flag: 'wx' });
  const continueFile = `${ready}.continue`;
  const deadline = Date.now() + 30_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(continueFile)) {
    if (Date.now() >= deadline) fail('test pause timed out waiting for continue file');
    Atomics.wait(sleeper, 0, 0, 25);
  }
}

function restoreOwnedBackup(plan, layout) {
  if (existsSync(plan.output)) fail('cannot restore a backup while an output already exists');
  // This is immediately before the recovery rename: do not promote a tree
  // whose nested paths changed after the owner journal was written.
  assertRecognizedBuildOutput(layout.backup, 'owned backup', layout.parent);
  renameSync(layout.backup, plan.output);
}

function removeOwnedStaging(plan, layout) {
  if (!existsSync(layout.staging)) return;
  assertSafeArtifactTree(layout.staging, 'owned staging directory', layout.parent);
  rmSync(layout.staging, { recursive: true, force: false });
}

/**
 * Explicitly recover a killed/interrupted owner. This never runs from an
 * ordinary build: callers must supply the exact token from its journal.
 */
export function recoverInterruptedBuild(plan, token) {
  const layout = readOwner(plan);
  if (layout.token !== token) fail('recovery token does not match the retained owner journal');
  if (!['prepared-to-swap', 'backup-created'].includes(layout.state)) {
    fail(`owner journal state is not recoverable without additional review: ${layout.state}`);
  }
  const artifacts = transactionArtifacts(plan);
  const allowed = new Set([layout.backup, layout.staging]);
  if (artifacts.some((artifact) => !allowed.has(artifact))) {
    fail(`owner journal has unexpected transaction artifacts; refusing recovery: ${artifacts.join(', ')}`);
  }
  if (existsSync(plan.output)) fail(`output already exists; refusing recovery that could override a newer artifact: ${plan.output}`);
  restoreOwnedBackup(plan, layout);
  removeOwnedStaging(plan, layout);
  const recovered = writeOwner(plan, layout, 'explicitly-recovered');
  const archive = transactionPath(plan, 'build-recovery', recovered.token);
  if (existsSync(archive)) fail(`recovery archive already exists; refusing to overwrite evidence: ${archive}`);
  requireRealSibling(ownerPath(plan), recovered.parent, 'build owner lock');
  renameSync(ownerPath(plan), archive);
  return { output: plan.output, archive, token: recovered.token };
}

export function beginSafeBuild(plan, { failDuringSwapForTest = false, pauseAfterBackupForTest } = {}) {
  const owner = acquireOwner(plan);
  const stagingOutput = owner.staging;
  try {
    mkdirSync(stagingOutput, { recursive: false, mode: 0o755 });
    requireRealSibling(stagingOutput, owner.parent, 'owned staging directory');
  } catch (error) {
    try { releaseOwner(plan, owner, 'staging-create-failed'); } catch (_releaseError) { /* retain visible owner evidence */ }
    throw error;
  }
  let committed = false;
  let aborted = false;
  const abort = () => {
    if (committed || aborted) return;
    aborted = true;
    try { removeOwnedStaging(plan, owner); } finally { releaseOwner(plan, owner, 'aborted'); }
  };
  return {
    ...plan,
    stagingOutput,
    ownerToken: owner.token,
    abort,
    commit(requiredFiles) {
      verifyStagedOutput(stagingOutput, requiredFiles);
      let movedOldOutput = false;
      try {
        const prepared = writeOwner(plan, owner, 'prepared-to-swap');
        if (existsSync(plan.output)) {
          renameSync(plan.output, prepared.backup);
          movedOldOutput = true;
        }
        const backedUp = writeOwner(plan, prepared, movedOldOutput ? 'backup-created' : 'no-prior-output');
        pauseAfterBackup(plan, backedUp, pauseAfterBackupForTest);
        if (failDuringSwapForTest) throw new Error('intentional build-pages failure during output swap');
        // Recheck at the last possible synchronous point before staging becomes
        // output; the first check happened before the old-output rename.
        verifyStagedOutput(stagingOutput, requiredFiles);
        renameSync(stagingOutput, plan.output);
        committed = true;
        const active = writeOwner(plan, backedUp, 'new-output-active');
        try {
          if (existsSync(active.backup)) {
            assertSafeArtifactTree(active.backup, 'owned backup', active.parent);
            rmSync(active.backup, { recursive: true, force: false });
          }
        } catch (cleanupError) {
          return { backupRetained: active.backup, cleanupError, ownerRetained: ownerPath(plan) };
        }
        releaseOwner(plan, active);
        return { backupRetained: null, ownerRetained: null };
      } catch (error) {
        if (movedOldOutput && !existsSync(plan.output) && existsSync(owner.backup)) restoreOwnedBackup(plan, owner);
        throw error;
      }
    },
  };
}

export function verifyStagedOutput(output, requiredFiles) {
  assertSafeArtifactTree(output, 'staged output');
  for (const file of requiredFiles) requireRegularFile(path.join(output, file), `staged output ${file}`);
  const siteManifest = readJsonInput(path.join(output, 'banks/index.json'), 'staged site manifest').value;
  if (!Array.isArray(siteManifest)) fail('staged site manifest must be a JSON array');
}
