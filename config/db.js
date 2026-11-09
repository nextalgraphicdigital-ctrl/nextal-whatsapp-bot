import pkg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const { Pool } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ ERROR PostgreSQL (Neon):', err.message);
  } else {
    console.log('✅ Conexión exitosa con Neon PostgreSQL');
    release();
  }
});

export async function query(text, params) {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (error) {
    console.error('❌ Error SQL:', error.message);
    throw error;
  }
}

export default pool;
