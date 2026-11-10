import { query } from '../config/db.js';
import { sendWhatsAppWithDelay } from './whatsappTransport.js';

let updateOffset = 0;
let pollTimer = null;
let reportTimer = null;
let lastReportDate = null;

const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const adminChatId = () => String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
const enabled = () => Boolean(token() && adminChatId());

async function telegram(method, payload = {}) {
  if (!enabled()) return null;
  const response = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} falló`);
  return data.result;
}

async function sendAdmin(text) {
  return telegram('sendMessage', { chat_id: adminChatId(), text, disable_web_page_preview: true });
}

async function ensureTelegramTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS bot_rules (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS bot_handoffs (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT,
      phone TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bot_human_control BOOLEAN NOT NULL DEFAULT false`);
}

export async function getActiveBotRulesContext() {
  try {
    const result = await query(
      `SELECT title, instruction FROM bot_rules WHERE active = true ORDER BY id DESC LIMIT 20`
    );
    if (!result.rows.length) return '';
    return result.rows.map(rule => `- ${rule.title}: ${rule.instruction}`).join('\n');
  } catch (error) {
    console.warn('⚠️ [Telegram] No se pudieron leer reglas:', error.message);
    return '';
  }
}

export async function requestHumanIntervention({ phone, orderId = null, summary }) {
  await ensureTelegramTables();
  const existing = await query(
    `SELECT id, attempts FROM bot_handoffs WHERE phone = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  const row = existing.rows[0];
  const attempts = (Number(row?.attempts) || 0) + 1;
  if (row) {
    await query(`UPDATE bot_handoffs SET attempts = $1, summary = $2 WHERE id = $3`, [attempts, summary, row.id]);
  } else {
    await query(`INSERT INTO bot_handoffs (order_id, phone, summary) VALUES ($1, $2, $3)`, [orderId, phone, summary]);
  }

  // Se escala después de dos intentos insuficientes: antes de eso la IA puede
  // pedir una aclaración y mantener una conversación natural con el cliente.
  if (attempts < 2) return { escalated: false, attempts };

  await sendWhatsAppWithDelay(
    phone,
    'Para darte una respuesta precisa, voy a escalar tu caso con nuestro equipo. Una persona te escribirá por este mismo chat en breve. ✅'
  );
  if (enabled()) {
    await sendAdmin(
      `🆘 *Intervención requerida*\nPedido: ${orderId || 'Sin pedido'}\nCliente: ${phone}\n\n${summary}\n\n` +
      `Usa /tomar ${orderId || '<PEDIDO>'} o /responder ${orderId || '<PEDIDO>'} | tu respuesta`
    );
  }
  return { escalated: true, attempts };
}

/** Avisa al administrador apenas entra una nueva solicitud para asignación. */
export async function notifyNewOrderBatch({ clientName, phone, items, total, invoiceId }) {
  if (!enabled()) return;
  const list = (items || []).map(item => `• ${item.id} — ${item.tipoDiseno} ($${Number(item.precio || 0).toLocaleString('es-CO')})`).join('\n');
  await sendAdmin(
    `🆕 *Nuevo pedido para gestionar*\n\n` +
    `👤 Cliente: *${clientName || 'Cliente WhatsApp'}*\n` +
    `📱 WhatsApp: ${phone}\n` +
    `📦 Diseños:\n${list}\n` +
    `💰 Total: *$${Number(total || 0).toLocaleString('es-CO')} COP*\n` +
    `${invoiceId ? `🧾 Solicitud: ${invoiceId}\n` : ''}\n` +
    `Siguiente paso: valida el abono y asigna el diseñador desde el panel de Nextal.`
  );
}

async function buildDailyReport() {
  const [inbound, orders, payments, pending, handoffs] = await Promise.all([
    query(`SELECT COUNT(*)::int AS messages, COUNT(DISTINCT phone)::int AS clients FROM whatsapp_inbound_buffer WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'`),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE estado = 'Entregado')::int AS delivered FROM orders WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'`),
    query(`SELECT COUNT(*)::int AS verified FROM orders WHERE comprobante_url IS NOT NULL AND updated_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'`),
    query(`SELECT COUNT(*)::int AS outstanding, COALESCE(SUM(saldo), 0)::numeric AS amount FROM orders WHERE estado NOT IN ('Entregado', 'Cancelado', 'Finalizado') AND COALESCE(saldo, 0) > 0`),
    query(`SELECT COUNT(*)::int AS open FROM bot_handoffs WHERE status = 'open'`)
  ]);
  const a = inbound.rows[0] || {};
  const b = orders.rows[0] || {};
  const c = payments.rows[0] || {};
  const d = pending.rows[0] || {};
  const e = handoffs.rows[0] || {};
  return `📊 *Informe diario Nextal Graphic*\n\n` +
    `💬 Clientes que escribieron: *${a.clients || 0}*\n` +
    `✉️ Mensajes recibidos: *${a.messages || 0}*\n` +
    `📦 Pedidos creados: *${b.total || 0}*\n` +
    `✅ Entregas completadas: *${b.delivered || 0}*\n` +
    `💳 Comprobantes verificados: *${c.verified || 0}*\n` +
    `⏳ Saldos pendientes: *${d.outstanding || 0}* por $${Number(d.amount || 0).toLocaleString('es-CO')} COP\n` +
    `🆘 Casos para intervención: *${e.open || 0}*\n\n` +
    `Comandos: /pendientes · /reglas · /ayuda`;
}

async function maybeSendDailyReport() {
  if (!enabled()) return;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((obj, item) => ({ ...obj, [item.type]: item.value }), {});
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.hour === '17' && parts.minute === '30' && lastReportDate !== today) {
    await sendAdmin(await buildDailyReport());
    lastReportDate = today;
  }
}

