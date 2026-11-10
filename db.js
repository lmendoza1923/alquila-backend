const { Pool } = require('pg');

const isLocalDb = !process.env.DATABASE_URL || 
  process.env.DATABASE_URL.includes('localhost') || 
  process.env.DATABASE_URL.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.NODE_ENV === 'production' && !isLocalDb) ? { rejectUnauthorized: false } : false
});

module.exports = pool;
