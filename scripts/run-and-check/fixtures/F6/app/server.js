const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('minio');

const bucket = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET;
const uploadDir = '/app/uploads';

function s3Client() {
  const endpoint = new URL(process.env.AWS_ENDPOINT_URL_S3 || 'https://s3.amazonaws.com');
  return new Client({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    useSSL: endpoint.protocol === 'https:',
    region: process.env.AWS_REGION,
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secretKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
}

async function save(name, body) {
  if (bucket) {
    await s3Client().putObject(bucket, name, body);
  } else {
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, name), body);
  }
}

http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200).end('ok');
    } else if (req.url === '/upload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        save(`upload-${Date.now()}.txt`, Buffer.concat(chunks))
          .then(() => res.writeHead(200).end('stored'))
          .catch((error) => {
            console.error(error.message);
            res.writeHead(500).end('upload failed');
          });
      });
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(Number(process.env.PORT || 8080), '0.0.0.0');