async function handleCommand(text) {
  const [rawCommand, ...rest] = String(text || '').trim().split(' ');
  const command = String(rawCommand || '').toLowerCase();
  const payload = rest.join(' ').trim();
  if (command === '/ayuda' || command === '/start') {
    return sendAdmin('🤖 *Control Nextal*\n\n/reglas — ver reglas activas\n/regla Título | instrucción — enseñar una regla\n/pendientes — ver casos humanos\n/tomar NG-0000 — pausar al bot para ese pedido\n/responder NG-0000 | mensaje — responder por WhatsApp\n/continuar NG-0000 — devolver el caso al bot');
  }
  if (command === '/reglas') {
    const rules = await getActiveBotRulesContext();
    return sendAdmin(rules ? `📚 *Reglas activas*\n${rules}` : '📚 Aún no hay reglas personalizadas. Usa /regla Título | instrucción');
  }
  if (command === '/regla') {
    const [title, instruction] = payload.split('|').map(value => value?.trim());
    if (!title || !instruction) return sendAdmin('Formato: /regla Nombre breve | Instrucción clara para el bot');
    await query(`INSERT INTO bot_rules (title, instruction) VALUES ($1, $2)`, [title, instruction]);
    return sendAdmin(`✅ Regla guardada: *${title}*\nLa IA la tendrá en cuenta en las próximas conversaciones.`);
  }
  if (command === '/pendientes') {
    const result = await query(`SELECT order_id, phone, summary FROM bot_handoffs WHERE status = 'open' ORDER BY created_at DESC LIMIT 10`);
    if (!result.rows.length) return sendAdmin('✅ No hay casos pendientes de intervención.');
    return sendAdmin(`🆘 *Casos pendientes*\n\n${result.rows.map(row => `• ${row.order_id || 'Sin pedido'} — ${row.phone}\n${row.summary}`).join('\n\n')}`);
  }
  const match = payload.match(/^(NG-\d+)\s*(?:\|\s*)?([\s\S]*)$/i);
  const orderId = match?.[1]?.toUpperCase();
  if (['/tomar', '/continuar'].includes(command) && !orderId) {
    return sendAdmin(`Formato: ${command} NG-0000`);
  }
  if (command === '/responder' && (!orderId || !match?.[2])) {
    return sendAdmin('Formato: /responder NG-0000 | tu mensaje para el cliente');
  }
  if (command === '/tomar' && orderId) {
    await query(`UPDATE orders SET bot_human_control = true, qc_status = 'atencion_humana', updated_at = NOW() WHERE id = $1`, [orderId]);
    await query(`UPDATE bot_handoffs SET status = 'taken' WHERE order_id = $1 AND status = 'open'`, [orderId]);
    return sendAdmin(`👤 Tomaste ${orderId}. El bot queda pausado para este pedido.\n\nReglas vigentes:\n${(await getActiveBotRulesContext()) || 'Sin reglas personalizadas.'}`);
  }
  if (command === '/continuar' && orderId) {
    await query(`UPDATE orders SET bot_human_control = false, qc_status = 'pendiente_diseno', updated_at = NOW() WHERE id = $1`, [orderId]);
    await query(`UPDATE bot_handoffs SET status = 'resolved', resolved_at = NOW() WHERE order_id = $1 AND status IN ('open', 'taken')`, [orderId]);
    return sendAdmin(`✅ ${orderId} vuelve a ser atendido por el bot.`);
  }
  if (command === '/responder' && orderId && match?.[2]) {
    const result = await query(`SELECT telefono, whatsapp_chat_id FROM orders WHERE id = $1 LIMIT 1`, [orderId]);
    const phone = result.rows[0]?.telefono || result.rows[0]?.whatsapp_chat_id;
    if (!phone) return sendAdmin(`No encontré un WhatsApp para ${orderId}.`);
    await sendWhatsAppWithDelay(phone, match[2]);
    await query(`UPDATE orders SET bot_human_control = true, qc_status = 'atencion_humana', updated_at = NOW() WHERE id = $1`, [orderId]);
    return sendAdmin(`📤 Respuesta enviada a ${orderId}. El caso seguirá en atención humana hasta /continuar.`);
  }
  return sendAdmin('No entendí el comando. Usa /ayuda para ver las opciones.');
}

async function pollTelegram() {
  try {
    const updates = await telegram('getUpdates', { offset: updateOffset, timeout: 0, allowed_updates: ['message'] });
    for (const update of updates || []) {
      updateOffset = update.update_id + 1;
      const message = update.message;
      if (!message || String(message.chat?.id) !== adminChatId()) continue;
      await handleCommand(message.text);
    }
  } catch (error) {
    console.warn('⚠️ [Telegram] Error consultando comandos:', error.message);
  }
}

export async function startTelegramControl() {
  if (!enabled()) {
    console.log('ℹ️ [Telegram] Integración pendiente: agrega TELEGRAM_BOT_TOKEN y TELEGRAM_ADMIN_CHAT_ID al .env.');
    return;
  }
  await ensureTelegramTables();
  await sendAdmin('✅ *Control Nextal conectado.* Usa /ayuda para ver los comandos.');
  pollTimer = setInterval(pollTelegram, 4000);
  reportTimer = setInterval(() => { maybeSendDailyReport().catch(error => console.warn('⚠️ [Telegram] Reporte diario:', error.message)); }, 30_000);
  await maybeSendDailyReport();
}

export function stopTelegramControl() {
  if (pollTimer) clearInterval(pollTimer);
  if (reportTimer) clearInterval(reportTimer);
  pollTimer = null;
  reportTimer = null;
}
