'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const IGNORED_DIRS = new Set([
  'node_modules',
  'logs',
  '.git',
  '.test-artifacts',
  '.antigravitycli',
  '.cursor',
  'coverage',
]);

/**
 * Recursively find all JavaScript files in the given directory.
 * @param {string} dir - The directory path to search.
 * @returns {string[]} List of absolute paths to JavaScript files.
 */
function getJsFiles(dir) {
  let files = [];
  const list = fs.readdirSync(dir);
  for (const item of list) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!IGNORED_DIRS.has(item)) {
        files = files.concat(getJsFiles(fullPath));
      }
    } else if (stat.isFile() && item.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const rootDir = path.resolve(__dirname, '..');
const jsFiles = getJsFiles(rootDir);
let hasError = false;

console.log(`Starting syntax check on ${jsFiles.length} JavaScript files...`);

for (const file of jsFiles) {
  const relativePath = path.relative(rootDir, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    console.error(`Syntax check failed for: ${relativePath}`);
    console.error(err.stderr ? err.stderr.toString() : err.message);
    hasError = true;
  }
}

if (hasError) {
  console.error('Syntax validation failed.');
  process.exit(1);
} else {
  console.log('All JavaScript files passed syntax check successfully.');
}
