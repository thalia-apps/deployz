const http = require('node:http');

http
  .createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
    } else if (req.url === '/items') {
      try {
        const pool = require('./db');
        const { rows } = await pool.query('SELECT generate_series(1, 3) AS id');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
      } catch (error) {
        console.error(error.message);
        res.writeHead(500).end('database unavailable');
      }
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(Number(process.env.PORT || 8080), '0.0.0.0');
