// Builds public/ from src/: bundles the runtime shim and voice module, wraps the app page.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('public', { recursive: true });
await build({ entryPoints: ['src/shim.js'], bundle: true, format: 'iife', minify: true, target: ['safari15'], outfile: 'public/shim.js' });
await build({ entryPoints: ['src/voice.js'], bundle: true, format: 'esm', minify: true, target: ['safari15'], outfile: 'public/voice.js' });

const appSrc = readFileSync('src/app.html', 'utf8');
// The app runs inside an IIFE, so the bridge must be placed inside it, just before boot().
const START = '\nboot();\n})();';
if (!appSrc.includes(START)) throw new Error('app start marker not found');
const bridge = readFileSync('src/bridge.js', 'utf8');
const app = appSrc.replace(START, '\n' + bridge + START);
const head = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#080B12">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Steadfast">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="icon" href="/icon-192.png">
<style>html,body{margin:0;background:#080B12;color:#fff}</style>
<script src="/shim.js"></script>
</head><body>`;
const tail = `<script type="module" src="/voice.js"></script>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});</script>
</body></html>`;
writeFileSync('public/index.html', head + app + tail);
console.log('built public/index.html', (head + app + tail).length, 'bytes');
