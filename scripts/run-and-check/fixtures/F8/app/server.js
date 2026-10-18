const fs = require('node:fs');
const http = require('node:http');

async function openStore() {
  if (process.env.DATABASE_URL) {
    const pool = require('./db');
    await pool.query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
    return async () => (await pool.query('SELECT id, name FROM items')).rows;
  }
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync('/app/data', { recursive: true });
  const db = new DatabaseSync('/app/data/app.db');
  db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  return async () => db.prepare('SELECT id, name FROM items').all();
}

openStore()
  .then((listItems) => {
    http
      .createServer(async (req, res) => {
        if (req.url === '/healthz') {
          res.writeHead(200).end('ok');
        } else if (req.url === '/items') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await listItems()));
        } else {
          res.writeHead(404).end();
        }
      })
      .listen(Number(process.env.PORT || 8080), '0.0.0.0');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
