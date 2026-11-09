import { query } from '../config/db.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

/**
 * Escucha los mensajes entrantes de WhatsApp de Baileys
 * e inserta inmediatamente cada fragmento en la tabla `whatsapp_inbound_buffer` mediante conexiÃ³n TCP nativa.
 * Si el mensaje incluye una imagen, descarga el buffer y lo almacena como Data URI en `media_url`.
 */
export async function handleInboundMessage(msg, sock) {
  try {
    if (!msg.message || msg.key.fromMe) return; // Ignorar mensajes enviados por el propio bot

    // Extraer msg_id Ãºnico de Baileys para deduplicaciÃ³n
    const msgId = msg.key?.id || '';

    const senderJid = msg.key?.remoteJid || msg.key?.participant || '';
    if (!senderJid) return;
    if (senderJid.includes('status@broadcast') || senderJid.includes('@g.us')) return; // Ignorar grupos o estados

    const remoteJid = senderJid;
    const phone = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
    const phoneNumber = senderJid; // Conservar el JID completo (ej: 118579785658460@lid o 573001234567@s.whatsapp.net)
    const Telephone = phone;
    const telephone = phone;

    // Desenvolver posibles capas de mensajes temporales (ephemeral), viewOnce o documentos
    let m = msg.message;
    if (m?.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m?.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m?.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m?.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    const messageContent = m?.conversation || 
                           m?.extendedTextMessage?.text || 
                           m?.imageMessage?.caption || 
                           m?.videoMessage?.caption ||
                           m?.documentMessage?.caption ||
                           '';

    let messageType = 'text';
    let mediaUrl = null;

    if (m?.imageMessage) {
      messageType = 'image';
      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { reuploadRequest: sock?.updateMediaMessage }
        );
        if (buffer) {
          const mimeType = m.imageMessage.mimetype || 'image/jpeg';
          mediaUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
          console.log(`🖼️ Imagen descargada para ${phoneNumber} (${buffer.length} bytes)`);
        }
      } catch (dlErr) {
        console.warn(`⚠️ No se pudo descargar el buffer de la imagen de ${phoneNumber}:`, dlErr.message);
      }
    } else if (m?.audioMessage) {
      messageType = 'audio';
      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { reuploadRequest: sock?.updateMediaMessage }
        );
        if (buffer) {
          const mimeType = m.audioMessage.mimetype || 'audio/ogg; codecs=opus';
          mediaUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
          console.log(`🎙️ Nota de voz / Audio descargado para ${phoneNumber} (${buffer.length} bytes)`);
        }
      } catch (dlErr) {
        console.warn(`⚠️ No se pudo descargar el buffer del audio de ${phoneNumber}:`, dlErr.message);
      }
    } else if (m?.documentMessage) {
      messageType = 'document';
      try {
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { reuploadRequest: sock?.updateMediaMessage }
        );
        if (buffer) {
          const mimeType = m.documentMessage.mimetype || 'application/octet-stream';
          mediaUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
          console.log(`📄 Documento descargado para ${phoneNumber} (${buffer.length} bytes)`);
        }
      } catch (dlErr) {
        console.warn(`⚠️ No se pudo descargar el buffer del documento de ${phoneNumber}:`, dlErr.message);
      }
    } else if (m?.videoMessage) {
      messageType = 'video';
    }

    console.log(`📦 Mensaje recibido de ${phoneNumber} [${messageType}]: "${(messageContent || '').slice(0, 50)}..."`);

    // Insertar mediante consulta SQL nativa en PostgreSQL (evita bloqueos HTTP de la API REST)
    // ON CONFLICT (msg_id) DO NOTHING garantiza que Baileys no duplique el mismo mensaje
    // aunque dispare messages.upsert mÃºltiples veces (reintentos Signal, reconexiones, historial)
    // Deduplicación via WHERE NOT EXISTS (compatible con índices parciales de PostgreSQL)
    const result = await query(
      `INSERT INTO whatsapp_inbound_buffer (phone_number, message_type, content, media_url, processed, msg_id, created_at)
       SELECT $1, $2, $3, $4, false, $5, NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM whatsapp_inbound_buffer WHERE msg_id = $5 AND msg_id IS NOT NULL
       )`,
      [phoneNumber, messageType, messageContent, mediaUrl, msgId]
    );

    console.log(`âœ… Mensaje de ${phoneNumber} [id: ${msgId}] insertado en buffer (o ignorado si duplicado).`);

  } catch (err) {
    console.error('âŒ Error en handleInboundMessage:', err.message);
  }
}

