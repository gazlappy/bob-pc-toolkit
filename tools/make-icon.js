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

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5c9bff"/>
      <stop offset="1" stop-color="#1f5fd6"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#plate)"/>
  <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#gloss)"/>
  <rect x="8.5" y="8.5" width="239" height="239" rx="51.5" fill="none"
        stroke="#ffffff" stroke-opacity="0.30" stroke-width="1.5"/>

  <!-- Four-point sparkles: crisp enough to survive a 16px taskbar icon. -->
  <g fill="#ffffff">
    <path d="M150 44
             C154 88 168 102 212 106
             C168 110 154 124 150 168
             C146 124 132 110 88 106
             C132 102 146 88 150 44 Z"/>
    <path d="M84 128
             C86 154 94 162 120 164
             C94 166 86 174 84 200
             C82 174 74 166 48 164
             C74 162 82 154 84 128 Z"
          fill-opacity="0.92"/>
    <path d="M186 172
             C187 188 192 193 208 194
             C192 195 187 200 186 216
             C185 200 180 195 164 194
             C180 193 185 188 186 172 Z"
          fill-opacity="0.78"/>
  </g>
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
