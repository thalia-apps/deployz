const { Pool } = require('pg');

const url = new URL(process.env.DATABASE_URL);
const useSsl = url.searchParams.get('sslmode') === 'require';
url.searchParams.delete('sslmode');

module.exports = new Pool({
  connectionString: url.toString(),
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});
