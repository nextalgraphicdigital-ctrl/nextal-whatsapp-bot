/**
 * config/supabase.js -> Conector nativo PostgreSQL vía TCP ('pg')
 * Reemplaza por completo el cliente HTTP de @supabase/supabase-js
 * para evitar bloqueos por API web y errores ENOTFOUND.
 */
import { pool, query } from './db.js';
import dotenv from 'dotenv';

dotenv.config();

// Exportar la instancia nativa del pool y el helper query
export { pool, query };

/**
 * Capa de compatibilidad opcional para servicios existentes
 */
export const supabase = {
  // Permite ejecutar queries SQL directas por TCP
  query,
  pool,
  
  // Wrapper para emular la llamada RPC
  async rpc(functionName) {
    try {
      const res = await query(`SELECT ${functionName}() AS result`);
      return { data: res.rows[0]?.result, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  // Wrapper simplificado para operaciones básicas en tablas
  from(tableName) {
    return {
      async select(columns = '*') {
        try {
          const res = await query(`SELECT ${columns} FROM ${tableName}`);
          return { data: res.rows, error: null };
        } catch (err) {
          return { data: null, error: err };
        }
      },
      async insert(data) {
        try {
          const keys = Object.keys(data);
          const values = Object.values(data);
          const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
          const quotedKeys = keys.map(k => `"${k}"`).join(', ');
          
          const res = await query(
            `INSERT INTO ${tableName} (${quotedKeys}) VALUES (${placeholders}) RETURNING *`,
            values
          );
          return { data: res.rows[0], error: null };
        } catch (err) {
          return { data: null, error: err };
        }
      }
    };
  }
};

export default supabase;
