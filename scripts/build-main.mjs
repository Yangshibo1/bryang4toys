import { build } from 'esbuild';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import png2icons from 'png2icons';

await fs.mkdir('dist/main/assets', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/preload/preload.ts'], outfile: 'dist/main/preload.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'] }),
]);
const iconBackground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#faf7ff"/><stop offset="1" stop-color="#e7def7"/></linearGradient></defs><rect x="12" y="12" width="1000" height="1000" rx="238" fill="url(#bg)"/><ellipse cx="512" cy="928" rx="280" ry="28" fill="#827199" opacity=".13"/></svg>`;
const character = await sharp('src/renderer/assets/gpt/idle.webp')
  .resize(760, 880, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();
const png = await sharp(Buffer.from(iconBackground)).resize(1024)
  .composite([{ input: character, left: 132, top: 88 }]).png().toBuffer();
await fs.writeFile('dist/main/assets/icon.png', png);
const icns = png2icons.createICNS(png, png2icons.BICUBIC, 0);
if (!icns) throw new Error('Could not create app icon');
await fs.writeFile('dist/main/assets/icon.icns', icns);
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M8 13Q1 9 6 1Q5 8 12 10L20 10Q27 8 26 1Q31 9 24 13Q30 19 25 26Q21 31 16 30Q11 31 7 26Q2 19 8 13Z" fill="black"/><path d="M5 18L1 15L4 23M27 18L31 15L28 23" fill="black"/><ellipse cx="11" cy="20" rx="2" ry="2.7" fill="white"/><ellipse cx="21" cy="20" rx="2" ry="2.7" fill="white"/><path d="M13 26Q16 28 19 26" stroke="white" stroke-width="1.6" fill="none"/></svg>`;
await sharp(Buffer.from(tray)).resize(36).png().toFile('dist/main/assets/trayTemplate.png');
await fs.copyFile('src/renderer/assets/gpt/LICENSE.md', 'dist/main/assets/CHARACTER-LICENSE.md');
await fs.copyFile('src/renderer/assets/gpt/CREDITS.md', 'dist/main/assets/CHARACTER-CREDITS.md');
console.log('Desktop main process, preload and icons built.');
