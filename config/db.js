import pkg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const { Pool } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// pg interpreta sslmode incluido en la URL y puede sobrescribir la opción ssl
// definida abajo. En Node reciente eso termina rechazando algunas cadenas de
// certificados de Neon aunque rejectUnauthorized esté configurado como false.
const databaseUrl = process.env.DATABASE_URL
  ?.replace(/([?&])sslmode=[^&]*&?/i, (_, separator) => (separator === '?' ? '?' : ''))
  ?.replace(/[?&]$/, '');

export const pool = new Pool({
  connectionString: databaseUrl,
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
