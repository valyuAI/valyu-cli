import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = pkg.version;

const skillPath = './skills/valyu-cli/SKILL.md';
let content = readFileSync(skillPath, 'utf-8');

// Update version in frontmatter
content = content.replace(/version: "[^"]*"/, `version: "${version}"`);

writeFileSync(skillPath, content);
console.log(`Synced SKILL.md version to ${version}`);
