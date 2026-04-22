#!/usr/bin/env node
/**
 * LibraryHook - mtime scanner for manual edits (UserPromptSubmit)
 *
 * Runs on each user prompt. Scans all library-managed files for mtime
 * newer than the last sync timestamp. If any are found, writes to
 * pending-sync.json and spawns the same debounced worker used by
 * library-sync.mjs (PostToolUse). This catches edits made outside
 * Claude Code (IDE, terminal, etc).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectDir = resolve(__dirname, "..", "..", "..");

const SYNC_ARTIFACTS = new Set([
  "skill-rules.json",
  "agent-rules.json",
  "recommendation-log.json",
  "pending-sync.json",
  ".syncignore",
  ".DS_Store",
  "Thumbs.db",
]);

const IGNORE_DIRS = new Set(["logs", "node_modules"]);

function normalizePath(p) {
  return p.replace(/\\/g, "/").toLowerCase();
}

function getNewestMtime(dirPath, ignorePatterns) {
  let newest = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (SYNC_ARTIFACTS.has(entry.name)) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.endsWith(".log")) continue;
      if (
        ignorePatterns.some((p) => entry.name.toLowerCase() === p.toLowerCase())
      )
        continue;

      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = getNewestMtime(fullPath, ignorePatterns);
        if (sub > newest) newest = sub;
      } else {
        try {
          const mt = statSync(fullPath).mtimeMs;
          if (mt > newest) newest = mt;
        } catch (e) {
          /* skip unreadable */
        }
      }
    }
  } catch (e) {
    /* skip unreadable dirs */
  }
  return newest;
}

function main() {
  try {
    const input = readFileSync(0, "utf-8");
    const data = JSON.parse(input);
    if (!data.session_id) process.exit(0);

    // Read manifest (prefer new name, fall back to legacy)
    let manifestPath = join(projectDir, ".claude", "library.json");
    if (!existsSync(manifestPath)) {
      manifestPath = join(projectDir, ".claude", ".library-manifest.json");
    }
    if (!existsSync(manifestPath)) process.exit(0);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const syncedAt = new Date(manifest.synced_at).getTime();
    const managed = manifest.managed || {};
    const ignorePatterns = managed.ignore || {};

    // Check if there's already a pending sync in progress
    const stateFile = join(__dirname, "pending-sync.json");
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf-8"));
        if (state.timestamp > 0) {
          // A worker is already waiting, don't spawn another
          process.exit(0);
        }
      } catch (e) {
        /* corrupt state, continue */
      }
    }

    let changedFile = null;

    // Check directory-based items (skills, hooks, etc)
    const dirCategories = [
      {
        items: managed.skills || {},
        base: join(projectDir, ".claude", "skills"),
      },
      {
        items: managed.hooks || {},
        base: join(projectDir, ".claude", "hooks"),
      },
    ];

    for (const cat of dirCategories) {
      for (const name of Object.keys(cat.items)) {
        const dirPath = join(cat.base, name);
        if (!existsSync(dirPath)) continue;
        const ignore = ignorePatterns[name] || [];
        const newest = getNewestMtime(dirPath, ignore);
        if (newest > syncedAt) {
          changedFile = dirPath;
          break;
        }
      }
      if (changedFile) break;
    }

    // Check file-based items (agents, commands, rules)
    if (!changedFile) {
      const fileCategories = [
        {
          items: managed.agents || {},
          base: join(projectDir, ".claude", "agents"),
          ext: ".md",
        },
        {
          items: managed.commands || {},
          base: join(projectDir, ".claude", "commands"),
          ext: ".md",
        },
        {
          items: managed.rules || {},
          base: join(projectDir, ".claude", "rules"),
          ext: ".md",
        },
      ];

      for (const cat of fileCategories) {
        for (const name of Object.keys(cat.items)) {
          const filePath = join(cat.base, name + cat.ext);
          if (!existsSync(filePath)) continue;
          try {
            const mt = statSync(filePath).mtimeMs;
            if (mt > syncedAt) {
              changedFile = filePath;
              break;
            }
          } catch (e) {
            /* skip */
          }
        }
        if (changedFile) break;
      }
    }

    // Check top-level managed files
    if (!changedFile) {
      const topLevelFiles = [];
      if (managed["claude-md"])
        topLevelFiles.push(join(projectDir, "CLAUDE.md"));
      if (managed.settings)
        topLevelFiles.push(join(projectDir, ".claude", "settings.json"));
      if (managed.mcp) topLevelFiles.push(join(projectDir, ".mcp.json"));

      for (const [, deployPath] of Object.entries(managed.files || {})) {
        topLevelFiles.push(join(projectDir, deployPath));
      }

      for (const fp of topLevelFiles) {
        if (!existsSync(fp)) continue;
        try {
          const mt = statSync(fp).mtimeMs;
          if (mt > syncedAt) {
            changedFile = fp;
            break;
          }
        } catch (e) {
          /* skip */
        }
      }
    }

    if (!changedFile) process.exit(0);

    // Found a changed file -- trigger debounced push
    const timestamp = Date.now();
    writeFileSync(
      stateFile,
      JSON.stringify({
        timestamp,
        file: changedFile,
        libraryPath: manifest.library_path,
        projectDir,
      }),
      "utf-8",
    );

    const workerPath = join(__dirname, "library-sync-worker.mjs");
    const child = spawn("node", [workerPath, String(timestamp)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: projectDir,
    });
    child.unref();

    process.exit(0);
  } catch (err) {
    process.exit(0);
  }
}

main();
