import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const platform = process.argv[2] || process.platform;
if (platform === 'darwin' && process.platform !== 'darwin') {
  throw new Error('Mac 安装包必须在 macOS 上构建并验签。请使用 Mac 或仓库的 Build macOS app 工作流。');
}
const requested = process.env.MIKA_ARCH || process.env.MOMO_ARCH;
const archs = requested ? requested.split(',') : platform === 'darwin' ? ['arm64', 'x64'] : [process.arch];
const staging = path.resolve('release/staging');
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
await fs.cp('dist', path.join(staging, 'dist'), { recursive: true });
const sourcePackage = JSON.parse(await fs.readFile('package.json', 'utf8'));
const signatureReport = [];
function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit status ${result.status}`);
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}
await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({
  name: sourcePackage.name, productName: 'Mika', version: sourcePackage.version,
  description: sourcePackage.description, author: sourcePackage.author,
  main: 'dist/main/main.cjs',
}, null, 2));
for (const arch of archs) {
  const paths = await packager({
    dir: staging, name: 'Mika', platform, arch,
    electronVersion: JSON.parse(await fs.readFile('node_modules/electron/package.json', 'utf8')).version,
    out: 'release', overwrite: true, asar: true, prune: false,
    download: { cacheRoot: path.resolve('release/.electron-cache') },
    icon: path.resolve('dist/main/assets/icon.icns'),
    appBundleId: 'com.bryang4toys.momo', appCategoryType: 'public.app-category.productivity',
    darwinDarkModeSupport: true, executableName: 'Mika',
    ...(platform === 'darwin' ? { osxSign: {
      identity: '-', identityValidation: false, continueOnError: false,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false, strictVerify: true,
      // Keep Electron's individual helper entitlements, including ARM JIT.
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
    } } : {}),
  });
  for (const output of paths) {
    if (platform === 'darwin') {
      const zipPath = path.resolve('release', `Mika-macOS-${arch}.zip`);
      const appPath = path.resolve(output, 'Mika.app');
      const before = checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
      await fs.rm(zipPath, { force: true });
      checked('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]);
      const extracted = path.resolve('release', `verify-${arch}`);
      await fs.rm(extracted, { recursive: true, force: true });
      await fs.mkdir(extracted, { recursive: true });
      checked('/usr/bin/ditto', ['-x', '-k', zipPath, extracted]);
      const after = checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path.join(extracted, 'Mika.app')]);
      signatureReport.push(`${arch} / Mika ${sourcePackage.version}\nBefore archive: ${before}\nAfter extraction: ${after}\n`);
      console.log(`macOS application: ${zipPath}`);
    } else console.log(`Application: ${output}`);
  }
}
if (platform === 'darwin') {
  await fs.writeFile('release/mika-signature-report.txt', [
    'Mika personal ad-hoc code-signature validation (not Apple notarization)',
    ...signatureReport,
  ].join('\n\n') + '\n');
}
