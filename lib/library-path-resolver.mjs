#!/usr/bin/env node

/**
 * library-path-resolver.mjs
 *
 * Per-device resolver for the local path of a claude-library checkout.
 *
 * Why this exists:
 *   The legacy design baked the library's absolute path into every project's
 *   `.claude/library.json` (the `library_path` field). That field is wrong on
 *   any second device where the library lives at a different absolute path,
 *   so the auto-push hook silently fails after a clone.
 *
 *   v5.3 moves the path out of the per-repo manifest and into a per-device
 *   registry at `~/.claude/library-paths.json` keyed by `library_remote`
 *   (the git URL of the library — stable across machines, distinct per
 *   library / per fork).
 *
 * Resolution chain (first hit wins):
 *   1. `process.env.CLAUDE_LIBRARY_PATH`          → source: 'env'
 *   2. registry lookup by `libraryRemote`         → source: 'registry'
 *   3. autodetect under common GitHub roots       → source: 'autodetect'
 *      (auto-registers on hit)
 *   4. legacy `manifest.library_path` if it       → source: 'legacy-manifest'
 *      points to an existing directory
 *      (auto-registers on hit)
 *   5. fail                                       → source: 'none'
 *
 * Pure Node.js. Zero external dependencies. Match `sync.mjs` style:
 * ES modules, single file, `node:` imports only.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

// ── Constants ────────────────────────────────────────────────────────────────

const REGISTRY_SCHEMA = 'library-paths-v1';
const AUTODETECT_ROOTS = ['GitHub', 'Github', 'github', 'code', 'projects', 'src'];
const IS_WINDOWS = platform() === 'win32';

// ── Path utilities ───────────────────────────────────────────────────────────

function norm(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/\\/g, '/');
}

/**
 * Normalize a git remote URL for comparison.
 * - Trims whitespace
 * - Strips trailing `.git`
 * - Lowercases (remotes are not case-sensitive in practice and Windows
 *   filesystems are case-insensitive, so case-insensitive matching is safest)
 *
 * Both `https://github.com/foo/bar.git` and `https://github.com/foo/bar`
 * normalize to the same value.
 */
function normalizeRemote(remote) {
  if (typeof remote !== 'string') return '';
  let r = remote.trim();
  if (r.toLowerCase().endsWith('.git')) r = r.slice(0, -4);
  return r.toLowerCase();
}

function remotesMatch(a, b) {
  return normalizeRemote(a) === normalizeRemote(b) && normalizeRemote(a) !== '';
}

// ── Registry I/O ─────────────────────────────────────────────────────────────

export function getRegistryPath() {
  return join(homedir(), '.claude', 'library-paths.json');
}

/**
 * Read the registry. Returns the parsed object, or `{}` if the file is
 * missing or unreadable. Never throws on missing-file — that's the empty
 * state, not an error.
 */
export function readPathRegistry() {
  const filepath = getRegistryPath();
  if (!existsSync(filepath)) return {};
  try {
    const data = JSON.parse(readFileSync(filepath, 'utf8'));
    if (data && typeof data === 'object') return data;
    return {};
  } catch {
    // Corrupt file. Treat as empty so callers can recover by re-registering.
    return {};
  }
}

function buildRegistryShape(existing) {
  const data = existing && typeof existing === 'object' ? existing : {};
  if (data.$schema !== REGISTRY_SCHEMA) data.$schema = REGISTRY_SCHEMA;
  if (!data.libraries || typeof data.libraries !== 'object') data.libraries = {};
  return data;
}

/**
 * Write a `(libraryRemote → localPath)` mapping into the registry.
 * Idempotent: only writes to disk if the value differs from what's there.
 *
 * Path is stored normalized (forward slashes) so cross-platform consumers
 * read consistent values.
 *
 * Returns `true` if a write occurred, `false` if the entry was already
 * up-to-date.
 */
export function writePathRegistry(libraryRemote, localPath) {
  if (!libraryRemote || typeof libraryRemote !== 'string') return false;
  if (!localPath || typeof localPath !== 'string') return false;

  const key = libraryRemote.trim();
  const value = norm(localPath);
  if (!key || !value) return false;

  const existing = readPathRegistry();
  const data = buildRegistryShape(existing);

  if (data.libraries[key] === value) return false;

  data.libraries[key] = value;

  const filepath = getRegistryPath();
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

/**
 * Remove an entry from the registry. Returns `true` if an entry was
 * removed, `false` if there was nothing to remove.
 */
export function removePathRegistryEntry(libraryRemote) {
  if (!libraryRemote || typeof libraryRemote !== 'string') return false;
  const key = libraryRemote.trim();
  if (!key) return false;

  const filepath = getRegistryPath();
  if (!existsSync(filepath)) return false;

  const data = buildRegistryShape(readPathRegistry());
  if (!(key in data.libraries)) return false;

  delete data.libraries[key];
  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
  return true;
}

/**
 * Look up a path in the registry by remote. Tolerates `.git` suffix and
 * case differences — entries written under any spelling resolve as long
 * as `normalizeRemote` returns the same thing.
 */
function lookupRegistry(libraryRemote) {
  const data = readPathRegistry();
  const libraries = (data && data.libraries) || {};

  // Fast path: exact-string match (common case).
  if (typeof libraries[libraryRemote] === 'string') {
    return libraries[libraryRemote];
  }

  // Slow path: normalize-and-compare every key. Handles `.git` suffix
  // mismatches and case differences.
  const target = normalizeRemote(libraryRemote);
  if (!target) return null;
  for (const [key, value] of Object.entries(libraries)) {
    if (typeof value !== 'string') continue;
    if (normalizeRemote(key) === target) return value;
  }
  return null;
}

// ── Autodetect ───────────────────────────────────────────────────────────────

function listSubdirs(dir) {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir);
    const result = [];
    for (const name of entries) {
      const p = join(dir, name);
      try {
        if (statSync(p).isDirectory()) result.push(p);
      } catch { /* skip unreadable entries */ }
    }
    return result;
  } catch {
    return [];
  }
}

