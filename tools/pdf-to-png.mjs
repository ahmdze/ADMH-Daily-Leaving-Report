/* Rasterise a PDF to PNG using pdf.js (loaded from a CDN) inside headless
   Edge, served over a throwaway local HTTP server so file:// fetch works.
   Diagnostic tool only — the app itself stays fully offline. */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, '_screenshots');

const files = process.argv.slice(2).map(f => path.resolve(f));
if (!files.length) { console.log('usage: node tools/pdf-to-png.mjs <file.pdf> [...]'); process.exit(2); }
for (const f of files) if (!fs.existsSync(f)) { console.log('missing: ' + f); process.exit(2); }

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#333} .pg{background:#fff;margin:12px auto;display:block}
</style></head><body>
<div id="host"></div>
<script src="${CDN}pdf.min.js"></script>
<script>
window.__ready = false; window.__pages = 0; window.__err = '';
(async () => {
  try {
    const pdf = await pdfjsLib.getDocument({ url: '/file.pdf' }).promise;
    const host = document.getElementById('host');
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1.6 });
      const c = document.createElement('canvas');
      c.className = 'pg'; c.width = vp.width; c.height = vp.height;
      c.setAttribute('data-page', i);
      host.appendChild(c);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      window.__pages = i;
    }
    window.__ready = true;
  } catch (e) { window.__err = String(e && e.message || e); }
})();
</script></body></html>`;

let current = files[0];
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/index')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
    } else if (req.url.startsWith('/file.pdf')) {
        const buf = fs.readFileSync(current);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
        res.end(buf);
    } else { res.writeHead(404); res.end('no'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log('local server on ' + port);

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 1500, deviceScaleFactor: 2 });

for (const f of files) {
    current = f;
    const base = path.basename(f, '.pdf');
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
    try {
        await page.waitForFunction('window.__ready === true || window.__err !== ""', { timeout: 60000 });
    } catch (e) { console.log('  (timeout waiting for render)'); }
    const state = await page.evaluate(() => ({ ready: window.__ready, pages: window.__pages, err: window.__err }));
    if (state.err) { console.log('pdf.js error: ' + state.err); continue; }
    console.log(base + ': rendered ' + state.pages + ' page(s)');
    const canvases = await page.$$('canvas.pg');
    for (let i = 0; i < canvases.length; i++) {
        const out = path.join(OUT, 'user-' + base + '-p' + (i + 1) + '.png');
        await canvases[i].screenshot({ path: out });
        console.log('   -> ' + path.basename(out));
    }
}

await browser.close();
server.close();
