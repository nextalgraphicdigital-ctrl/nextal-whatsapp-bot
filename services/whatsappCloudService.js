import fs from 'fs';

const graphVersion = () => process.env.WHATSAPP_GRAPH_API_VERSION || 'v25.0';
const accessToken = () => String(process.env.WHATSAPP_CLOUD_TOKEN || '').trim();
const phoneNumberId = () => String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();

function requireCloudConfig() {
  if (!accessToken() || !phoneNumberId()) {
    throw new Error('Faltan WHATSAPP_CLOUD_TOKEN o WHATSAPP_PHONE_NUMBER_ID en el .env');
  }
}

function normalizePhone(value) {
  const phone = String(value || '').replace(/@.*$/, '').replace(/\D/g, '');
  if (!phone) throw new Error('No se recibió un número de WhatsApp válido');
  return phone;
}

async function graphRequest(path, options = {}) {
  requireCloudConfig();
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Meta Graph devolvió HTTP ${response.status}`);
  return data;
}

async function uploadLocalImage(filePath) {
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer]), 'imagen.jpg');
  const data = await graphRequest(`${phoneNumberId()}/media`, { method: 'POST', body: form });
  if (!data?.id) throw new Error('Meta no devolvió el identificador del archivo subido');
  return data.id;
}

/** Envía texto o imagen por la API oficial de WhatsApp Cloud. */
export async function sendWhatsappWithDelay(phoneOrOptions, textParam, mediaUrlParam = null) {
  let targetPhone = phoneOrOptions;
  let text = textParam;
  let mediaUrl = mediaUrlParam;
  if (typeof phoneOrOptions === 'object' && phoneOrOptions !== null) {
    targetPhone = phoneOrOptions.phone || phoneOrOptions.Telephone || phoneOrOptions.telephone || phoneOrOptions.to;
    text = phoneOrOptions.text || phoneOrOptions.message || textParam;
    mediaUrl = phoneOrOptions.mediaUrl || phoneOrOptions.imageUrl || mediaUrlParam;
  }

  try {
    const to = normalizePhone(targetPhone);
    let message;
    if (mediaUrl) {
      const image = typeof mediaUrl === 'string' && !mediaUrl.startsWith('http') && fs.existsSync(mediaUrl)
        ? { id: await uploadLocalImage(mediaUrl) }
        : { link: String(mediaUrl) };
      message = { messaging_product: 'whatsapp', to, type: 'image', image: { ...image, caption: String(text || '') } };
    } else {
      message = { messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text || '') } };
    }
    await graphRequest(`${phoneNumberId()}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
    console.log(`✅ [Cloud API] Mensaje enviado a ${to}`);
    return true;
  } catch (error) {
    console.error(`❌ [Cloud API] No se pudo enviar mensaje: ${error.message}`);
    return false;
  }
}

export const sendWhatsAppWithDelay = sendWhatsappWithDelay;
export { sendWhatsappWithDelay as sendWhatsApp };

export async function downloadCloudMedia(mediaId) {
  const metadata = await graphRequest(mediaId);
  if (!metadata?.url) throw new Error('Meta no devolvió URL para el archivo recibido');
  const response = await fetch(metadata.url, { headers: { Authorization: `Bearer ${accessToken()}` } });
  if (!response.ok) throw new Error(`No se pudo descargar el archivo de Meta (${response.status})`);
  const contentType = response.headers.get('content-type') || metadata.mime_type || 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { contentType, buffer };
}
