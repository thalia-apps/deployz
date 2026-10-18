const pool = require('./db');

pool
  .query('CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)')
  .then(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
