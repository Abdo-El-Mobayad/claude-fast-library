#!/usr/bin/env node
/**
 * LibraryHook - Auto-sync library-managed files on edit (PostToolUse)
 *
 * Fires on Write/Edit. Checks if the edited file is library-managed
 * by reading .library-manifest.json. If managed, writes a timestamp
 * to pending-sync.json and spawns a detached worker that waits 180s
 * (debounce). If no further managed edits occur in that window, the
 * worker runs `sync.mjs --push --yes` to push changes to the library.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectDir = resolve(__dirname, '..', '..', '..');

const SYNC_ARTIFACTS = [
    'skill-rules.json',
    'agent-rules.json',
    'recommendation-log.json',
    'pending-sync.json',
    '.syncignore',
    '.DS_Store',
    'Thumbs.db'
];

function normalizePath(p) {
    return p.replace(/\\/g, '/').toLowerCase();
}

function main() {
    try {
        const input = readFileSync(0, 'utf-8');
        const data = JSON.parse(input);

        if (data.tool_name !== 'Write' && data.tool_name !== 'Edit') {
            process.exit(0);
        }

        const filePath = (data.tool_input || {}).file_path || '';
        if (!filePath) process.exit(0);

        const normalizedFile = normalizePath(filePath);
        const fileName = filePath.split(/[/\\]/).pop();

        // Skip sync artifacts and log files
        if (SYNC_ARTIFACTS.includes(fileName)) process.exit(0);
        if (normalizedFile.endsWith('.log')) process.exit(0);
        if (normalizedFile.includes('/logs/')) process.exit(0);

        // Read manifest
        const manifestPath = join(projectDir, '.claude', '.library-manifest.json');
        if (!existsSync(manifestPath)) process.exit(0);

        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const managed = manifest.managed || {};
        const ignorePatterns = managed.ignore || {};

        // Build set of managed paths
        const managedPaths = [];

        // Skills (directories)
        for (const name of Object.keys(managed.skills || {})) {
            managedPaths.push({
                path: normalizePath(join(projectDir, '.claude', 'skills', name)),
                ignore: ignorePatterns[name] || []
            });
        }

        // Agents (files)
        for (const name of Object.keys(managed.agents || {})) {
            managedPaths.push({
                path: normalizePath(join(projectDir, '.claude', 'agents', name + '.md')),
                ignore: []
            });
        }

        // Commands (files)
        for (const name of Object.keys(managed.commands || {})) {
            managedPaths.push({
                path: normalizePath(join(projectDir, '.claude', 'commands', name + '.md')),
                ignore: []
            });
        }

        // Hooks (directories)
        for (const name of Object.keys(managed.hooks || {})) {
            managedPaths.push({
                path: normalizePath(join(projectDir, '.claude', 'hooks', name)),
                ignore: ignorePatterns[name] || []
            });
        }

        // Rules (files)
        for (const name of Object.keys(managed.rules || {})) {
            managedPaths.push({
                path: normalizePath(join(projectDir, '.claude', 'rules', name + '.md')),
                ignore: []
            });
        }

        // Top-level managed files
        if (managed['claude-md']) {
            managedPaths.push({ path: normalizePath(join(projectDir, 'CLAUDE.md')), ignore: [] });
        }
        if (managed.settings) {
            managedPaths.push({ path: normalizePath(join(projectDir, '.claude', 'settings.json')), ignore: [] });
        }
        if (managed.mcp) {
            managedPaths.push({ path: normalizePath(join(projectDir, '.mcp.json')), ignore: [] });
        }

        // Custom files
        for (const [, deployPath] of Object.entries(managed.files || {})) {
            managedPaths.push({ path: normalizePath(join(projectDir, deployPath)), ignore: [] });
        }

        // Check if the edited file matches any managed path
        let isManaged = false;

        for (const entry of managedPaths) {
            const isExactMatch = normalizedFile === entry.path;
            const isInsideDir = normalizedFile.startsWith(entry.path + '/');

            if (isExactMatch || isInsideDir) {
                // Check ignore patterns for directory entries
                if (entry.ignore.length > 0 && isInsideDir) {
                    const relativePart = normalizedFile.slice(entry.path.length + 1);
                    const segments = relativePart.split('/');
                    const ignored = entry.ignore.some(pattern =>
                        segments.some(seg => seg === pattern.toLowerCase())
                    );
                    if (ignored) break;
                }
                isManaged = true;
                break;
            }
        }

        if (!isManaged) process.exit(0);

        // Write pending sync state
        const stateFile = join(__dirname, 'pending-sync.json');
        const timestamp = Date.now();
        writeFileSync(stateFile, JSON.stringify({
            timestamp,
            file: filePath,
            libraryPath: manifest.library_path,
            projectDir
        }), 'utf-8');

        // Spawn debounced worker (detached, survives session close)
        const workerPath = join(__dirname, 'library-sync-worker.mjs');
        const child = spawn('node', [workerPath, String(timestamp)], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            cwd: projectDir
        });
        child.unref();

        process.exit(0);
    } catch (err) {
        // Never break the workflow
        process.exit(0);
    }
}

main();
