const { Pool } = require('pg');
require('dotenv').config();

// 1. Local database pool
const localPool = new Pool({
  connectionString: process.env.DATABASE_URL_LOCAL,
});

// 2. Cloud database pool (Supabase)
const cloudPool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_URL_CLOUD,
  ssl: {
    rejectUnauthorized: false // Required for secure Supabase connection
  }
});

// Log local connection
localPool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to LOCAL PostgreSQL database:', err.stack);
  } else {
    console.log('Connected to LOCAL PostgreSQL database.');
    release();
  }
});

// Log cloud connection
cloudPool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to CLOUD Supabase database:', err.stack);
  } else {
    console.log('Connected to CLOUD Supabase database.');
    release();
  }
});

module.exports = {
  query: (text, params) => localPool.query(text, params),
  localQuery: (text, params) => localPool.query(text, params),
  cloudQuery: (text, params) => cloudPool.query(text, params),
  
  syncQuery: async (text, params) => {
    try {
      const [localResult, cloudResult] = await Promise.all([
        localPool.query(text, params),
        cloudPool.query(text, params)
      ]);
      return { local: localResult, cloud: cloudResult };
    } catch (err) {
      console.error('Database synchronization error:', err);
      throw err;
    }
  }
};