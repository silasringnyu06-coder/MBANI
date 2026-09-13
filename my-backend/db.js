const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', (client) => {
  console.log(`Connected to PostgreSQL database: ${client.database}`);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};