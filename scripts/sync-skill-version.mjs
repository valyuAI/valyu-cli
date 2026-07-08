import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = pkg.version;

const skillPath = './skills/valyu-cli/SKILL.md';
let content = readFileSync(skillPath, 'utf-8');

// Update version in frontmatter
content = content.replace(/version: "[^"]*"/, `version: "${version}"`);

writeFileSync(skillPath, content);
console.log(`Synced SKILL.md version to ${version}`);

// Keep the runtime version constant in lockstep with package.json - it is
// what `valyu --version` reports from pkg-compiled binaries.
const versionTsPath = './src/lib/version.ts';
const versionTs = readFileSync(versionTsPath, 'utf-8');
const updated = versionTs.replace(/VERSION = '[^']*'/, `VERSION = '${version}'`);

writeFileSync(versionTsPath, updated);
console.log(`Synced version.ts to ${version}`);
