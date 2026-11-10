import { query } from '../config/db.js';
import { downloadCloudMedia } from '../services/whatsappCloudService.js';

const verifyToken = () => String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim();

export function verifyCloudWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken() && token === verifyToken()) return res.status(200).send(challenge);
  return res.sendStatus(403);
}

function messageContent(message) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'image') return message.image?.caption || '';
  if (message.type === 'document') return message.document?.caption || '';
  if (message.type === 'video') return message.video?.caption || '';
  return '';
}

async function mediaDataUri(message) {
  const media = message?.[message.type];
  if (!media?.id || !['image', 'audio', 'document'].includes(message.type)) return null;
  const { contentType, buffer } = await downloadCloudMedia(media.id);
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function storeInboundMessage(message) {
  const phone = String(message.from || '').replace(/\D/g, '');
  if (!phone || !message.id) return;
  const type = ['image', 'audio', 'document', 'video'].includes(message.type) ? message.type : 'text';
  let mediaUrl = null;
  try { mediaUrl = await mediaDataUri(message); } catch (error) { console.warn(`⚠️ [Cloud API] No se descargó el archivo entrante: ${error.message}`); }
  await query(
    `INSERT INTO whatsapp_inbound_buffer (phone_number, message_type, content, media_url, processed, msg_id, created_at)
     SELECT $1, $2, $3, $4, false, $5, NOW()
     WHERE NOT EXISTS (SELECT 1 FROM whatsapp_inbound_buffer WHERE msg_id = $5 AND msg_id IS NOT NULL)`,
    [phone, type, messageContent(message), mediaUrl, message.id]
  );
  console.log(`📩 [Cloud API] Mensaje entrante de ${phone} (${type}) guardado.`);
}

export async function receiveCloudWebhook(req, res) {
  res.sendStatus(200);
  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        for (const message of change.value?.messages || []) await storeInboundMessage(message);
      }
    }
  } catch (error) {
    console.error(`❌ [Cloud API] Error procesando webhook: ${error.message}`);
  }
}
