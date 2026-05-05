#!/usr/bin/env node
/**
 * LibraryHook - Stop-hook driver for auto-sync
 *
 * Fires once at the end of every Claude turn (Stop event). Runs a cheap
 * mtime walk over library-managed paths in the project. If any managed
 * file is newer than `lastSyncAt`, runs `sync.mjs --push --yes`
 * synchronously. No detached spawning. No platform-specific code.
 *
 * NEVER blocks the turn end: any error path exits 0.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  resolveLibraryPath,
  formatResolutionError,
} from "./library-path-resolver.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectDir = resolve(__dirname, "..", "..", "..");

const SYNC_ARTIFACTS = new Set([
  "pending-sync.json",
  "skill-rules.json",
  "agent-rules.json",
  "recommendation-log.json",
  ".syncignore",
  ".DS_Store",
  "Thumbs.db",
]);

const IGNORE_DIRS = new Set(["logs", "node_modules"]);

const PUSH_TIMEOUT_MS = 25_000;
const LOG_MAX_LINES = 500;

function normalizePath(p) {
  return p.replace(/\\/g, "/");
}

function log(message) {
  try {
    const logDir = join(__dirname, "logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "library-sync.log");
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    const existing = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    const lines = existing.split("\n").slice(-LOG_MAX_LINES);
    writeFileSync(logFile, lines.join("\n") + line);
  } catch (e) {
    /* logging is best-effort */
  }
}

function readState(stateFile) {
  if (!existsSync(stateFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

function writeState(stateFile, state) {
  try {
    const ts =
      typeof state.lastSyncAt === "number" && Number.isFinite(state.lastSyncAt)
        ? state.lastSyncAt
        : 0;
    writeFileSync(
      stateFile,
      JSON.stringify({
        lastSyncAt: ts,
        lastError: state.lastError == null ? null : String(state.lastError),
      }),
      "utf-8"
    );
  } catch (e) {
    /* state write failures are non-fatal */
  }
}

/**
 * Walk a directory looking for any mtime > threshold. Returns true on
 * the first hit (early bail). Skips sync artifacts, log files, and
 * IGNORE_DIRS. Honors per-item ignore patterns matched against any
 * single path segment.
 */
function dirHasNewer(dirPath, threshold, ignorePatterns) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (SYNC_ARTIFACTS.has(entry.name)) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.endsWith(".log")) continue;
    if (
      ignorePatterns.length > 0 &&
      ignorePatterns.some((p) => entry.name.toLowerCase() === p.toLowerCase())
    ) {
      continue;
    }
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (dirHasNewer(fullPath, threshold, ignorePatterns)) return true;
    } else {
      try {
        const mt = statSync(fullPath).mtimeMs;
        if (mt > threshold) return true;
      } catch {
        /* skip unreadable */
      }
    }
  }
  return false;
}

function fileNewer(filePath, threshold) {
  try {
    return statSync(filePath).mtimeMs > threshold;
  } catch {
    return false;
  }
}

/**
 * Build the list of managed paths from the manifest. Mirrors the
 * structure used by sync.mjs and the previous hook implementation.
 */
function buildManagedPaths(manifest) {
  const managed = manifest.managed || {};
  const ignorePatterns = managed.ignore || {};
  const paths = [];

  for (const name of Object.keys(managed.skills || {})) {
    paths.push({
      type: "dir",
      path: join(projectDir, ".claude", "skills", name),
      ignore: ignorePatterns[name] || [],
    });
  }

  for (const name of Object.keys(managed.agents || {})) {
    paths.push({
      type: "file",
      path: join(projectDir, ".claude", "agents", name + ".md"),
    });
  }

  for (const name of Object.keys(managed.commands || {})) {
    paths.push({
      type: "file",
      path: join(projectDir, ".claude", "commands", name + ".md"),
    });
  }

  for (const name of Object.keys(managed.hooks || {})) {
    paths.push({
      type: "dir",
      path: join(projectDir, ".claude", "hooks", name),
      ignore: ignorePatterns[name] || [],
    });
  }

  for (const name of Object.keys(managed.rules || {})) {
    paths.push({
      type: "file",
      path: join(projectDir, ".claude", "rules", name + ".md"),
    });
  }

  if (managed["claude-md"]) {
    paths.push({ type: "file", path: join(projectDir, "CLAUDE.md") });
  }
  if (managed.settings) {
    paths.push({
      type: "file",
      path: join(projectDir, ".claude", "settings.json"),
    });
  }
  if (managed.mcp) {
    paths.push({ type: "file", path: join(projectDir, ".mcp.json") });
  }

  for (const [, deployPath] of Object.entries(managed.files || {})) {
    paths.push({ type: "file", path: join(projectDir, deployPath) });
  }

  return paths;
}

