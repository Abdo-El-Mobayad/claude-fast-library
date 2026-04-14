#!/usr/bin/env node
/**
 * LibraryHook Worker - Debounced sync executor
 *
 * Spawned by library-sync.mjs with a timestamp argument.
 * Sleeps 180 seconds, then checks if the timestamp is still current.
 * If no newer edits occurred, runs sync.mjs --push --yes.
 * If a newer edit reset the timestamp, exits silently (the newer
 * worker will handle the push).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEBOUNCE_MS = 180_000; // 180 seconds

function log(message) {
    const logDir = join(__dirname, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'library-sync.log');
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    try {
        const existing = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
        const lines = existing.split('\n').slice(-500);
        writeFileSync(logFile, lines.join('\n') + logLine);
    } catch (err) {
        // fail silently
    }
}

async function main() {
    const myTimestamp = parseInt(process.argv[2], 10);
    if (!myTimestamp) process.exit(0);

    const stateFile = join(__dirname, 'pending-sync.json');

    // Wait for the debounce period
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS));

    try {
        if (!existsSync(stateFile)) {
            process.exit(0);
        }

        const state = JSON.parse(readFileSync(stateFile, 'utf-8'));

        // If timestamp changed, a newer worker is waiting
        if (state.timestamp !== myTimestamp) {
            process.exit(0);
        }

        const libraryPath = state.libraryPath;
        const projectDir = state.projectDir;

        if (!libraryPath || !existsSync(libraryPath)) {
            log('Library path not found: ' + libraryPath);
            process.exit(0);
        }

        const syncScript = join(libraryPath, 'sync.mjs');
        if (!existsSync(syncScript)) {
            log('sync.mjs not found at: ' + syncScript);
            process.exit(0);
        }

        log('Auto-pushing changes to library (last edit: ' + state.file + ')');

        const result = execSync(
            `node "${syncScript}" --push --project "${projectDir}" --yes`,
            {
                encoding: 'utf-8',
                timeout: 60000,
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: projectDir
            }
        );

        // Log the result summary (last 3 meaningful lines)
        const lines = result.trim().split('\n').filter(l => l.trim());
        log('Push complete: ' + lines.slice(-3).join(' | '));

        // Clear pending state
        writeFileSync(stateFile, JSON.stringify({
            timestamp: 0,
            file: null,
            libraryPath,
            projectDir
        }), 'utf-8');

    } catch (err) {
        log('Push failed: ' + (err.stderr || err.message));
    }

    process.exit(0);
}

main();
