'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const IGNORED_DIRS = new Set([
  'node_modules',
  'logs',
  '.git',
  '.test-artifacts',
  '.antigravitycli',
  '.cursor',
  'coverage',
  'dist',
]);

/**
 * Recursively find all JavaScript and TypeScript files in the given directory.
 * @param {string} dir - The directory path to search.
 * @returns {string[]} List of absolute paths to files.
 */
function getFiles(dir: string): string[] {
  let files: string[] = [];
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!IGNORED_DIRS.has(item)) {
        files = files.concat(getFiles(fullPath));
      }
    } else if (stat.isFile() && (item.endsWith('.js') || item.endsWith('.ts'))) {
      files.push(fullPath);
    }
  }
  return files;
}

const rootDir = process.cwd();
const allFiles = getFiles(rootDir);
let hasError = false;

console.log(`Starting syntax/type check on ${allFiles.length} files...`);

// Check JS files with node --check
const jsFiles = allFiles.filter((f) => f.endsWith('.js'));
for (const file of jsFiles) {
  const relativePath = path.relative(rootDir, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err: unknown) {
    const execErr = err as { stderr?: Buffer; message: string };
    console.error(`Syntax check failed for JS: ${relativePath}`);
    console.error(execErr.stderr ? execErr.stderr.toString() : execErr.message);
    hasError = true;
  }
}

// Check TS files with tsc
console.log('Running tsc --noEmit for TypeScript validation...');
try {
  const tscEntrypoint = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tscEntrypoint, '--noEmit'], { stdio: 'inherit', cwd: rootDir });
} catch {
  console.error('TypeScript validation failed.');
  hasError = true;
}

if (hasError) {
  console.error('Validation failed.');
  process.exit(1);
} else {
  console.log('All files passed validation successfully.');
}