async function main() {
  // Drain stdin (Stop hook payload). We don't need to parse it; reading
  // ensures the pipe doesn't block the parent.
  try {
    readFileSync(0, "utf-8");
  } catch {
    /* no stdin is fine */
  }

  // Read manifest (prefer new name, fall back to legacy).
  let manifestPath = join(projectDir, ".claude", "library.json");
  if (!existsSync(manifestPath)) {
    manifestPath = join(projectDir, ".claude", ".library-manifest.json");
  }
  if (!existsSync(manifestPath)) return;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    log("Manifest unreadable: " + e.message);
    return;
  }

  const stateFile = join(__dirname, "pending-sync.json");
  const state = readState(stateFile);
  let lastSyncAt =
    state && typeof state.lastSyncAt === "number" ? state.lastSyncAt : 0;

  // Bootstrap: no usable lastSyncAt. Seed from manifest.synced_at, or
  // claim "now" and skip this run so we don't push everything spuriously.
  let bootstrapping = false;
  if (!lastSyncAt) {
    bootstrapping = true;
    if (manifest.synced_at) {
      const t = new Date(manifest.synced_at).getTime();
      if (Number.isFinite(t) && t > 0) {
        lastSyncAt = t;
        bootstrapping = false;
      }
    }
    if (bootstrapping) {
      writeState(stateFile, { lastSyncAt: Date.now(), lastError: null });
      return;
    }
  }

  const managedPaths = buildManagedPaths(manifest);

  let foundNewer = false;
  for (const entry of managedPaths) {
    if (!existsSync(entry.path)) continue;
    if (entry.type === "dir") {
      if (dirHasNewer(entry.path, lastSyncAt, entry.ignore || [])) {
        foundNewer = true;
        break;
      }
    } else {
      // Skip log files / sync artifacts that may appear as managed files
      const base = entry.path.split(/[\\/]/).pop();
      if (SYNC_ARTIFACTS.has(base)) continue;
      if (entry.path.endsWith(".log")) continue;
      if (fileNewer(entry.path, lastSyncAt)) {
        foundNewer = true;
        break;
      }
    }
  }

  if (!foundNewer) {
    // No-op preserve. Keep lastSyncAt unchanged, clear any prior error.
    writeState(stateFile, { lastSyncAt, lastError: null });
    return;
  }

  // Resolve the library path. If we cannot, log and persist the error,
  // but do NOT advance lastSyncAt -- the next turn will retry.
  let resolved;
  try {
    resolved = await resolveLibraryPath({
      libraryRemote: manifest.library_remote,
      manifestPath,
      projectDir,
    });
  } catch (e) {
    log("Path resolution threw: " + e.message);
    writeState(stateFile, { lastSyncAt, lastError: e.message });
    return;
  }

  const libraryPath = resolved && resolved.path;
  if (!libraryPath) {
    const message = formatResolutionError(manifest.library_remote);
    log(message);
    writeState(stateFile, { lastSyncAt, lastError: message });
    return;
  }

  const syncScript = join(libraryPath, "sync.mjs");
  if (!existsSync(syncScript)) {
    const msg = "sync.mjs not found at: " + syncScript;
    log(msg);
    writeState(stateFile, { lastSyncAt, lastError: msg });
    return;
  }

  // Run the push synchronously. This is the only "expensive" branch and
  // only fires when there's actual work to do.
  log("Auto-pushing changes to library");
  try {
    const result = execSync(
      `node "${syncScript}" --push --project "${projectDir}" --yes`,
      {
        encoding: "utf-8",
        timeout: PUSH_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: projectDir,
      }
    );
    const lines = result.trim().split("\n").filter((l) => l.trim());
    log("Push complete: " + lines.slice(-3).join(" | "));
    writeState(stateFile, { lastSyncAt: Date.now(), lastError: null });
  } catch (err) {
    const message =
      (err && (err.stderr || err.message)) || "unknown push error";
    log("Push failed: " + String(message).split("\n").slice(0, 3).join(" | "));
    writeState(stateFile, { lastSyncAt, lastError: String(message) });
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    try {
      log("Unexpected error: " + (e && e.message ? e.message : String(e)));
    } catch {
      /* ignore */
    }
  } finally {
    // Always exit 0 -- never block Claude's turn end.
    process.exit(0);
  }
})();

// Silence unused-import linters (normalizePath is exported for future use).
void normalizePath;
