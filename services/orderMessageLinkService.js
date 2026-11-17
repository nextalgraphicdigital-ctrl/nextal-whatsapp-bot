import { query } from '../config/db.js';

let schemaReady = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS whatsapp_order_message_links (
          message_id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          phone TEXT,
          kind TEXT NOT NULL DEFAULT 'proposal',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`ALTER TABLE whatsapp_inbound_buffer ADD COLUMN IF NOT EXISTS reply_to_msg_id TEXT`);
      await query(`CREATE INDEX IF NOT EXISTS idx_order_message_links_order ON whatsapp_order_message_links(order_id)`);
    })().catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

export async function rememberOrderMessage({ messageId, orderId, phone, kind = 'proposal' }) {
  if (!messageId || !orderId) return false;
  await ensureSchema();
  await query(
    `INSERT INTO whatsapp_order_message_links (message_id, order_id, phone, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO UPDATE SET order_id = EXCLUDED.order_id, phone = EXCLUDED.phone, kind = EXCLUDED.kind`,
    [messageId, orderId, phone || null, kind]
  );
  return true;
}

export async function findOrderForReply(messages, activeOrders = []) {
  const replyIds = [...new Set((messages || []).map(message => message?.reply_to_msg_id).filter(Boolean))];
  if (!replyIds.length) return null;
  await ensureSchema();
  const result = await query(
    `SELECT order_id FROM whatsapp_order_message_links WHERE message_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 1`,
    [replyIds]
  );
  const orderId = result.rows[0]?.order_id;
  return (activeOrders || []).find(order => order.id === orderId) || null;
}

export async function ensureOrderMessageSchema() {
  await ensureSchema();
}
