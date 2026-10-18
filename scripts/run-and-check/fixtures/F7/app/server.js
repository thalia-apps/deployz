const http = require('node:http');

if (!process.env.APP_SECRET) {
  console.error('APP_SECRET is required');
  process.exit(1);
}

http
  .createServer((req, res) => {
    res.writeHead(req.url === '/healthz' ? 200 : 404).end();
  })
  .listen(Number(process.env.PORT || 8080), '0.0.0.0');
