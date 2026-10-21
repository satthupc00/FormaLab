// Turns release-notes.md into build/release-notes.md for electron-builder (it ends up in
// latest.yml, which is what the update dialog shows). Fails when the notes are not written for
// the version in package.json, so a release never ships with old or missing notes.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const text = fs.readFileSync(path.join(root, 'release-notes.md'), 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
const lines = text.split(/\r\n|\r|\n/);
const headingAt = lines.findIndex(l => l.trim());
const heading = (lines[headingAt] || '').trim().match(/^#\s*v?([\d.]+)\s*$/);

if (!heading || heading[1] !== version) {
  console.error(`release-notes.md phải bắt đầu bằng "# v${version}" (đang là: "${(lines[headingAt] || '').trim()}")`);
  process.exit(1);
}
const notes = lines.slice(headingAt + 1).join('\n').trim();
if (!notes) {
  console.error(`release-notes.md chưa có nội dung cho v${version}`);
  process.exit(1);
}
fs.writeFileSync(path.join(root, 'build', 'release-notes.md'), notes + '\n');
console.log(notes);