function getRemoteForDir(dir) {
  try {
    const out = execSync('git -C "' + dir + '" remote get-url origin', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

/**
 * Walk common roots under the user's home (`~/GitHub`, `~/code`, etc.)
 * and look for a checkout whose `origin` remote matches `libraryRemote`.
 *
 * On a hit, we register the result so future calls take the fast path.
 */
function autodetect(libraryRemote) {
  if (!libraryRemote) return null;

  for (const rootName of AUTODETECT_ROOTS) {
    const root = join(homedir(), rootName);
    if (!existsSync(root)) continue;

    const subdirs = listSubdirs(root);
    for (const dir of subdirs) {
      const remote = getRemoteForDir(dir);
      if (!remote) continue;
      if (remotesMatch(remote, libraryRemote)) {
        const normalized = norm(dir);
        // Self-register so we don't pay this cost again.
        try { writePathRegistry(libraryRemote, normalized); }
        catch { /* registry write failures are non-fatal */ }
        return normalized;
      }
    }
  }

  return null;
}

// ── Legacy manifest fallback ─────────────────────────────────────────────────

function tryLegacyManifest(manifestPath, libraryRemote) {
  if (!manifestPath) return null;
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const legacyPath = manifest && manifest.library_path;
    if (typeof legacyPath !== 'string' || !legacyPath) return null;
    if (!existsSync(legacyPath)) return null;

    const normalized = norm(legacyPath);
    // Auto-register so the next sync run can drop the legacy field cleanly.
    if (libraryRemote) {
      try { writePathRegistry(libraryRemote, normalized); }
      catch { /* non-fatal */ }
    }
    return normalized;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the local path of the library identified by `libraryRemote`.
 *
 * @param {object} opts
 * @param {string} opts.libraryRemote - Git remote URL of the library
 *     (the `library_remote` field from the project's `.claude/library.json`).
 *     Required for registry lookup and autodetect; if omitted, only the env
 *     and legacy-manifest sources can succeed.
 * @param {string} [opts.manifestPath] - Absolute path to the project's
 *     `.claude/library.json`. Used only for the legacy fallback step.
 * @param {string} [opts.projectDir] - Reserved for future use (e.g.
 *     resolving `manifestPath` from a project root). Currently unused but
 *     accepted for forward compatibility.
 *
 * @returns {Promise<{ path: string|null, source: 'env'|'registry'|'autodetect'|'legacy-manifest'|'none' }>}
 */
export async function resolveLibraryPath({ libraryRemote, manifestPath, projectDir } = {}) {
  // 1. Env override — highest priority for ad-hoc / CI / debugging.
  const envPath = process.env.CLAUDE_LIBRARY_PATH;
  if (envPath && existsSync(envPath)) {
    return { path: norm(envPath), source: 'env' };
  }

  // 2. Registry lookup keyed by remote.
  if (libraryRemote) {
    const registered = lookupRegistry(libraryRemote);
    if (registered && existsSync(registered)) {
      return { path: norm(registered), source: 'registry' };
    }
  }

  // 3. Autodetect across common GitHub roots.
  if (libraryRemote) {
    const detected = autodetect(libraryRemote);
    if (detected && existsSync(detected)) {
      return { path: norm(detected), source: 'autodetect' };
    }
  }

  // 4. Legacy manifest fallback (one-shot graceful migration).
  const legacy = tryLegacyManifest(manifestPath, libraryRemote);
  if (legacy) {
    return { path: legacy, source: 'legacy-manifest' };
  }

  // 5. Nothing worked.
  return { path: null, source: 'none' };
}

/**
 * Format a user-facing error message for the case where resolution failed.
 * The hook's logging path surfaces this so a user on a fresh device sees a
 * concrete next step instead of "Library path not found".
 */
export function formatResolutionError(libraryRemote) {
  const remote = libraryRemote || '<unknown>';
  return 'Library path not registered on this device. Run `node sync.mjs --link` from your library directory (' + remote + ') to register it.';
}

// `IS_WINDOWS` is kept available for future platform-specific behavior
// (e.g. case-insensitive path comparisons beyond what `normalizeRemote`
// already does). Reference it so unused-vars linters stay quiet.
void IS_WINDOWS;
