import { build } from 'esbuild';
import { cp, mkdir, glob, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: { canvas: 'web/main.jsx' }, outdir: 'dist/assets',
  bundle: true, minify: true, splitting: true, format: 'esm', platform: 'browser', target: ['es2022'], conditions: ['production'],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  logLevel: 'info', legalComments: 'linked',
});
await copyFile(join(root, 'web/index.html'), join(dist, 'index.html'));
await writeFile(join(dist, 'config.js'), 'window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";\n');
await cp(join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'), join(dist, 'excalidraw-assets/fonts'), { recursive: true });
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(dist, 'THIRD_PARTY_NOTICES.md'));
await cp(join(root, 'vendor/font-licenses'), join(dist, 'licenses/fonts'), { recursive: true, filter: path => !path.endsWith('.sfd.txt') && !path.endsWith('-upstream.txt') });
for await (const path of glob(['node_modules/**/LICENSE*', 'node_modules/**/LICENCE*', 'node_modules/**/OFL*', 'node_modules/**/NOTICE*', 'node_modules/**/COPYING*'], { cwd: root })) {
  const target = join(dist, 'licenses', path.slice('node_modules/'.length));
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, path), target, { recursive: true });
}
