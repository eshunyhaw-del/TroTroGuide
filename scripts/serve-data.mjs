// Tiny zero-dependency static file server for the data/ folder, so generated artifacts (e.g. the
// OSM treasure map) can be previewed in a browser.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const PORT = Number(process.argv[2]) || 5055;
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };

createServer((req, res) => {
  let path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path === '/') path = '/osm_treasure_map.html';
  const file = normalize(join(DATA, path));
  if (!file.startsWith(DATA) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + path);
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Serving ${DATA} at http://localhost:${PORT}/`));
