// Local preview of dist/. Start: node site/serve.mjs [distDir]   (PORT and HOST env; default 127.0.0.1:8781). Stop: Ctrl+C.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'dist'));
const port = Number(process.env.PORT || 8781);
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.dzi': 'application/xml',
  '.json': 'application/json',
  '.tif': 'image/tiff',
  '.txt': 'text/plain',
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const rel = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const file = path.join(root, rel);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
        'Cache-Control': rel.startsWith('tiles/') ? 'public, max-age=86400' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      await pipeline(fs.createReadStream(file), res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Error');
      } else res.destroy();
    }
  })
  .listen(port, host, () => console.log(`Site preview: http://${host}:${port}`));
