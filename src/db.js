const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  // Unexpected error on an idle client - log and let the process manager restart us
  console.error('Unexpected PostgreSQL pool error', err);
});

module.exports = pool;
