// One-off: downscale + recompress the 2x promo PNGs into web-ready WebP (small + crisp)
// using the already-installed Chromium (no ImageMagick/sharp here). Also emits one JPEG
// social card (og:image, 1200x630 cover-fit from the board hero).
//   node _optimize_promo.js
// Out: ../../../TL-DPS-ghpages/img/*.webp  +  og-card.jpg
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'shots', 'promo');
const OUT = path.resolve(__dirname, '..', '..', '..', 'TL-DPS-ghpages', 'img');
fs.mkdirSync(OUT, { recursive: true });

// name -> max display width (px) for the WebP
const JOBS = [
  ['hero-board', 1600], ['hero-skills', 1600], ['hero-rotation', 1600],
  ['hero-compare', 1600], ['hero-trophies', 1600],
  ['panel-board', 1200], ['panel-skills', 1200], ['panel-rotation', 1200],
  ['panel-compare', 1200], ['panel-trophies', 1200],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');

  for (const [name, maxW] of JOBS) {
    const b64 = fs.readFileSync(path.join(SRC, name + '.png')).toString('base64');
    const dataUrl = await page.evaluate(async ({ b64, maxW }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const c = document.getElementById('c'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/webp', 0.86);
    }, { b64, maxW });
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, name + '.webp'), buf);
    console.log(name + '.webp', (buf.length / 1024).toFixed(0) + 'KB', w_of(dataUrl));
  }

  // social card: 1200x630 cover-fit from the board hero, as JPEG (og:image-safe)
  const b64 = fs.readFileSync(path.join(SRC, 'hero-board.png')).toString('base64');
  const card = await page.evaluate(async ({ b64 }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const W = 1200, H = 630;
    const c = document.getElementById('c'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh); // top/center cover
    return c.toDataURL('image/jpeg', 0.9);
  }, { b64 });
  const cardBuf = Buffer.from(card.split(',')[1], 'base64');
  fs.writeFileSync(path.join(OUT, 'og-card.jpg'), cardBuf);
  console.log('og-card.jpg', (cardBuf.length / 1024).toFixed(0) + 'KB');

  await browser.close();
})();

function w_of() { return ''; } // (width logged inside eval scope is enough)
