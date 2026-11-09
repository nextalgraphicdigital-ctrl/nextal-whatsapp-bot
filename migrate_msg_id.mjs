import { query } from './config/db.js';
try {
  await query('ALTER TABLE whatsapp_inbound_buffer ADD COLUMN IF NOT EXISTS msg_id TEXT');
  console.log("columna msg_id OK");
  const upd = await query('UPDATE whatsapp_inbound_buffer SET msg_id = id::text WHERE msg_id IS NULL');
  console.log("rows updated:", upd.rowCount);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_buffer_msg_id ON whatsapp_inbound_buffer(msg_id) WHERE msg_id IS NOT NULL');
  console.log("UNIQUE index OK");
  const s = await query("SELECT column_name FROM information_schema.columns WHERE table_name='whatsapp_inbound_buffer' ORDER BY ordinal_position");
  console.log("cols:", s.rows.map(r => r.column_name).join(", "));
} catch(e) { console.error("Error:", e.message); }
process.exit(0);
