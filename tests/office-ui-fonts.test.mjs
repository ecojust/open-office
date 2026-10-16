import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path));

test('shared interface fonts and required notices match their pinned, licensed asset manifests', () => {
  for (const directory of ['assets/fonts/ui', 'assets/fonts/deck']) {
    const manifest = JSON.parse(read(`${directory}/manifest.json`));
    for (const entry of manifest.files) {
      const bytes = read(`${directory}/${entry.file}`);
      assert.equal(bytes.length, entry.bytes, entry.file);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.file);
    }
  }
  const manifest = JSON.parse(read('assets/fonts/ui/manifest.json'));
  assert.equal(manifest.license, 'Apache-2.0');
  assert.match(read('assets/fonts/ui/LICENSE-Apache-2.0.txt').toString(), /Apache License/);
});

test('web and Rust interfaces consume the same three font files', () => {
  const css = read('src/style.css').toString();
  const rust = read('src/shared/office-ui-fonts.rs').toString();
  const webFiles = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].flatMap(([, block]) =>
    [...block.matchAll(/url\("([^"]+)"\)/g)].map(([, path]) => resolve(root, 'src', path)));
  const rustFiles = [...rust.matchAll(/include_bytes!\("([^"]+)"\)/g)]
    .map(([, path]) => resolve(root, 'src/shared', path));
  assert.equal(webFiles.length, 3);
  assert.deepEqual(webFiles.sort(), rustFiles.sort());
});

test('the shared Chinese interface face covers the Chinese labels of all workspaces', () => {
  const bytes = read('assets/fonts/ui/WenQuanYiMicroHei-Regular.ttf');
  // Read the font's actual Unicode format-12 cmap, independently of CSS and egui registration.
  const tableCount = bytes.readUInt16BE(4);
  let cmap;
  for (let i = 0; i < tableCount; i++) {
    const at = 12 + i * 16;
    if (bytes.toString('ascii', at, at + 4) === 'cmap') cmap = bytes.readUInt32BE(at + 8);
  }
  assert.ok(cmap !== undefined, 'font contains a character map');
  let unicode;
  for (let i = 0; i < bytes.readUInt16BE(cmap + 2); i++) {
    const at = cmap + 4 + i * 8;
    const offset = cmap + bytes.readUInt32BE(at + 4);
    if (bytes.readUInt16BE(offset) === 12) unicode = offset;
  }
  assert.ok(unicode !== undefined, 'font contains a full Unicode character map');
  const groups = [];
  for (let i = 0; i < bytes.readUInt32BE(unicode + 12); i++) {
    const at = unicode + 16 + i * 12;
    groups.push([bytes.readUInt32BE(at), bytes.readUInt32BE(at + 4), bytes.readUInt32BE(at + 8)]);
  }
  const sources = ['src/App.vue', 'src/components/NotebookEditor.vue'];
  function collect(directory) {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (/\.(?:rs|tsv)$/.test(path) && !path.includes('zh-hant')) sources.push(path);
    }
  }
  for (const kind of ['word', 'sheet', 'presentation', 'pdf']) {
    collect(`vendor/office-${kind}/crates/ui-egui/src/i18n`);
  }
  const characters = new Set(sources.flatMap(path => read(path).toString().match(/[\u3400-\u9fff]/g) || []));
  const missing = [...characters].filter(character => {
    const code = character.codePointAt(0);
    return !groups.some(([start, end, firstGlyph]) => code >= start && code <= end && firstGlyph + code - start !== 0);
  });
  assert.ok(characters.size > 1000, 'coverage includes all editor translation catalogs');
  assert.deepEqual(missing, [], 'no Chinese interface label may silently use a different fallback face');
});
