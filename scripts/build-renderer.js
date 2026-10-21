// Bundles src/ (three.js + app code) into renderer/app.js and copies the decoder libraries the
// glTF loader needs (Draco, Basis/KTX2) into renderer/libs. Run by `npm start` and the release build.
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    const src = path.join(from, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(to, f));
  }
}

const jsm = path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs');
copyDir(path.join(jsm, 'draco', 'gltf'), path.join(root, 'renderer', 'libs', 'draco'));
copyDir(path.join(jsm, 'basis'), path.join(root, 'renderer', 'libs', 'basis'));

const options = {
  entryPoints: [path.join(root, 'src', 'app.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outfile: path.join(root, 'renderer', 'app.js'),
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

if (watch) esbuild.context(options).then(ctx => ctx.watch());
else esbuild.build(options).catch(() => process.exit(1));
