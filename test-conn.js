import { pool } from './config/db.js';

async function test() {
  try {
    const client = await pool.connect();
    const res = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    console.log('TABLES:', res.rows.map(r => r.table_name));
    client.release();
    await pool.end();
  } catch (err) {
    console.error('❌ ERROR:', err.message);
    await pool.end();
  }
}

test();
