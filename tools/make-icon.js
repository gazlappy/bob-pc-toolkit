// Renders the app icon and writes build/icon.ico.
//
// Electron is already a dependency, so the artwork is drawn as SVG in an
// offscreen window and captured, rather than pulling in an image toolchain.
// Run with:  npm run icon

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const SIZES = [256, 128, 64, 48, 32, 24, 16];
const OUT_DIR = path.join(__dirname, '..', 'build');

// A five-point star, points-up, as an SVG path.
function starPath(cx, cy, outerR, innerR, points = 5, rotDeg = -90) {
  let d = '';
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = ((rotDeg + (i * 180) / points) * Math.PI) / 180;
    d += (i === 0 ? 'M' : 'L') + (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
  }
  return d + 'Z';
}

// BOB — "Best Of the Best": a champion's gold star on the app's dark tile, with
// the wordmark beneath. The star carries the icon at 16px; the word reads at
// larger sizes.
const STAR = starPath(128, 100, 76, 32);

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#182134"/>
      <stop offset="1" stop-color="#0b0f17"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.34" r="0.62">
      <stop offset="0" stop-color="#3f6fda" stop-opacity="0.60"/>
      <stop offset="1" stop-color="#3f6fda" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe888"/>
      <stop offset="0.48" stop-color="#f7bd42"/>
      <stop offset="1" stop-color="#cd8618"/>
    </linearGradient>
    <linearGradient id="goldhi" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
  </defs>

  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#tile)"/>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#glow)"/>
  <rect x="8.5" y="8.5" width="239" height="239" rx="51.5" fill="none"
        stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>

  <!-- Champion star -->
  <path d="${STAR}" transform="translate(0,6)" fill="#000000" fill-opacity="0.35" filter="url(#soft)"/>
  <path d="${STAR}" fill="url(#gold)" stroke="#a96d10" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="${STAR}" fill="url(#goldhi)"/>

  <!-- Wordmark -->
  <text x="128" y="216" text-anchor="middle"
        font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="44" letter-spacing="5"
        fill="#ffdf85">BOB</text>
</svg>`;

// A minimal ICO container. Each entry holds a complete PNG, which Windows has
// accepted since Vista and keeps the writer simple.
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const at = index * 16;
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 0);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });

  const page = `<html><head><style>
    html,body{margin:0;padding:0;width:256px;height:256px;background:transparent;overflow:hidden}
    svg{display:block}
  </style></head><body>${SVG}</body></html>`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const captured = await win.webContents.capturePage();
  const master = captured.resize({ width: 256, height: 256, quality: 'best' });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), master.toPNG());

  const images = SIZES.map((size) => ({
    size,
    data: (size === 256 ? master : master.resize({ width: size, height: size, quality: 'best' })).toPNG(),
  }));

  const ico = buildIco(images);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`wrote build/icon.ico (${SIZES.join(', ')} px, ${ico.length} bytes)`);

  win.destroy();
  app.quit();
});
