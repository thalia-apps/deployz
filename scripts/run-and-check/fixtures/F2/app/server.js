const http = require('node:http');
const pool = require('./db');

http
  .createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
    } else if (req.url === '/items') {
      try {
        const { rows } = await pool.query('SELECT id, name FROM items');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
      } catch (error) {
        console.error(error.message);
        res.writeHead(500).end('items table is missing: run the migration');
      }
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(Number(process.env.PORT || 8080), '0.0.0.0');

pool.query('SELECT 1').catch((error) => console.error(error.message));
