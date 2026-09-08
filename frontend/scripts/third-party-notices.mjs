// Writes public/THIRD_PARTY_NOTICES.txt from the production dependency tree.
//
// The bundler strips licence comments from the code it emits, but the MIT,
// BSD and ISC licences of what we bundle all require their copyright and
// permission notices to travel with every copy. This runs as part of
// `npm run build`, so the file ships in dist/ next to the bundles it covers
// and Settings can link to it. Run it by hand with `node scripts/third-party-notices.mjs`.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Walk the production tree: each dependency's package.json, then its own
// dependencies, resolved the way Node would from that package.
const seen = new Map();
function visit(name, fromDir) {
  if (seen.has(name)) return;
  let pkgPath;
  try {
    pkgPath = createRequire(join(fromDir, 'package.json')).resolve(`${name}/package.json`);
  } catch {
    // Packages with an "exports" map that hides package.json: find the dir by walking node_modules.
    const candidate = join(fromDir, 'node_modules', name, 'package.json');
    pkgPath = existsSync(candidate) ? candidate : join(root, 'node_modules', name, 'package.json');
  }
  const dir = dirname(pkgPath);
  const meta = JSON.parse(readFileSync(pkgPath, 'utf8'));
  seen.set(name, { dir, meta });
  for (const dep of Object.keys(meta.dependencies ?? {})) visit(dep, dir);
}
for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, root);

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  return file ? readFileSync(join(dir, file), 'utf8').trim() : null;
}

function authorOf(meta) {
  const a = meta.author;
  if (!a) return null;
  return typeof a === 'string' ? a : [a.name, a.email && `<${a.email}>`].filter(Boolean).join(' ');
}

const entries = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
const lines = [];
lines.push(`Third-party notices for ${pkg.name} ${pkg.version}`);
lines.push('');
lines.push('The application bundle includes the following open-source packages. Each is');
lines.push('the work of its authors and is provided under its own licence, reproduced');
lines.push('below as its licence requires. They are not covered by this project\'s');
lines.push('Apache-2.0 licence.');
lines.push('');
lines.push('Loaded at runtime from public CDNs (not bundled; pinned and integrity-checked');
lines.push('in the embed pages): @google/model-viewer 3.5.0 (Apache-2.0) and A-Frame 1.5.0');
lines.push('(MIT). Their own licence files travel with those distributions.');
lines.push('');
for (const [name, { dir, meta }] of entries) {
  lines.push('='.repeat(78));
  lines.push(`${name} ${meta.version}`);
  lines.push(`License: ${typeof meta.license === 'string' ? meta.license : JSON.stringify(meta.license)}`);
  const author = authorOf(meta);
  if (author) lines.push(`Author: ${author}`);
  if (meta.homepage || meta.repository) {
    const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
    lines.push(`Source: ${meta.homepage ?? repo}`);
  }
  lines.push('');
  const text = licenseText(dir);
  if (text) {
    lines.push(text);
  } else {
    // A package that declares a licence but ships no text (robot3 does this):
    // reproduce the declaration and the copyright holder, which is what the
    // licence asks for, and say where the canonical text lives.
    lines.push(
      `Copyright (c) ${author ?? 'the ' + name + ' authors'}. Licensed under the ${meta.license} licence; ` +
        `the package ships no licence file, see https://spdx.org/licenses/${meta.license}.html for the terms.`,
    );
  }
  lines.push('');
}

const out = join(root, 'public', 'THIRD_PARTY_NOTICES.txt');
writeFileSync(out, lines.join('\n') + '\n');
console.log(`[notices] wrote ${out} (${entries.length} packages: ${entries.map(([n]) => n).join(', ')})`);
