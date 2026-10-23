import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const platform = process.argv[2] || process.platform;
const requested = process.env.MOMO_ARCH;
const archs = requested ? requested.split(',') : platform === 'darwin' ? ['arm64', 'x64'] : [process.arch];
const staging = path.resolve('release/staging');
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
await fs.cp('dist', path.join(staging, 'dist'), { recursive: true });
const sourcePackage = JSON.parse(await fs.readFile('package.json', 'utf8'));
await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({
  name: sourcePackage.name, productName: 'Momo', version: sourcePackage.version,
  description: sourcePackage.description, author: sourcePackage.author,
  main: 'dist/main/main.cjs',
}, null, 2));
for (const arch of archs) {
  const paths = await packager({
    dir: staging, name: 'Momo', platform, arch,
    electronVersion: JSON.parse(await fs.readFile('node_modules/electron/package.json', 'utf8')).version,
    out: 'release', overwrite: true, asar: true, prune: false,
    download: { cacheRoot: path.resolve('release/.electron-cache') },
    icon: path.resolve('dist/main/assets/icon.icns'),
    appBundleId: 'com.bryang4toys.momo', appCategoryType: 'public.app-category.productivity',
    darwinDarkModeSupport: true, executableName: 'Momo',
  });
  for (const output of paths) {
    if (platform === 'darwin') {
      const zipPath = path.resolve('release', `Momo-macOS-${arch}.zip`);
      await fs.rm(zipPath, { force: true });
      const zip = spawnSync('zip', ['-qry', '-y', zipPath, 'Momo.app'], { cwd: output, stdio: 'inherit' });
      if (zip.status !== 0) throw new Error('Zip packaging failed; ensure zip is installed');
      console.log(`macOS application: ${zipPath}`);
    } else console.log(`Application: ${output}`);
  }
}
