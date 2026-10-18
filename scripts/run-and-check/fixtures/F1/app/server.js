const http = require('node:http');
const pool = require('./db');

async function main() {
  await pool.query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
  http
    .createServer(async (req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200).end('ok');
      } else if (req.url === '/items') {
        const { rows } = await pool.query('SELECT id, name FROM items');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(Number(process.env.PORT || 8080), '0.0.0.0');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
