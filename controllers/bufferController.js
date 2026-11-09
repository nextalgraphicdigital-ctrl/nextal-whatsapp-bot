import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/db.js';
import { transcribeAudio } from '../services/whisperService.js';
import { extractOrderDetails, validatePaymentReceipt, detectFeedbackOrAdjustment, assignDesignAssetsToProducts } from '../services/geminiService.js';
import { createOrderFolder, getFolderIdFromUrl, uploadBase64ToFolder, getFinalDeliverables } from '../services/driveService.js';
import { sendWhatsAppWithDelay } from '../services/baileysService.js';
import { getActiveBotRulesContext, notifyNewOrderBatch } from '../services/telegramControlService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const POLICY_IMAGE_PATH = path.join(__dirname, '../assets/politicas-servicio.jpg');

// Ventana de silencio para debouncing (10 segundos de inactividad agrupan ráfagas de mensajes)
const DEBOUNCE_SECONDS = 10;
const FREE_CLIENT_CHANGES = 3;
const EXTRA_CHANGE_PRICE = 2000;
let financialColumnsReady = null;

/** Campos separados para conservar el valor original y sumar ajustes sin ambigüedad. */
async function ensureFinancialColumns() {
  if (!financialColumnsReady) {
    financialColumnsReady = query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS valor_base NUMERIC,
        ADD COLUMN IF NOT EXISTS costo_cambios NUMERIC NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cambios_cliente INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS entrega_enviada_at TIMESTAMPTZ
    `).catch(error => {
      financialColumnsReady = null;
      throw error;
    });
  }
  return financialColumnsReady;
}

function getOrderDescription(order) {
  const notes = String(order?.notes || '').trim();
  const match = notes.match(/(?:📝\s*Notas:|descripci[oó]n:)\s*([\s\S]*?)(?:\n📁|$)/i);
  return (match?.[1] || notes || 'Sin especificaciones adicionales').trim();
}

/** Envía el mismo paquete comercial para pedidos nuevos y pedidos pendientes. */
async function sendPendingOrderPackage(phone, order) {
  const total = Number(order?.valor || 0);
  const totalStr = total.toLocaleString('es-CO');
  const abonoStr = Math.round(total / 2).toLocaleString('es-CO');
  const description = getOrderDescription(order);

  if (fs.existsSync(POLICY_IMAGE_PATH)) {
    const policyCopy = '📢 *¡Gracias por elegirnos!* Antes de iniciar tu pedido, aquí están nuestras políticas de servicio:';
    await sendWhatsAppWithDelay(phone, policyCopy, POLICY_IMAGE_PATH);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  const confirmationMsg =
    `📋 *NEXTAL GRAPHIC - Desglose Formal del Pedido*\n\n` +
    `📦 *Pedido Registrado:* ${order.id}\n\n` +
    `📝 *Detalle de Productos:*\n` +
    `• *[${order.id}]:* ${order.tipoDiseno || 'Diseño Gráfico'}\n` +
    `  ↳ *Valor Diseño:* $${totalStr} COP\n` +
    `  ↳ *Descripción:* ${description}\n\n` +
    `💰 *Valor Total Diseño:* $${totalStr} COP\n` +
    `💵 *Abono Inicial Requerido (50%):* $${abonoStr} COP\n\n` +
    `🏦 *Cuentas oficiales para transferencia:*\n` +
    `• *Bancolombia Ahorros:* 05993698379\n` +
    `• *Nequi / Daviplata:* 3234315008\n\n` +
    `📸 Recibimos tu imagen/referencia. Para activar la producción, envíanos por aquí la foto del comprobante de transferencia. ✅`;

  await sendWhatsAppWithDelay(phone, confirmationMsg);
}

/**
 * Guarda exclusivamente insumos creativos ya clasificados como no-comprobante.
 * Cada carga se espera: nunca se marca un archivo como enviado si Drive falló.
 */
async function uploadDesignAssetsForOrder(order, assets) {
  const designAssets = (assets || []).filter(asset =>
    ['image', 'document'].includes(asset.message_type) &&
    typeof asset.media_url === 'string' && asset.media_url.startsWith('data:')
  );
  if (!designAssets.length) return [];

  let folderId = getFolderIdFromUrl(order.drive_url) || order.driveFolderId;
  let driveUrl = order.drive_url || order.driveFolderUrl || '';
  if (!folderId) {
    driveUrl = await createOrderFolder(`[${order.id}] - ${order.tipoDiseno || 'Diseño'} - ${order.cliente || 'Cliente'}`);
    folderId = getFolderIdFromUrl(driveUrl);
  }
  if (!folderId) throw new Error(`No se pudo obtener una carpeta válida de Drive para ${order.id}`);

  const uploaded = [];
  for (const [index, asset] of designAssets.entries()) {
    const mime = asset.media_url.match(/^data:([^;]+);base64,/i)?.[1] || '';
    const extension = mime.includes('png') ? 'png' : mime.includes('pdf') ? 'pdf' : mime.includes('webp') ? 'webp' : 'jpg';
    const fileName = `${order.id}_insumo_${Date.now()}_${index + 1}.${extension}`;
    const storageUrl = await uploadBase64ToSupabaseStorage(order.id, fileName, asset.media_url);
    const driveFileUrl = await uploadBase64ToFolder(folderId, fileName, asset.media_url);

    if (!driveFileUrl) throw new Error(`Drive no confirmó la carga de ${fileName}`);
    uploaded.push({ name: fileName, url: storageUrl || driveFileUrl });
  }

  await query(
    `UPDATE orders SET drive_url = COALESCE(NULLIF($1, ''), drive_url),
       "driveFolderId" = $2, "driveFolderUrl" = COALESCE(NULLIF($1, ''), "driveFolderUrl"),
       "archivosEnviados" = true, updated_at = NOW() WHERE id = $3`,
    [driveUrl || `https://drive.google.com/drive/folders/${folderId}`, folderId, order.id]
  );
  console.log(`📁 [DISEÑO] ${uploaded.length} insumo(s) creativo(s) confirmados en Drive para ${order.id}.`);
  return uploaded;
}

/** Mantiene el panel web al día con la respuesta que llegó por WhatsApp. */
async function syncClientReviewStatus(orderId, payload) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://ygpfvmevizoetnvsxsqu.supabase.co';
    const supabaseKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_f3fibrFoyyjwmAQ1rX1X-Q_UVS3nQtm';
    const response = await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) console.warn(`⚠️ [REVISIÓN] No se pudo reflejar ${orderId} en el panel: ${await response.text()}`);
  } catch (error) {
    console.warn(`⚠️ [REVISIÓN] Error sincronizando respuesta de cliente: ${error.message}`);
  }
}

/**
 * Entrega el enlace privado/específico de Drive únicamente cuando el cliente
 * aprobó, el total (diseño + cambios) está pagado y existen PDF + editable.
 */
export async function deliverFinalFilesIfReady({ orderId, phone }) {
  await ensureFinancialColumns();
  const result = await query(
    `SELECT id, "tipoDiseno", valor, abono, saldo, drive_url, "driveFolderId", "driveFolderUrl",
            "pagoCliente", qc_status, client_review_status, entrega_enviada_at
       FROM orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  const order = result.rows[0];
  if (!order || order.client_review_status !== 'approved') return { delivered: false, reason: 'not-approved' };
  if (order.entrega_enviada_at) return { delivered: false, reason: 'already-delivered' };

  const total = Number(order.valor) || 0;
  const paid = Number(order.abono) || 0;
  const balance = Math.max(0, total - paid);
  if (balance > 0) {
    await query(
      `UPDATE orders SET saldo = $1, estado = 'Pendiente pago final', qc_status = 'pendiente_pago_final', updated_at = NOW() WHERE id = $2`,
      [balance, orderId]
    );
    await syncOrderToSupabase(orderId);
    await sendWhatsAppWithDelay(
      phone,
      `🎉 *Aprobación registrada para tu pedido ${orderId}.*\n\n` +
      `Para liberar los archivos finales (PDF y editable), queda un saldo de *$${balance.toLocaleString('es-CO')} COP*.\n\n` +
      `🏦 Bancolombia Ahorros: *05993698379*\n` +
      `📱 Nequi / Daviplata: *3234315008*\n\n` +
      `Cuando realices el pago, envíanos por este chat el comprobante. Lo validaremos y te compartiremos inmediatamente la carpeta final de tu pedido. ✅`
    );
    return { delivered: false, reason: 'pending-payment', balance };
  }

  const folderId = order.driveFolderId || getFolderIdFromUrl(order.drive_url) || getFolderIdFromUrl(order.driveFolderUrl);
  const driveUrl = order.driveFolderUrl || order.drive_url || (folderId ? `https://drive.google.com/drive/folders/${folderId}` : null);
  let deliveryFolderId = folderId;
  let deliveryDriveUrl = driveUrl;
  // La carpeta se entrega siempre. Si por alguna razón todavía no existe, se
  // crea antes de responder para que el cliente tenga un único enlace estable.
  if (!deliveryDriveUrl) {
    deliveryDriveUrl = await createOrderFolder(`[${orderId}] - Entrega - ${order.tipoDiseno || 'Diseño'}`);
    deliveryFolderId = getFolderIdFromUrl(deliveryDriveUrl);
    await query(
      `UPDATE orders SET drive_url = $1, "driveFolderUrl" = $1, "driveFolderId" = $2, updated_at = NOW() WHERE id = $3`,
      [deliveryDriveUrl, deliveryFolderId || null, orderId]
    );
  }

  const deliverables = await getFinalDeliverables(deliveryFolderId);
  if (!deliverables.pdf.length || !deliverables.editable.length) {
    await query(
      `UPDATE orders SET estado = 'Aprobado - preparando archivos', qc_status = 'preparando_entrega', saldo = 0, updated_at = NOW() WHERE id = $1`,
      [orderId]
    );
    await syncOrderToSupabase(orderId);
    await sendWhatsAppWithDelay(
      phone,
      `🎉 *Aprobación registrada para tu pedido ${orderId}.*\n\n` +
      `📂 *Tu carpeta de entrega ya está disponible:*\n${deliveryDriveUrl}\n\n` +
      `El diseñador está terminando de subir el PDF final y el archivo editable. Espera unos minutos y actualiza este mismo enlace; los archivos aparecerán allí. ✅`
    );
    await sendWhatsAppWithDelay(
      phone,
      `✨ *Gracias por elegir Nextal Graphic.*\n\n` +
      `Para tu próximo diseño puedes crear tu cuenta, enviar referencias y consultar el estado de cada pedido desde un solo lugar:\n` +
      `👉 https://nextal-graphic-interno-2.vercel.app/clientes#\n\n` +
      `Será un gusto acompañarte en tu próxima idea. 💙`
    );
    return { delivered: false, reason: 'files-not-ready' };
  }

  const sent = await sendWhatsAppWithDelay(
    phone,
    `📦 *¡Tus archivos finales están listos!*\n\n` +
    `Pedido: *${orderId}*\n` +
    `Incluye el PDF final y el archivo editable.\n\n` +
    `🔗 *Carpeta de entrega:*\n${deliveryDriveUrl}`
  );
  if (!sent) throw new Error(`No fue posible entregar los archivos de ${orderId} por WhatsApp`);

  await sendWhatsAppWithDelay(
    phone,
    `✨ *Gracias por elegir Nextal Graphic.*\n\n` +
    `Para tu próximo diseño puedes crear tu cuenta, enviar referencias y consultar el estado de cada pedido desde un solo lugar:\n` +
    `👉 https://nextal-graphic-interno-2.vercel.app/clientes#\n\n` +
    `Será un gusto acompañarte en tu próxima idea. 💙`
  );

  await query(
    `UPDATE orders SET estado = 'Entregado', qc_status = 'entregado', saldo = 0, "pagoCliente" = 'Pagado', entrega_enviada_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [orderId]
  );
  await syncOrderToSupabase(orderId);
  return { delivered: true, driveUrl: deliveryDriveUrl };
}

// Semáforo para evitar colisiones de ejecución concurrente entre intervalos
let isProcessing = false;

/**
 * Cron/Debounce Engine: Evalúa el buffer de mensajes entrantes de WhatsApp.
 * Ejecuta de forma asíncrona y no bloqueante para el event loop de Node.js.
 */
export async function processInboundBuffers() {
  if (isProcessing) {
    return;
  }
  isProcessing = true;

  try {
    // 1. Consultar mensajes no procesados de la tabla whatsapp_inbound_buffer
    const res = await query(
      `SELECT * FROM whatsapp_inbound_buffer WHERE processed = false ORDER BY created_at ASC`
    );

    const unprocessing = res.rows;
    if (!unprocessing || unprocessing.length === 0) {
      return;
    }

    // 2. Agrupar por identificador telefónico / JID
    const groupedByPhone = unprocessing.reduce((acc, msg) => {
      const phoneKey = (msg.phone_number || '').trim();
      if (!phoneKey) return acc;
      acc[phoneKey] = acc[phoneKey] || [];
      acc[phoneKey].push(msg);
      return acc;
    }, {});

    const now = new Date();

    // 3. Procesar secuencialmente por cliente con ventana de debounce
    for (const [phone, messages] of Object.entries(groupedByPhone)) {
      const lastMessageTime = new Date(messages[messages.length - 1].created_at);
      const diffInSeconds = (now - lastMessageTime) / 1000;

      // Si han transcurrido los segundos de silencio necesarios, procesamos el bloque de mensajes
      if (diffInSeconds >= DEBOUNCE_SECONDS) {
        console.log(`⏱️ [BUFFER] Ventana de silencio (${DEBOUNCE_SECONDS}s) cumplida para ${phone}. Procesando ${messages.length} mensaje(s)...`);
        await handleCustomerBuffer(phone, messages);
      } else {
        const remaining = Math.ceil(DEBOUNCE_SECONDS - diffInSeconds);
        console.log(`⏳ [BUFFER] Esperando silencio de ${phone}... (${remaining}s restantes para agrupar ${messages.length} mensaje(s))`);
      }
    }
  } catch (err) {
    console.error('❌ Error en processInboundBuffers:', err.message);
  } finally {
    isProcessing = false;
  }
}

/**
 * Detecta si el mensaje es una consulta comercial sobre precios, catálogo, productos o un saludo.
 */
function isCommercialOrGreetingQuery(text) {
  if (!text) return false;
  const clean = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Saludos habituales
  const greetingWords = [
    'hola', 'buen', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches',
    'que tal', 'saludos', 'alo', 'hey', 'buen dia'
  ];
  if (greetingWords.some((w) => clean.includes(w))) {
    return true;
  }

  // Palabras asociadas a preguntas sobre costos, catálogo, medidas y productos
  const commercialWords = [
    'costo', 'precio', 'cuanto', 'vale', 'valor', 'cotiz', 'tarjeta', 'volante',
    'flyer', 'pendon', 'banner', 'logo', 'catalogo', 'impresion', 'diseno', 'servicio',
    'info', 'informacion', 'necesito', 'tienen', 'hacen', 'venden', 'ofrecen',
    'quiero saber', 'cuanto sale', 'cuanto cuesta', 'paquete', 'promocion', 'medida',
    'adhesivo', 'vinilo', 'talonario', 'factura', 'membrete', 'carpeta', 'afiche',
    'sublimacion', 'estampado', 'menu', 'carta'
  ];
  return commercialWords.some((w) => clean.includes(w));
}

/**
 * Cierre determinista para evitar que una alucinación del modelo convierta un
 * saludo aislado en una orden. Solo permite palabras de cortesía, espacios y
 * puntuación; cualquier detalle comercial pasa al flujo normal de Gemini.
 */
function isGreetingOnly(text) {
  const clean = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:\-_/\\\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return false;

  const allowedWords = new Set([
    'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'que', 'tal',
    'saludos', 'alo', 'hey', 'buen', 'dia', 'gracias'
  ]);
  return clean.split(' ').every(word => allowedWords.has(word));
}

/**
 * Un pedido solo puede nacer de una aceptación comercial inequívoca. Mencionar
 * un producto, pedir precios o decir “necesito” sirve para cotizar, nunca para
 * crear obligaciones, carpetas de Drive ni solicitudes de pago.
 */
function isExplicitOrderConfirmation(text) {
  const clean = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean || /\b(no|todavia no|despues|solo|precio|precios|cotiz|informacion)\b/.test(clean)) return false;

  return [
    'confirmo el pedido',
    'confirmar el pedido',
    'confirmo la cotizacion',
    'acepto la cotizacion',
    'si lo quiero',
    'si quiero',
    'hagamoslo',
    'hagamos el pedido',
    'procedamos con el pedido',
    'adelante con el pedido',
    'quiero hacer el pedido',
    'quiero pedirlo'
  ].some(phrase => clean.includes(phrase));
}

/** Envía precio informativo, sin crear pedido, factura, carpeta ni cobro. */
async function sendQuoteOnly(phone, parsedData) {
  const products = Array.isArray(parsedData?.productos) ? parsedData.productos : [];
  const items = products.map(product => {
    const name = `${product.tipoDiseno || 'Diseño gráfico'}${product.varianteTinta && product.varianteTinta !== 'No aplica' ? ` (${product.varianteTinta})` : ''}`;
    const price = Number(product.precioUnitario || 0).toLocaleString('es-CO');
    return `• *${name}:* $${price} COP`;
  }).join('\n');
  const total = Number(parsedData?.montoTotalCalculado || 0).toLocaleString('es-CO');

  await sendWhatsAppWithDelay(
    phone,
    `💬 *Cotización informativa*\n\n${items}\n\n💰 *Total estimado:* $${total} COP\n\n` +
    `Esta cotización no crea ningún pedido ni genera cobro. Si deseas avanzar, responde exactamente: *Confirmo el pedido*. ✅`
  );
}

/** Obtiene solo el texto nuevo; el historial no debe alterar el clasificador. */
function getCurrentTextMessages(messages) {
  return (messages || [])
    .filter(message => message.message_type === 'text' && typeof message.content === 'string')
    .map(message => message.content)
    .join('\n');
}

/** “Aprobado” debe ganar siempre sobre el historial y sobre Gemini. */
function isDirectApproval(text) {
  const clean = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || /\b(no|nunca|sin)\s+(lo\s+)?aprueb/.test(clean)) return false;
  // Una frase positiva seguida de “pero”, “cambia”, “ajusta”, etc. nunca se
  // toma como aprobación: continúa siendo una solicitud de cambios.
  if (/\b(pero|cambia|cambiale|ajusta|modifica|falta|quisiera|necesito)\b/.test(clean)) return false;
  return /^(si\s+)?(lo\s+)?(apruebo|aprobado|aprobada|acepto|ok aprobado|listo aprobado|esta aprobado|esta bien|quedo bien|quedo perfecto|perfecto|me gusta|correcto|todo bien|asi esta bien|dale|ok|listo)$/.test(clean);
}

/**
 * Detecta si el cliente afirma haber pagado pero no adjuntó imagen de comprobante.
 */
function isPaymentClaimWithoutReceipt(text) {
  if (!text) return false;
  const clean = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const paymentPhrases = [
    'ya pague', 'ya transferi', 'ya consigne', 'ya envie el dinero', 'ya envie el pago',
    'ya te transferi', 'ya te consigne', 'ya deposite', 'listo ya pague', 'ya quedo el pago',
    'ya quedo el abono', 'ya cancele', 'ahi te transferi', 'ya envie la plata', 'ya envie el comprobante',
    'acabo de transferir', 'acabo de pagar'
  ];
  return paymentPhrases.some((p) => clean.includes(p));
}

/**
 * Resuelve todos los identificadores de un cliente (número real, LID de WhatsApp, etc.)
 * consultando la tabla whatsapp_lid_mapping para que nunca se pierda el hilo conversacional.
 */
async function resolveClientPhones(rawPhone) {
  const clean = (rawPhone || '').toString().trim().replace(/@.*$/, '').replace(/\D/g, '');
  const phones = new Set([rawPhone, clean]);

  if (clean) {
    try {
      const mapRes = await query(
        `SELECT lid, phone_number FROM whatsapp_lid_mapping WHERE lid = $1 OR phone_number = $1`,
        [clean]
      );
      for (const row of mapRes.rows) {
        if (row.lid) {
          phones.add(row.lid);
          phones.add(`${row.lid}@lid`);
        }
        if (row.phone_number) {
          phones.add(row.phone_number);
          phones.add(`${row.phone_number}@s.whatsapp.net`);
        }
      }
    } catch (e) {
      console.warn('⚠️ Error al consultar whatsapp_lid_mapping:', e.message);
    }
  }

  return Array.from(phones);
}

/**
 * Procesa la solicitud acumulada de un cliente aplicando:
 * 1. Control de Respuestas Automáticas (Anti-spam / Gatekeeper de estados).
 * 2. Análisis Multimodal de Comprobantes de Pago con Gemini Vision.
 */
async function handleCustomerBuffer(phone, messages) {
  const bufferIds = messages.map((m) => m.id);

  try {
    // Extraer número limpio para búsquedas cruzadas y resolver identificadores vinculados (LID vs Teléfono)
    const rawPhone = (phone || '').toString().trim();
    const cleanPhone = rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
    const clientPhones = await resolveClientPhones(phone);
    await ensureFinancialColumns();
    console.log(`🔍 [BUFFER] Identificadores vinculados para ${phone}: [${clientPhones.join(', ')}]`);

    // 1. Verificar si el cliente está explícitamente registrado y autorizado en la tabla 'clients'
    const clientRes = await query(
      `SELECT id, name, email, phone FROM clients 
       WHERE phone = ANY($1) OR phone LIKE '%' || $2 || '%' LIMIT 1`,
      [clientPhones, cleanPhone]
    );
    const isRegisteredClient = clientRes.rows && clientRes.rows.length > 0;
    const registeredClient = clientRes.rows[0];

    // 2. Consultar pedidos activos del cliente en este chat (no cerrados)
    const activeOrdersRes = await query(
      `SELECT id, "pedidoNum", cliente, telefono, "tipoDiseno", valor, abono, saldo, estado, qc_status, notes, drive_url,
              "driveFolderId", "driveFolderUrl", "archivosEnviados", "costoDisenador", utilidad, "metodoPago",
              client_review_status, entrega_enviada_at, invoice_id, created_at
       FROM orders 
       WHERE (telefono = ANY($1) OR whatsapp_chat_id = ANY($1)) 
         AND estado NOT IN ('Entregado', 'Cancelado', 'Finalizado')
       ORDER BY created_at DESC LIMIT 5`,
      [clientPhones]
    );
    const activeOrders = activeOrdersRes.rows || [];
    const activeOrder = activeOrders[0] || null;
    const activeOrdersContext = activeOrders
      .map(o => `- Pedido [${o.id}]: ${o.tipoDiseno} | Estado: ${o.estado} | Valor: $${Number(o.valor).toLocaleString('es-CO')}`)
      .join('\n');

    // 3. Consultar la última factura (invoice) del cliente
    const activeInvoiceRes = await query(
      `SELECT id, monto_total, abono_pagado, estado_pago 
       FROM invoices 
       WHERE telefono = ANY($1)
       ORDER BY created_at DESC LIMIT 1`,
      [clientPhones]
    );
    const activeInvoice = activeInvoiceRes.rows[0];

    // 4. Consultar historial reciente de mensajes de este cliente (últimas 24 horas)
    let historyMessages = [];
    try {
      const historyRes = await query(
        `SELECT id, phone_number, message_type, content, created_at
         FROM whatsapp_inbound_buffer
         WHERE phone_number = ANY($1)
           AND id != ALL($2::bigint[])
           AND created_at >= NOW() - INTERVAL '24 hours'
         ORDER BY created_at ASC
         LIMIT 25`,
        [clientPhones, bufferIds]
      );
      historyMessages = historyRes.rows || [];
    } catch (hErr) {
      console.warn('⚠️ No se pudo cargar historial conversacional:', hErr.message);
    }

    // Reconstruir texto consolidado con contexto del historial
    const combinedText = await buildCombinedText(messages, historyMessages);

    // Identificar todas las imágenes adjuntas en este lote de mensajes
    const imageMessages = messages.filter((m) => m.message_type === 'image' && m.media_url);

    // PRIORIDAD ABSOLUTA: una aprobación explícita de texto no pasa por Gemini
    // ni se mezcla con el historial. Así jamás puede convertirse en un pedido
    // nuevo después de una ronda de cambios.
    const currentTextForIntent = getCurrentTextMessages(messages);
    const hasNonTextInputForIntent = messages.some(message =>
      ['image', 'document', 'audio'].includes(message.message_type)
    );
    const isReviewAwaitingResponse = activeOrder && ['revision_cliente', 'cambios_solicitados'].includes(activeOrder.qc_status);
    if (!hasNonTextInputForIntent && isReviewAwaitingResponse && isDirectApproval(currentTextForIntent)) {
      console.log(`✅ [APROBACIÓN DIRECTA] Cliente ${phone} aprobó ${activeOrder.id}; validando saldo final.`);
      try {
        await query(
          `INSERT INTO revisiones (order_id, feedback_cliente, estado, created_at) VALUES ($1, $2, 'aprobado_cliente', NOW())`,
          [activeOrder.id, currentTextForIntent]
        );
      } catch (revisionError) {
        console.warn('⚠️ No se pudo registrar la aprobación en revisiones:', revisionError.message);
      }
      await query(
        `UPDATE orders SET client_review_status = 'approved', qc_status = 'aprobado_cliente', updated_at = NOW() WHERE id = $1`,
        [activeOrder.id]
      );
      await markBufferProcessed(bufferIds);
      await syncOrderToSupabase(activeOrder.id);
      await syncClientReviewStatus(activeOrder.id, { client_review_status: 'approved', client_review_comment: null });
      await deliverFinalFilesIfReady({ orderId: activeOrder.id, phone });
      return;
    }

    // =========================================================================
    // REGLA 2: ANÁLISIS MULTIMODAL DE COMPROBANTE DE PAGO (VISION)
    // =========================================================================
    let paymentAnalysis = null;
    let validReceiptMessage = null;

    if (imageMessages.length > 0) {
      console.log(`📸 [BUFFER] ${imageMessages.length} imagen(es) recibida(s) de ${phone}. Buscando comprobante de pago...`);

      // Evaluamos de la más reciente a la más antigua (los clientes suelen mandar el comprobante al final)
      for (const imgMsg of [...imageMessages].reverse()) {
        try {
          const analysis = await validatePaymentReceipt(imgMsg.media_url, 'image/jpeg', combinedText);
          if (analysis && analysis.esComprobanteValido) {
            paymentAnalysis = analysis;
            validReceiptMessage = imgMsg;
            console.log(`🎯 [VISION] ¡Comprobante encontrado entre las imágenes del lote! Banco: ${analysis.banco}, Monto: $${analysis.montoDetectado}`);
            break;
          } else if (analysis && analysis.isApiOverloaded && !paymentAnalysis) {
            paymentAnalysis = analysis;
          }
        } catch (visionErr) {
          console.error('❌ Error en análisis visual de Gemini:', visionErr.message);
        }
      }

      if (paymentAnalysis && paymentAnalysis.esComprobanteValido) {
        // CASO 2.1: Comprobante de pago legítimo
        console.log(`✅ [VISION] ¡Comprobante bancario VÁLIDO detectado para ${phone}! Banco: ${paymentAnalysis.banco}, Monto: $${paymentAnalysis.montoDetectado}`);

        if (activeOrder) {
          // 1. Subir la captura del comprobante bancario a Supabase Storage
          let receiptUrl = null;
          if (validReceiptMessage && validReceiptMessage.media_url) {
            try {
              let ext = 'jpg';
              const mimeMatch = validReceiptMessage.media_url.match(/^data:([^;]+);base64,/);
              if (mimeMatch && mimeMatch[1].includes('png')) ext = 'png';
              const receiptFileName = `${activeOrder.id}_comprobante.${ext}`;
              receiptUrl = await uploadBase64ToSupabaseStorage(activeOrder.id, receiptFileName, validReceiptMessage.media_url);
              console.log(`🧾 [RECEIPT] Comprobante subido a Supabase Storage: ${receiptUrl}`);
            } catch (rErr) {
              console.warn('⚠️ Error subiendo comprobante a Storage:', rErr.message);
            }
          }

          // Un comprobante puede cubrir varios productos creados en la misma
          // solicitud. Se distribuye proporcionalmente entre todos ellos, en
          // vez de atribuir todo el pago al último pedido del chat.
          const invoiceId = activeOrder.invoice_id || activeInvoice?.id || null;
          let paymentOrders = [activeOrder];
          if (invoiceId) {
            const invoiceOrdersRes = await query(
              `SELECT id, "tipoDiseno", valor, abono, client_review_status, invoice_id
                 FROM orders
                WHERE invoice_id = $1 AND estado NOT IN ('Cancelado', 'Anulado')
                ORDER BY created_at ASC`,
              [invoiceId]
            );
            if (invoiceOrdersRes.rows.length) paymentOrders = invoiceOrdersRes.rows;
          }

          const groupTotal = paymentOrders.reduce((sum, order) => sum + (Number(order.valor) || 0), 0);
          const priorOrderPaid = paymentOrders.reduce((sum, order) => sum + (Number(order.abono) || 0), 0);
          let priorPaid = priorOrderPaid;
          if (invoiceId) {
            const invoicePaymentRes = await query(`SELECT abono_pagado FROM invoices WHERE id = $1 LIMIT 1`, [invoiceId]);
            const invoicePaid = Number(invoicePaymentRes.rows[0]?.abono_pagado);
            if (Number.isFinite(invoicePaid) && invoicePaid >= 0) priorPaid = invoicePaid;
          }
          const paymentNow = Number(paymentAnalysis.montoDetectado) || 0;
          const groupPaid = Math.min(groupTotal, priorPaid + paymentNow);
          const canceloCompleto = groupTotal > 0 && groupPaid >= groupTotal;

          let distributed = 0;
          const allocations = paymentOrders.map((order, index) => {
            const value = Number(order.valor) || 0;
            const allocation = index === paymentOrders.length - 1
              ? Math.max(0, Math.min(value, groupPaid - distributed))
              : Math.max(0, Math.min(value, Math.round((value / groupTotal) * groupPaid)));
            distributed += allocation;
            return { order, allocation, balance: Math.max(0, value - allocation) };
          });

          for (const { order, allocation, balance } of allocations) {
            await query(
              `UPDATE orders SET
                 estado = 'Abonado', abono = $1, saldo = $2,
                 "pagoCliente" = $3, "confRecepcion" = 'Confirmado',
                 comprobante_url = COALESCE($4, comprobante_url),
                 "metodoPago" = COALESCE($5, "metodoPago"),
                 qc_status = CASE WHEN client_review_status = 'approved' THEN 'aprobado_cliente' ELSE 'pendiente_diseno' END,
                 updated_at = NOW() WHERE id = $6`,
              [allocation, balance, balance === 0 && allocation > 0 ? 'Pagado' : 'Parcial', receiptUrl,
                paymentAnalysis.banco || 'Transferencia Bancaria', order.id]
            );
          }

          if (invoiceId) {
            await query(
              `UPDATE invoices SET abono_pagado = $1, estado_pago = $2 WHERE id = $3`,
              [groupPaid, canceloCompleto ? 'pagado_completo' : 'abono_confirmado', invoiceId]
            );
          }

          await markBufferProcessed(bufferIds);
          for (const { order, allocation } of allocations) {
            await activateOrderAfterPayment({
              order,
              paymentAnalysis,
              clientPhones,
              bufferIds,
              abonoRegistrado: allocation,
              excludeMessageId: validReceiptMessage?.id,
              comprobanteUrl: receiptUrl
            });
            // activateOrderAfterPayment prepara Drive; restauramos el estado
            // de revisión para no perder una aprobación ya registrada.
            if (order.client_review_status === 'approved') {
              await query(`UPDATE orders SET qc_status = 'aprobado_cliente', updated_at = NOW() WHERE id = $1`, [order.id]);
            }
            await syncOrderToSupabase(order.id);
          }

          const orderIds = allocations.map(({ order }) => order.id).join(', ');
          const trackingMsg =
            `\n\n🔍 *Rastreo de tus pedidos:*\n` +
            `👉 https://nextal-graphic-interno-2.vercel.app/rastreo\n` +
            `Consulta allí: *${orderIds}*.`;
          const successMsg =
            `🎉 *¡Comprobante de pago verificado con éxito!*\n\n` +
            `📦 *Pedidos cubiertos:* ${orderIds}\n` +
            `🏦 *Entidad:* ${paymentAnalysis.banco || 'Transferencia Bancaria'}\n` +
            `💰 *Pago recibido:* $${paymentNow.toLocaleString('es-CO')} COP\n` +
            `💳 *Acumulado de la solicitud:* $${groupPaid.toLocaleString('es-CO')} de $${groupTotal.toLocaleString('es-CO')} COP\n` +
            `🔖 *Referencia:* ${paymentAnalysis.numeroReferencia || 'Confirmada'}\n\n` +
            `✅ El pago fue aplicado proporcionalmente a cada diseño de esta solicitud.` + trackingMsg;
          await sendWhatsAppWithDelay(phone, successMsg);

          for (const { order } of allocations) {
            await deliverFinalFilesIfReady({ orderId: order.id, phone });
          }
          return;
        } else {
          // Si no había pedido previo pero envió el comprobante, creamos el pedido ya abonado
          const parsedData = await extractOrderDetails(combinedText);
          const totalAmount = Number(parsedData?.montoTotalCalculado) || Number(paymentAnalysis.montoDetectado) || 0;

          let orderId;
          try {
            const rpcRes = await query(`SELECT get_next_order_id() AS next_id`);
            orderId = rpcRes.rows[0].next_id;
          } catch (e) {
            // Fallback consistente: mayor NG-#### existente + 1 (nomenclatura secuencial)
            try {
              const maxRes = await query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::int), 0) + 1 AS next_num FROM orders WHERE id LIKE 'NG-%'`);
              const n = Number(maxRes.rows[0] && maxRes.rows[0].next_num) || 1;
              orderId = 'NG-' + String(n).padStart(4, '0');
            } catch (e2) {
              orderId = `NG-${Date.now().toString().slice(-4)}`;
            }
          }

          const todayStr = new Date().toISOString().split('T')[0];
          const valorNum = totalAmount;
          const abonoNum = Number(paymentAnalysis.montoDetectado) || valorNum;
          const saldoNum = Math.max(0, valorNum - abonoNum);
          const canceloCompleto = valorNum > 0 && abonoNum >= valorNum;
          const pagoClienteEstado = canceloCompleto ? 'Pagado' : 'Parcial';

          const prodPrincipal = (parsedData?.productos && parsedData.productos[0]) || {};
          const tipoDisenoPrincipal = (parsedData?.productos || []).map(p => p.tipoDiseno).join(', ') || 'Diseño Gráfico';
          const clientName = parsedData?.nombreCliente || registeredClient?.name || 'Cliente WhatsApp';

          // 1. Crear subcarpeta en Google Drive para el pedido
          const folderName = `[${orderId}] - ${tipoDisenoPrincipal} - ${clientName}`;
          let driveUrl = null;
          try {
            driveUrl = await createOrderFolder(folderName);
          } catch (dErr) {
            console.warn('⚠️ Error al crear carpeta de Drive:', dErr.message);
          }
          // Nunca usar la carpeta padre como sustituto: cada pedido debe tener su propia carpeta.
          const effectiveFolderId = getFolderIdFromUrl(driveUrl);
          const effectiveDriveUrl = effectiveFolderId ? driveUrl : null;

          // 2. Subir comprobante a Supabase Storage
          let receiptUrl = null;
          if (validReceiptMessage && validReceiptMessage.media_url) {
            try {
              let ext = 'jpg';
              const mimeMatch = validReceiptMessage.media_url.match(/^data:([^;]+);base64,/);
              if (mimeMatch && mimeMatch[1].includes('png')) ext = 'png';
              const receiptFileName = `${orderId}_comprobante.${ext}`;
              receiptUrl = await uploadBase64ToSupabaseStorage(orderId, receiptFileName, validReceiptMessage.media_url);
              console.log(`🧾 [RECEIPT] Comprobante subido a Supabase Storage: ${receiptUrl}`);
            } catch (rErr) {
              console.warn('⚠️ Error subiendo comprobante a Storage:', rErr.message);
            }
          }

          const notasStr = prodPrincipal.notasDiseno || prodPrincipal.descripcionDetallada || 'Sin notas adicionales';
          // `notes` se muestra al cliente en Rastreo: solo conserva instrucciones creativas.
          const orderNotes = notasStr;

          const costoDisenadorNum = Math.round(valorNum * 0.4);
          const utilidadNum = valorNum - costoDisenadorNum;

          await query(
            `INSERT INTO orders (
              id, fecha, "pedidoNum", cliente, "razonSocial", ciudad, telefono, canal, "tipoDiseno",
              valor, abono, saldo, "metodoPago", estado, qc_status, referencia, drive_url, "driveFolderId", "driveFolderUrl",
              "archivosEnviados", notes, origen, whatsapp_chat_id, created_at,
              "costoDisenador", "costoAsesor", utilidad, "pagoCliente", "pagoDisenador", "pagoAsesor",
              comprobante_url, "confRecepcion"
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, 'WhatsApp Bot', $8,
              $9, $10, $11, $12, 'Abonado', 'pendiente_diseno', $13, $14, $15, $14,
              TRUE, $16, 'whatsapp', $17, NOW(),
              $18, 0, $19, $20, 'Pendiente', 'Pendiente',
              $21, 'Confirmado'
            )`,
            [
              orderId,
              todayStr,
              orderId,
              clientName,
              parsedData?.razonSocial || 'Persona Natural',
              parsedData?.ciudad || 'Sin especificar',
              cleanPhone || phone,
              tipoDisenoPrincipal,
              valorNum,
              abonoNum,
              saldoNum,
              paymentAnalysis.banco || 'Transferencia',
              effectiveDriveUrl,
              effectiveDriveUrl,
              effectiveFolderId,
              orderNotes,
              phone,
              costoDisenadorNum,
              utilidadNum,
              pagoClienteEstado,
              receiptUrl
            ]
          );

          await markBufferProcessed(bufferIds);

          // ── ACTIVACIÓN COMPLETA DEL PEDIDO (caso sin pedido previo) ──────────
          try {
            const newOrderRes = await query(`SELECT id, "tipoDiseno", valor, drive_url, cliente FROM orders WHERE id = $1`, [orderId]);
            if (newOrderRes.rows[0]) {
              await activateOrderAfterPayment({
                order: newOrderRes.rows[0],
                paymentAnalysis,
                clientPhones,
                bufferIds,
                abonoRegistrado: abonoNum,
                excludeMessageId: validReceiptMessage?.id,
                comprobanteUrl: receiptUrl
              });
            }
            await syncOrderToSupabase(orderId);
          } catch (actErr) {
            console.warn('⚠️ [ACTIVAR] No se pudo activar el pedido nuevo:', actErr.message);
          }
          // ─────────────────────────────────────────────────────────────────────

          const trackingMsg =
            `\n\n🔍 *Rastreo de tu pedido en tiempo real:*\n` +
            `Puedes hacer seguimiento al avance de tu diseño ingresando a:\n` +
            `👉 https://nextal-graphic-interno-2.vercel.app/rastreo\n` +
            `Solo abre la página y escribe el ID de tu pedido (*${orderId}*) en el buscador para ver el estado de tu diseño.`;

          await sendWhatsAppWithDelay(
            phone,
            `🎉 *¡Comprobante verificado y pedido creado!*\n\n` +
            `📦 *Pedido Registrado:* ${orderId}\n` +
            `🏦 *Banco:* ${paymentAnalysis.banco || 'Transferencia Bancaria'}\n` +
            `💰 *Abono:* $${Number(paymentAnalysis.montoDetectado).toLocaleString('es-CO')} COP\n\n` +
            `✅ Tu pedido ha avanzado a estado *Abonado* y se encuentra formalmente en cola con el equipo de diseño gráfico.` +
            trackingMsg +
            `\n\n¡Tu pedido ya está en producción! Te notificaremos por aquí tan pronto el equipo tenga lista tu propuesta de diseño.`
          );
          return;
        }
      } else {
        // CASO 2.2: La imagen NO es comprobante bancario.
        // Verificamos si el cliente estaba explícitamente en espera de pago y solo envió esta imagen
        const orderStatus = (activeOrder?.estado || '').trim().toLowerCase();
        const invoiceStatus = (activeInvoice?.estado_pago || '').trim().toLowerCase();
        const isAwaitingPayment =
          ['solicitud recibida', 'pago pendiente', 'pendiente', 'pendiente_pago', 'solicitud_recibida'].includes(orderStatus) ||
          invoiceStatus === 'pendiente_abono';

        if (paymentAnalysis?.isApiOverloaded) {
          console.warn(`⚠️ [VISION] Gemini Vision temporalmente saturado para ${phone}. Conservando contexto de pedido ${activeOrder?.id}.`);
          if (activeOrder) {
            await markBufferProcessed(bufferIds);
            const holdMsg =
              `📸 *¡Comprobante recibido para tu pedido ${activeOrder.id}!*\n\n` +
              `Estamos validando la transferencia con la entidad bancaria. Tan pronto se confirme el registro del abono, tu pedido iniciará producción formal y te lo notificaremos de inmediato. ¡Muchas gracias por tu paciencia!`;
            await sendWhatsAppWithDelay(phone, holdMsg);
            return;
          }
        }

        const isExplicitPaymentClaim = isPaymentClaimWithoutReceipt(combinedText);

        if (isAwaitingPayment && (isExplicitPaymentClaim || messages.length === 1)) {
          const motivo = paymentAnalysis?.motivo || 'no se aprecian datos de transferencia bancaria ni monto';
          console.log(`⚠️ [VISION] Comprobante no válido para ${phone}: ${motivo}`);

          await markBufferProcessed(bufferIds);

          const rejectMsg =
            `⚠️ Hemos recibido tu imagen, pero el sistema no pudo validarla como un comprobante de pago bancario legible (${motivo}).\n\n` +
            `📸 Para registrar tu abono e iniciar la producción de tu pedido *${activeOrder?.id || ''}*, por favor envíanos la captura o foto del comprobante emitido por tu banco (Bancolombia, Nequi, Daviplata, etc.) donde se aprecie claramente el valor transferido y número de comprobante.`;

          await sendWhatsAppWithDelay(phone, rejectMsg);
          return;
        } else {
          // Si el cliente no estaba en cobro estricto o está cotizando/enviando materiales (como en Imagen 2):
          // La imagen es un INSUMO / REFERENCIA DE DISEÑO legítima para su trabajo
          console.log(`🎨 [VISION] La imagen recibida de ${phone} se clasifica como INSUMO/REFERENCIA DE DISEÑO para el pedido.`);

          // Si el cliente YA TIENE un pedido activo pendiente de pago y envió una imagen (no comprobante),
          // NO generar una nueva cotización: simplemente recordarle que envíe el comprobante.
          if (activeOrder && ['pendiente', 'solicitud recibida', 'solicitud_recibida', 'pago pendiente', 'pendiente_pago'].includes((activeOrder.estado || '').trim().toLowerCase())) {
            await uploadDesignAssetsForOrder(activeOrder, messages);
            await sendPendingOrderPackage(phone, activeOrder);
            await markBufferProcessed(bufferIds);
            return;
          }
        }
      }
    }

    // =========================================================================
    // CASO: CLIENTE RESPONDE CAMBIOS, AJUSTES O APROBACIÓN DE UN DISEÑO
    // (Funciona incluso si el cliente contesta 2 días después de recibir la muestra)
    // =========================================================================
    let targetOrderForFeedback = activeOrder;
    if (!targetOrderForFeedback) {
      try {
        const recentOrderRes = await query(
          `SELECT id, "tipoDiseno", valor, estado, qc_status, notes, drive_url, "driveFolderId", "driveFolderUrl", created_at
           FROM orders 
           WHERE telefono = ANY($1) 
             AND estado != 'Cancelado'
           ORDER BY created_at DESC LIMIT 1`,
          [clientPhones]
        );
        if (recentOrderRes.rows && recentOrderRes.rows.length > 0) {
          targetOrderForFeedback = recentOrderRes.rows[0];
        }
      } catch (rErr) {
        console.warn('⚠️ Error al buscar pedido reciente para retroalimentación:', rErr.message);
      }
    }

    if (targetOrderForFeedback) {
      try {
        const feedbackCheck = await detectFeedbackOrAdjustment(combinedText, targetOrderForFeedback);
        if (feedbackCheck && feedbackCheck.isFeedback) {
          console.log(`🔄 [FEEDBACK DETECTADO] Cliente ${phone} envió "${feedbackCheck.type}" para pedido ${targetOrderForFeedback.id}: ${feedbackCheck.resumen}`);

          if (feedbackCheck.type === 'cambios') {
            // 1. Registrar en tabla revisiones si existe
            try {
              await query(
                `INSERT INTO revisiones (order_id, feedback_cliente, estado, created_at) VALUES ($1, $2, 'cambios_solicitados', NOW())`,
                [targetOrderForFeedback.id, combinedText]
              );
            } catch (revErr) {}

            // 2. Si el cliente adjuntó imágenes o bocetos nuevos para el cambio, subirlos a Drive
            const newChangeAssets = messages.filter(m => (m.message_type === 'image' || m.message_type === 'document') && m.media_url && m.media_url.startsWith('data:'));
            if (newChangeAssets.length > 0) {
              await uploadDesignAssetsForOrder(targetOrderForFeedback, newChangeAssets);
            }

            // 3. Actualizar el pedido en PostgreSQL
            await query(
              `UPDATE orders SET
                 qc_status = 'cambios_solicitados',
                 estado = 'En proceso',
                 updated_at = NOW()
               WHERE id = $1`,
              [targetOrderForFeedback.id]
            );

            await markBufferProcessed(bufferIds);
            await syncOrderToSupabase(targetOrderForFeedback.id);
            const changesCountRes = await query(
              `SELECT COUNT(*)::int AS count FROM revisiones WHERE order_id = $1 AND estado = 'cambios_solicitados'`,
              [targetOrderForFeedback.id]
            );
            const clientRevisionCount = Number(changesCountRes.rows[0]?.count || 1);
            const extraChanges = Math.max(0, clientRevisionCount - FREE_CLIENT_CHANGES);
            const changesCharge = extraChanges * EXTRA_CHANGE_PRICE;
            const baseValue = Number(targetOrderForFeedback.valor) || 0;
            await query(
              `UPDATE orders SET
                 valor_base = COALESCE(valor_base, $1),
                 cambios_cliente = $2,
                 costo_cambios = $3,
                 valor = COALESCE(valor_base, $1) + $3,
                 saldo = GREATEST(0, COALESCE(valor_base, $1) + $3 - COALESCE(abono, 0)),
                 updated_at = NOW()
               WHERE id = $4`,
              [baseValue, clientRevisionCount, changesCharge, targetOrderForFeedback.id]
            );
            await syncOrderToSupabase(targetOrderForFeedback.id);
            await syncClientReviewStatus(targetOrderForFeedback.id, {
              client_review_status: 'rejected',
              client_review_comment: feedbackCheck.resumen || combinedText.substring(0, 500),
              client_revision_count: clientRevisionCount
            });

            const pricingNotice = clientRevisionCount <= FREE_CLIENT_CHANGES
              ? `Este es el cambio *#${clientRevisionCount} de ${FREE_CLIENT_CHANGES} gratuitos* incluidos en tu pedido.`
              : `Este es el cambio *#${clientRevisionCount}*. Se adicionó *$${EXTRA_CHANGE_PRICE.toLocaleString('es-CO')} COP* por este ajuste; los cambios adicionales acumulados son *$${changesCharge.toLocaleString('es-CO')} COP*.`;
            const replyMsg =
              `✍️ *¡Ajustes recibidos con éxito!*\n\n` +
              `Hemos registrado tus observaciones para el pedido *${targetOrderForFeedback.id}* (${targetOrderForFeedback.tipoDiseno || 'Diseño'}).\n\n` +
              `${pricingNotice}\n\n` +
              `Tu diseñador asignado ya tiene los requerimientos y te compartiremos la propuesta corregida tan pronto esté lista. ¡Muchas gracias por avisarnos! 🙌`;

            await sendWhatsAppWithDelay(phone, replyMsg);
            return;
          } else if (feedbackCheck.type === 'aprobacion') {
            try {
              await query(
                `INSERT INTO revisiones (order_id, feedback_cliente, estado, created_at) VALUES ($1, $2, 'aprobado_cliente', NOW())`,
                [targetOrderForFeedback.id, combinedText]
              );
            } catch (revErr) {}

            await query(
              `UPDATE orders SET
                 qc_status = 'aprobado_cliente',
                 estado = 'En proceso',
                 updated_at = NOW()
               WHERE id = $1`,
              [targetOrderForFeedback.id]
            );

            await markBufferProcessed(bufferIds);
            await syncOrderToSupabase(targetOrderForFeedback.id);
            await syncClientReviewStatus(targetOrderForFeedback.id, {
              client_review_status: 'approved',
              client_review_comment: null
            });

            await deliverFinalFilesIfReady({ orderId: targetOrderForFeedback.id, phone });
            return;
          } else if (feedbackCheck.type === 'consulta_avance') {
            const replyMsg =
              `👋 ¡Hola! Tu pedido *${targetOrderForFeedback.id}* (${targetOrderForFeedback.tipoDiseno || 'Diseño'}) se encuentra actualmente en cola de trabajo con el equipo de diseño gráfico.\n\n` +
              `Estamos preparando tu propuesta y te la compartiremos por aquí apenas esté lista. ¡Muchas gracias por tu paciencia!`;

            await sendWhatsAppWithDelay(phone, replyMsg);
            await markBufferProcessed(bufferIds);
            return;
          }
        }
      } catch (fbErr) {
        console.warn('⚠️ Error en verificación de retroalimentación/ajustes:', fbErr.message);
      }

      // Si no es una instrucción textual de ajuste, los adjuntos restantes son
      // insumos creativos. Los comprobantes válidos ya retornaron antes de llegar aquí.
      const designAssets = messages.filter(m =>
        ['image', 'document'].includes(m.message_type) &&
        typeof m.media_url === 'string' && m.media_url.startsWith('data:')
      );
      if (designAssets.length > 0) {
        const uploaded = await uploadDesignAssetsForOrder(targetOrderForFeedback, designAssets);
        await markBufferProcessed(bufferIds);
        await syncOrderToSupabase(targetOrderForFeedback.id);
        await sendWhatsAppWithDelay(
          phone,
          `📁 Recibimos ${uploaded.length} archivo(s) de referencia para tu pedido *${targetOrderForFeedback.id}*. Ya están disponibles para el equipo de diseño. ✅`
        );
        return;
      }
    }

    // =========================================================================
    // REGLA 1: CONTROL INTELIGENTE DE RESPUESTAS (Gatekeeper Flexible de Estados)
    // =========================================================================
    const orderStatus = (activeOrder?.estado || '').trim().toLowerCase();
    const invoiceStatus = (activeInvoice?.estado_pago || '').trim().toLowerCase();

    const isAwaitingPaymentOrApproval =
      ['solicitud recibida', 'pago pendiente', 'pendiente', 'pendiente_pago', 'solicitud_recibida'].includes(orderStatus) ||
      invoiceStatus === 'pendiente_abono';

    if (isAwaitingPaymentOrApproval) {
      // Caso 1: El cliente afirma haber realizado el pago pero no adjuntó la foto del comprobante
      if (isPaymentClaimWithoutReceipt(combinedText)) {
        console.log(`💬 [GATEKEEPER] El cliente ${phone} afirma haber pagado pero no adjuntó imagen.`);
        const receiptReminder =
          `👋 ¡Hola! Para poder validar tu pago e iniciar de inmediato el diseño de tu pedido *${activeOrder.id}*, ` +
          `por favor *envíanos la foto o captura legible del comprobante de transferencia bancaria* por este chat. 📸\n\n` +
          `Apenas la envíes, nuestro sistema la verificará de forma automática.`;

        await sendWhatsAppWithDelay(phone, receiptReminder);
        await markBufferProcessed(bufferIds);
        return;
      }

      // Caso 2: El cliente está consultando precios, catálogo, productos o saludando
      // ¡NO SE SILENCIA! Se permite que la IA de Gemini responda de forma natural y fluida.
      const isAskingCatalogOrGreeting = isCommercialOrGreetingQuery(combinedText);

      if (!isAskingCatalogOrGreeting) {
        // Mensajes casuales de espera ("ok", "listo", "me avisan", "¿ya lo vieron?"):
        // Se silencian para no enviar respuestas automáticas repetitivas mientras el admin revisa.
        console.log(`⏸️ [GATEKEEPER] Cliente ${phone} con pedido en espera (${activeOrder.id}). Mensaje casual silenciado sin spam.`);
        await markBufferProcessed(bufferIds);
        return;
      }

      console.log(`💬 [GATEKEEPER] Cliente ${phone} tiene pedido en espera, pero está cotizando o saludando. Permitiendo que Gemini IA responda naturalmente...`);
    }

    // =========================================================================
    // ETAPA INICIAL: COTIZACIÓN COMERCIAL AUTOMATIZADA CON IA
    // =========================================================================
    // Un saludo no necesita interpretación de IA ni puede generar una orden.
    // Esto protege el catálogo, Drive y el dashboard ante respuestas erróneas
    // del modelo cuando el cliente solo está comprobando que el canal funciona.
    const currentText = getCurrentTextMessages(messages);
    const hasNonTextInput = messages.some(message =>
      ['image', 'document', 'audio'].includes(message.message_type)
    );
    if (!hasNonTextInput && isGreetingOnly(currentText)) {
      console.log(`💬 [BUFFER] Saludo aislado de ${phone}; respondiendo sin crear pedido.`);
      await sendWhatsAppWithDelay(
        phone,
        '¡Hola! 👋 Bienvenido a Nextal Graphic. ¿Qué diseño necesitas cotizar hoy?'
      );
      await markBufferProcessed(bufferIds);
      return;
    }

    console.log(`🤖 [BUFFER] Procesando solicitud de ${phone} con IA Gemini...`);
    const rulesContext = await getActiveBotRulesContext();
    const aiContext = rulesContext
      ? `${combinedText}\n\n[REGLAS OPERATIVAS DEFINIDAS POR EL ADMIN]\n${rulesContext}`
      : combinedText;
    const parsedData = await extractOrderDetails(aiContext, activeOrdersContext);

    if (!parsedData) {
      console.warn(`⚠️ No se obtuvieron datos estructurados para ${phone}`);
      await markBufferProcessed(bufferIds);
      return;
    }

    const totalAmount = Number(parsedData.montoTotalCalculado) || 0;
    const hasProducts = Array.isArray(parsedData.productos) && parsedData.productos.length > 0;

    // Subcaso: Consulta general o mensaje sin productos detectados
    if (!hasProducts) {
      console.log(`💬 [BUFFER] Mensaje sin productos detectados de ${phone}.`);

      let responseText = parsedData.resumenGeneral;

      // PRESERVACIÓN ESTRICTA DE CONTEXTO:
      // Si la IA está sobrecargada o devolvió texto genérico, pero el cliente YA TIENE un pedido activo:
      if (!responseText || parsedData.apiOverloaded || responseText.includes('no pude identificar')) {
        if (activeOrder) {
          const abonoReq = (Math.round(Number(activeOrder.valor || 0) / 2)).toLocaleString('es-CO');
          const totalReq = (Number(activeOrder.valor || 0)).toLocaleString('es-CO');
          responseText = 
            `¡Hola! Respecto a tu pedido *${activeOrder.id}* (${activeOrder.tipoDiseno}):\n\n` +
            `• *Valor Total Diseño:* $${totalReq} COP\n` +
            `• *Abono Requerido (50%):* $${abonoReq} COP\n\n` +
            `🏦 *Cuentas oficiales para transferencia:*\n` +
            `• Bancolombia Ahorros: 05993698379\n` +
            `• Nequi / Daviplata: 3234315008\n\n` +
            `📸 Envíanos por aquí la foto o captura del comprobante de transferencia para habilitar tu carpeta de diseño e iniciar la producción.`;
        } else {
          responseText =
            '¡Hola! 👋 Bienvenido a Nextal Graphic, tu aliado creativo del sector publicitario.\n¿En qué servicio te podemos colaborar hoy? Cuéntanos los detalles de tu requerimiento y con gusto te cotizamos.';
        }
      }

      await sendWhatsAppWithDelay(phone, responseText);
      await markBufferProcessed(bufferIds);
      return;
    }

    // Mencionar un producto o pedir precios es una cotización, no una orden.
    // El historial de las últimas 24 h permite que un “Confirmo el pedido”
    // posterior recupere estos mismos productos sin que el cliente repita todo.
    if (!isExplicitOrderConfirmation(currentText)) {
      console.log(`💬 [COTIZACIÓN] ${phone} consultó ${parsedData.productos.length} producto(s) sin confirmar pedido.`);
      await sendQuoteOnly(phone, parsedData);
      await markBufferProcessed(bufferIds);
      return;
    }

    // Solo una aceptación explícita puede crear factura y pedido.
    console.log(`📦 [PEDIDO CONFIRMADO] ${phone} confirmó ${parsedData.productos.length} producto(s), Total estimado: $${totalAmount}. Registrando...`);

    let newInvoiceId = null;
    if (totalAmount > 0) {
      try {
        const invRes = await query(
          `INSERT INTO invoices (telefono, monto_total, abono_pagado, estado_pago, created_at)
           VALUES ($1, $2, 0, 'pendiente_abono', NOW())
           RETURNING id`,
          [cleanPhone || phone, totalAmount]
        );
        if (invRes.rows && invRes.rows.length > 0) {
          newInvoiceId = invRes.rows[0].id;
        }
      } catch (invErr) {
        console.warn('⚠️ No se pudo insertar en invoices:', invErr.message);
      }
    }

    const createdOrderItems = [];
    const todayStr = new Date().toISOString().split('T')[0];
    const pendingAssets = messages.filter(m =>
      (m.message_type === 'image' || m.message_type === 'document') &&
      m.media_url && m.media_url.startsWith('data:')
    );
    const assetAssignments = await assignDesignAssetsToProducts(parsedData.productos, pendingAssets);

    for (const [productIndex, prod] of parsedData.productos.entries()) {
      let orderId;
      try {
        const rpcRes = await query(`SELECT get_next_order_id() AS next_id`);
        orderId = rpcRes.rows[0].next_id;
      } catch (e) {
        // Fallback consistente: mayor NG-#### existente + 1 (nomenclatura secuencial)
        try {
          const maxRes = await query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::int), 0) + 1 AS next_num FROM orders WHERE id LIKE 'NG-%'`);
          const n = Number(maxRes.rows[0] && maxRes.rows[0].next_num) || 1;
          orderId = 'NG-' + String(n).padStart(4, '0');
        } catch (e2) {
          orderId = `NG-${Date.now().toString().slice(-4)}`;
        }
      }

      const clientName = parsedData.nombreCliente || registeredClient?.name || 'Cliente WhatsApp';

      // 1. Crear subcarpeta automáticamente en Google Drive dentro de 'Diseños - Nextal Graphic'
      const folderName = `[${orderId}] - ${prod.tipoDiseno || 'Diseño'} - ${clientName}`;
      let driveUrl = null;
      try {
        driveUrl = await createOrderFolder(folderName);
      } catch (dErr) {
        console.warn('⚠️ Error al crear carpeta de Drive:', dErr.message);
      }

      // Nunca usar la carpeta padre como sustituto: cada pedido debe tener su propia carpeta.
      const effectiveFolderId = getFolderIdFromUrl(driveUrl);
      const effectiveDriveUrl = effectiveFolderId ? driveUrl : null;

      // 2. Subir insumos/imágenes adjuntas a Supabase Storage y a la carpeta de Google Drive
      const supabaseUrl = process.env.SUPABASE_URL || 'https://ygpfvmevizoetnvsxsqu.supabase.co';
      const uploadedDesignAssets = [];
      let detectedReceiptUrl = null;

      // Adjuntos que la IA relacionó con este producto, no con los demás pedidos del lote.
      const productAssets = assetAssignments
        .filter(item => item.productIndex === productIndex)
        .map(item => pendingAssets[item.assetIndex])
        .filter(Boolean);
      
      let designAssetIdx = 1;
      for (const asset of productAssets) {
        try {
          let ext = 'jpg';
          const mimeMatch = asset.media_url.match(/^data:([^;]+);base64,/);
          if (mimeMatch) {
            const mime = mimeMatch[1];
            ext = mime.includes('png') ? 'png' : (mime.includes('pdf') ? 'pdf' : 'jpg');
          }

          // Verificar si esta imagen específica es un comprobante de pago bancario
          let isReceipt = false;
          if (asset.message_type === 'image') {
            try {
              const receiptTest = await validatePaymentReceipt(asset.media_url, 'image/jpeg', '');
              if (receiptTest && receiptTest.esComprobanteValido) {
                isReceipt = true;
                const receiptFileName = `${orderId}_comprobante.${ext}`;
                detectedReceiptUrl = await uploadBase64ToSupabaseStorage(orderId, receiptFileName, asset.media_url);
                console.log(`🧾 [RECEIPT] Comprobante detectado y separado de Drive para ${orderId}: ${detectedReceiptUrl}`);
              }
            } catch (vErr) {
              console.warn('⚠️ Error evaluando si imagen es comprobante:', vErr.message);
            }
          }

          // Si es comprobante de pago, NO se sube a Google Drive (insumos de diseño)
          if (isReceipt) {
            continue;
          }

          // Si es insumo/referencia legítima para el diseño:
          const fileName = `${orderId}_insumo_${designAssetIdx}.${ext}`;

          // Subir a Supabase Storage para miniatura y visualización en el panel
          const publicUrl = await uploadBase64ToSupabaseStorage(orderId, fileName, asset.media_url);
          if (publicUrl) {
            uploadedDesignAssets.push({ name: fileName, url: publicUrl });
          }

          // Subir a la carpeta de Google Drive del pedido (exclusivo para diseñadores)
          if (effectiveFolderId) {
            const driveFileUrl = await uploadBase64ToFolder(effectiveFolderId, fileName, asset.media_url);
            if (!driveFileUrl) throw new Error(`Drive no confirmó la carga de ${fileName}`);
          }

          designAssetIdx++;
        } catch (upErr) {
          console.warn(`⚠️ Error procesando insumo para ${orderId}:`, upErr.message);
        }
      }

      const hasUploadedAssets = uploadedDesignAssets.length > 0;
      const primaryRef = hasUploadedAssets ? uploadedDesignAssets[0].url : effectiveDriveUrl;

      // NOTAS LIMPIAS DEL PEDIDO (Sin el chat de WhatsApp ni voleo de texto)
      const notasStr = prod.notasDiseno || prod.descripcionDetallada || 'Sin especificaciones adicionales';
      // Rastreo consume este campo directamente; nunca mezclar enlaces, pagos o medidas.
      const orderNotes = notasStr;

      const tipoDisenoConTinta = `${prod.tipoDiseno}${prod.varianteTinta && prod.varianteTinta !== 'No aplica' ? ' (' + prod.varianteTinta + ')' : ''}`;
      const precioProd = Number(prod.precioUnitario) || 0;

      const valorNum = precioProd;
      const costoDisenadorNum = Math.round(valorNum * 0.4);
      const utilidadNum = valorNum - costoDisenadorNum;

      await query(
        `INSERT INTO orders (
          id, fecha, "pedidoNum", cliente, "razonSocial", ciudad, telefono, canal, "tipoDiseno",
          valor, abono, saldo, "metodoPago", estado, qc_status, referencia, drive_url, "driveFolderId", "driveFolderUrl",
          "archivosEnviados", notes, invoice_id, origen, whatsapp_chat_id, created_at,
          "costoDisenador", "costoAsesor", utilidad, "pagoCliente", "pagoDisenador", "pagoAsesor",
          comprobante_url, "confRecepcion"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, 'WhatsApp Bot', $8,
          $9, 0, $9, 'Transferencia', 'Pendiente', 'pendiente_diseno', $10, $11, $12, $11,
          $13, $14, $15, 'whatsapp', $16, NOW(),
          $17, 0, $18, 'Pendiente', 'Pendiente', 'Pendiente',
          $19, $20
        )
        ON CONFLICT (id) DO UPDATE SET
          valor = EXCLUDED.valor,
          saldo = EXCLUDED.saldo,
          notes = EXCLUDED.notes,
          referencia = EXCLUDED.referencia,
          "driveFolderId" = EXCLUDED."driveFolderId",
          "driveFolderUrl" = EXCLUDED."driveFolderUrl",
          drive_url = EXCLUDED.drive_url,
          "archivosEnviados" = EXCLUDED."archivosEnviados",
          utilidad = EXCLUDED.utilidad,
          comprobante_url = COALESCE(EXCLUDED.comprobante_url, orders.comprobante_url),
          "confRecepcion" = COALESCE(EXCLUDED."confRecepcion", orders."confRecepcion")`,
        [
          orderId,
          todayStr,
          orderId,
          clientName,
          parsedData.razonSocial || 'Persona Natural',
          parsedData.ciudad || 'Sin especificar',
          cleanPhone || phone,
          tipoDisenoConTinta,
          valorNum,
          primaryRef,
          effectiveDriveUrl,
          effectiveFolderId,
          hasUploadedAssets,
          orderNotes,
          newInvoiceId,
          phone,
          costoDisenadorNum,
          utilidadNum,
          detectedReceiptUrl,
          detectedReceiptUrl ? 'Confirmado' : 'Pendiente'
        ]
      );

      createdOrderItems.push({
        id: orderId,
        tipoDiseno: tipoDisenoConTinta,
        precio: precioProd,
        descripcion: prod.descripcionDetallada || ''
      });
      await syncOrderToSupabase(orderId);
    }

    await markBufferProcessed(bufferIds);

    // Armar detalle de productos con nomenclatura exacta y descripción detallada
    const itemsSummary = createdOrderItems.map((item, idx) => {
      const precioStr = item.precio > 0
        ? `$${item.precio.toLocaleString('es-CO')} COP`
        : '$15.000 COP';
      
      const descStr = item.descripcion
        ? `\n  ↳ *Descripción:* ${item.descripcion}`
        : '';

      const itemPrefix = createdOrderItems.length > 1 ? `Item ${idx + 1} ` : '';
      return `• *${itemPrefix}[${item.id}]:* ${item.tipoDiseno}\n  ↳ *Valor Diseño:* ${precioStr}${descStr}`;
    }).join('\n\n');

    const totalCalculado = createdOrderItems.reduce((acc, curr) => acc + (curr.precio || 15000), 0);
    const abono50 = (Math.round(totalCalculado / 2)).toLocaleString('es-CO');
    const totalFormat = totalCalculado.toLocaleString('es-CO');

    const financialSection =
      `💰 *Valor Total Diseño:* $${totalFormat} COP\n` +
      `💵 *Abono Inicial Requerido (50%):* $${abono50} COP\n\n` +
      `🏦 *Cuentas oficiales para transferencia:*\n` +
      `• *Bancolombia Ahorros:* 05993698379\n` +
      `• *Nequi / Daviplata:* 3234315008\n\n`;

    // Identificar si el cliente adjuntó imágenes o archivos en este lote
    const attachedAssets = messages.filter(m => (m.message_type === 'image' || m.message_type === 'document') && m.media_url);
    const hasAssets = attachedAssets.length > 0;

    const assetsNotice = hasAssets
      ? `📸 Por favor envíanos por aquí la foto del comprobante de transferencia para habilitar tu carpeta de diseño y comenzar la producción.\n\n📁 *Archivos recibidos:* Ya registramos tus insumos/referencias adjuntas; una vez validado el comprobante, el diseñador asignado iniciará con ellos de inmediato.`
      : `📸 Por favor envíanos por aquí la foto del comprobante de transferencia junto con los archivos e insumos de tu diseño (logos, textos, referencias o enlace si son pesados) para habilitar tu carpeta y comenzar la producción.`;

    const orderIdsHeader = createdOrderItems.map(o => o.id).join(', ');

    const confirmationMsg =
      `📋 *NEXTAL GRAPHIC - Desglose Formal del Pedido*\n\n` +
      `📦 *Pedido Registrado:* ${orderIdsHeader}\n\n` +
      `📝 *Detalle de Productos:*\n${itemsSummary}\n\n` +
      `${financialSection}` +
      `${assetsNotice}\n\n` +
      `🔗 *¿Aún no te has registrado?* Te invitamos a registrarte en nuestra plataforma oficial:\nhttps://nextal-graphic-interno-2.vercel.app/clientes#`;

    // 1. Enviar primero la infografía de políticas de servicio con caption corto
    if (fs.existsSync(POLICY_IMAGE_PATH)) {
      console.log(`🖼️ [BUFFER] Enviando imagen de políticas de servicio a ${phone}...`);
      const policyCopy = `📢 *¡Gracias por elegirnos!* Antes de iniciar tu pedido, aquí están nuestras políticas de servicio:`;
      await sendWhatsAppWithDelay(phone, policyCopy, POLICY_IMAGE_PATH);
      // Pequeña pausa entre mensajes para que se vean como mensajes separados y naturales
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // 2. A continuación, enviar el desglose formal de cotización como mensaje de texto independiente
    await sendWhatsAppWithDelay(phone, confirmationMsg);

    // El administrador recibe un único aviso incluso cuando una misma
    // solicitud contiene varios diseños: así puede asignarlos sin perder el
    // vínculo entre los pedidos y su factura conjunta.
    await notifyNewOrderBatch({
      clientName,
      phone: cleanPhone || phone,
      items: createdOrderItems,
      total: totalCalculado,
      invoiceId: newInvoiceId
    });

    console.log(`✅ [BUFFER] Pedido(s) (${orderIdsHeader}) enviado(s) a ${phone}.`);

  } catch (error) {
    console.error(`❌ Error al procesar buffer de ${phone}:`, error.message);
  }
}

/**
 * Concatena mensajes y transcribe notas de voz si existen, integrando el historial previo
 */
async function buildCombinedText(messages, historyMessages = []) {
  const parts = [];

  if (historyMessages && historyMessages.length > 0) {
    parts.push('[HISTORIAL PREVIO DE LA CONVERSACIÓN CON ESTE CLIENTE]:');
    for (const hm of historyMessages) {
      if (hm.message_type === 'audio') {
        const audioText = hm.content || '[Nota de voz previa enviada por el cliente]';
        parts.push(`- Cliente (Audio): "${audioText}"`);
      } else if (hm.message_type === 'image' || hm.message_type === 'document') {
        parts.push(`- Cliente: [Insumo / Imagen de referencia enviada previamente: ${hm.content || 'Sin texto'}]`);
      } else if (hm.content) {
        parts.push(`- Cliente: "${hm.content}"`);
      }
    }
    parts.push('\n[MENSAJES NUEVOS A PROCESAR]:');
  }

  let assetCount = 0;
  for (const m of messages) {
    if (m.message_type === 'audio' && m.media_url) {
      console.log(`🎙️ [BUFFER] Transcribiendo nota de voz entrante...`);
      const audioText = await transcribeAudio(m.media_url);
      if (audioText && audioText !== '[Audio no se pudo transcribir]') {
        console.log(`🗣️ [AUDIO] Transcripción lograda: "${audioText}"`);
        parts.push(`[Nota de Voz Transcrita del Cliente]: "${audioText}"`);
        // Guardar transcripción en la BD para enriquecer el historial futuro
        try {
          await query(`UPDATE whatsapp_inbound_buffer SET content = $1 WHERE id = $2`, [audioText, m.id]);
        } catch (e) {}
      } else {
        parts.push(`[Nota de Voz enviada por el cliente]`);
      }
    } else if (m.message_type === 'image' || m.message_type === 'document') {
      assetCount++;
      if (m.content) {
        parts.push(`[Archivo/Imagen #${assetCount} con texto adjunto]: "${m.content}"`);
      } else {
        parts.push(`[Archivo/Imagen de referencia #${assetCount} enviada por el cliente como insumo de diseño]`);
      }
    } else if (m.content) {
      parts.push(m.content);
    }
  }
  return parts.join('\n');
}

/**
 * Marca los IDs del buffer como procesados mediante SQL
 */
async function markBufferProcessed(ids) {
  if (!ids || ids.length === 0) return;
  await query(
    `UPDATE whatsapp_inbound_buffer SET processed = true WHERE id = ANY($1::bigint[])`,
    [ids]
  );
}

/**
 * Activación completa del pedido tras confirmar el pago (50% o 100%).
 *
 * Esta función realiza todo el trabajo de backend para que el pedido aparezca
 * completamente configurado en el panel admin:
 *
 * 1. Obtiene el folderId de Google Drive del pedido.
 * 2. Busca todos los archivos/imágenes que el cliente envió en los últimos 7 días
 *    (logos, referencias, documentos) y los sube a la carpeta Drive del pedido.
 * 3. Actualiza el pedido en PostgreSQL con:
 *    - estado = 'Abonado'
 *    - qc_status = 'pendiente_diseno'
 *    - fecha_entrega_estimada = 3 días hábiles desde hoy
 *    - notas enriquecidas con banco, monto, referencia y archivos subidos
 *
 * Solo se ejecuta cuando Gemini Vision confirma un comprobante válido.
 *
 * @param {Object} params
 * @param {Object} params.order          - Fila del pedido de PostgreSQL (id, tipoDiseno, valor, drive_url)
 * @param {Object} params.paymentAnalysis - Resultado del análisis de Gemini Vision
 * @param {string[]} params.clientPhones  - Lista de JIDs / teléfonos del cliente
 * @param {number[]} params.bufferIds     - IDs del buffer ya procesado (para no volver a subir el comprobante)
 */
async function activateOrderAfterPayment({ order, paymentAnalysis, clientPhones, bufferIds, abonoRegistrado, excludeMessageId, comprobanteUrl }) {
  if (!order || !order.id) return;

  console.log(`🚀 [ACTIVAR] Iniciando activación completa para el pedido ${order.id}...`);

  // ─── 1. Calcular fecha de entrega estimada (3 días hábiles) ─────────────────
  function addBusinessDays(date, days) {
    const result = new Date(date);
    let added = 0;
    while (added < days) {
      result.setDate(result.getDate() + 1);
      const dayOfWeek = result.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) { // No contar sábado ni domingo
        added++;
      }
    }
    return result;
  }
  const fechaEntrega = addBusinessDays(new Date(), 3);
  const fechaEntregaStr = fechaEntrega.toISOString().split('T')[0];

  // ─── 2. Buscar ÚNICAMENTE los archivos que el cliente envió para ESTE pedido ───
  let clientAssets = [];
  try {
    if (bufferIds && bufferIds.length > 0) {
      const assetsRes = await query(
        `SELECT id, message_type, media_url, content, created_at
         FROM whatsapp_inbound_buffer
         WHERE id = ANY($1::bigint[])
           AND (
             (message_type IN ('image', 'document') AND media_url IS NOT NULL AND media_url != '')
             OR (content IS NOT NULL AND content ~* 'https?://')
           )
         ORDER BY created_at ASC`,
        [bufferIds]
      );
      clientAssets = assetsRes.rows || [];
    }
    // Excluir terminantemente la imagen del comprobante de pago para que no vaya a Drive
    if (excludeMessageId) {
      clientAssets = clientAssets.filter(a => String(a.id) !== String(excludeMessageId));
    }
    console.log(`📁 [ACTIVAR] ${clientAssets.length} archivo(s)/insumo(s) legítimo(s) para Drive.`);
  } catch (assetErr) {
    console.warn('⚠️ [ACTIVAR] No se pudo consultar archivos del cliente:', assetErr.message);
  }

  // ─── 3. Carpeta de archivos del pedido en Google Drive ───────────────────────
  let folderId = getFolderIdFromUrl(order.drive_url) || getFolderIdFromUrl(order.driveFolderUrl) || order.driveFolderId;
  let effectiveDriveUrl = order.drive_url || order.driveFolderUrl;

  if (!folderId || folderId.includes('my-drive') || !effectiveDriveUrl || !effectiveDriveUrl.includes('drive.google.com')) {
    try {
      const clientLabel = order.cliente || 'Cliente';
      const folderName = `[${order.id}] - ${order.tipoDiseno || 'Diseño'} - ${clientLabel}`;
      const createdUrl = await createOrderFolder(folderName);
      if (createdUrl && createdUrl.includes('drive.google.com')) {
        effectiveDriveUrl = createdUrl;
        folderId = getFolderIdFromUrl(createdUrl);
      }
    } catch (createErr) {
      console.warn('⚠️ Error al obtener o crear carpeta de Drive en activación:', createErr.message);
    }
  }

  const uploadedFiles = [];
  const clientLinks = [];

  for (const asset of clientAssets) {
    if (asset.content) {
      const urls = asset.content.match(/https?:\/\/[^\s]+/g);
      if (urls) clientLinks.push(...urls);
    }

    if (asset.media_url && asset.media_url.startsWith('data:')) {
      try {
        let ext = 'jpg';
        const mimeMatch = asset.media_url.match(/^data:([^;]+);base64,/);
        if (mimeMatch) {
          const mimeHint = mimeMatch[1];
          const mimeToExt = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
            'image/webp': 'webp', 'application/pdf': 'pdf',
            'application/zip': 'zip'
          };
          ext = mimeToExt[mimeHint] || (asset.message_type === 'document' ? 'pdf' : 'jpg');
        }

        const fileName = `${order.id}_insumo_${uploadedFiles.length + 1}.${ext}`;

        // 1. Subir a Supabase Storage (para previsualización)
        const fileUrl = await uploadBase64ToSupabaseStorage(order.id, fileName, asset.media_url);
        if (fileUrl) {
          uploadedFiles.push({ name: fileName, url: fileUrl });
        }

        // 2. Subir a la carpeta de Google Drive del pedido (para diseñadores)
        if (folderId && folderId !== order.id) {
          const driveFileUrl = await uploadBase64ToFolder(folderId, fileName, asset.media_url);
          if (!driveFileUrl) throw new Error(`Drive no confirmó la carga de ${fileName}`);
        }
      } catch (uploadErr) {
        console.error(`❌ Error procesando archivo de pedido ${order.id}:`, uploadErr.message);
      }
    }
  }

  // ─── 4. Datos de pago estructurados (nunca se escriben en las notas del cliente) ──
  const bancoDetectado = paymentAnalysis?.banco || 'Transferencia';

  // ─── 5. Actualizar el pedido en PostgreSQL con TODAS sus celdas completas ───
  const valorNum = Number(order.valor) || 0;
  const saldoCalculado = Math.max(0, valorNum - Number(abonoRegistrado || 0));
  const costoDisenadorNum = Math.round(valorNum * 0.4);
  const utilidadNum = valorNum - costoDisenadorNum;
  const pagoClienteEstado = (Number(abonoRegistrado) >= valorNum && valorNum > 0) ? 'Pagado' : 'Parcial';
  const firstUploadedImg = uploadedFiles.find(f => f.name.includes('_insumo_'))?.url || uploadedFiles[0]?.url || null;

  try {
    await query(
      `UPDATE orders SET
         estado = 'Abonado',
         abono = $1,
         saldo = $2,
         "metodoPago" = $3,
         "pagoCliente" = $4,
         "confRecepcion" = 'Confirmado',
         qc_status = 'pendiente_diseno',
         drive_url = COALESCE(NULLIF($5, ''), drive_url),
         "driveFolderId" = COALESCE(NULLIF($6, ''), "driveFolderId"),
         "driveFolderUrl" = COALESCE(NULLIF($5, ''), "driveFolderUrl"),
         referencia = COALESCE($7, NULLIF($5, ''), referencia),
         "archivosEnviados" = $8,
         "costoDisenador" = $9,
         utilidad = $10,
         comprobante_url = COALESCE($11, comprobante_url),
         updated_at = NOW()
       WHERE id = $12`,
      [
        abonoRegistrado,
        saldoCalculado,
        bancoDetectado,
        pagoClienteEstado,
        effectiveDriveUrl || '',
        folderId || null,
        firstUploadedImg,
        uploadedFiles.length > 0,
        costoDisenadorNum,
        utilidadNum,
        comprobanteUrl || null,
        order.id
      ]
    );
    // Intentar agregar fecha_entrega_estimada (puede que la columna no exista aún)
    try {
      await query(
        `UPDATE orders SET fecha_entrega_estimada = $1 WHERE id = $2`,
        [fechaEntregaStr, order.id]
      );
    } catch (dateErr) {
      // Si la columna no existe, la creamos y reintentamos
      try {
        await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fecha_entrega_estimada DATE`);
        await query(
          `UPDATE orders SET fecha_entrega_estimada = $1 WHERE id = $2`,
          [fechaEntregaStr, order.id]
        );
      } catch (alterErr) {
        // Silencioso — fecha_entrega no es crítica
      }
    }
    console.log(`✅ [ACTIVAR] Pedido ${order.id} completamente actualizado. Drive: ${effectiveDriveUrl} (ID: ${folderId}), Archivos subidos: ${uploadedFiles.length}`);
  } catch (updateErr) {
    console.error(`❌ [ACTIVAR] Error crítico actualizando pedido ${order.id}:`, updateErr.message);
  }


  console.log(`🎯 [ACTIVAR] Pedido ${order.id} completamente activado. ${uploadedFiles.length} archivo(s) en Drive.`);
  await syncOrderToSupabase(order.id);
}

/**
 * Sincroniza atómicamente un pedido desde Neon PostgreSQL a la API de Supabase
 * para que se refleje de inmediato en el dashboard web en Vercel.
 */
export async function syncOrderToSupabase(orderId) {
  try {
    const res = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!res.rows || res.rows.length === 0) return;
    const row = res.rows[0];

    const supabaseUrl = process.env.SUPABASE_URL || 'https://ygpfvmevizoetnvsxsqu.supabase.co';
    const supabaseKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_f3fibrFoyyjwmAQ1rX1X-Q_UVS3nQtm';

    const orderPayload = {
      id: row.id,
      fecha: row.fecha,
      pedidoNum: row.pedidoNum || row.id,
      cliente: row.cliente,
      razonSocial: row.razonSocial || 'Persona Natural',
      telefono: row.telefono,
      canal: row.canal || 'WhatsApp',
      tipoDiseno: row.tipoDiseno,
      estado: row.estado,
      qc_status: row.qc_status || 'pendiente_diseno',
      referencia: row.referencia,
      drive_url: row.drive_url,
      driveFolderId: row.driveFolderId,
      driveFolderUrl: row.driveFolderUrl,
      ciudad: row.ciudad || 'Sin especificar',
      valor: row.valor != null ? Number(row.valor) : null,
      abono: row.abono != null ? Number(row.abono) : null,
      saldo: row.saldo != null ? Number(row.saldo) : 0,
      pagoCliente: row.pagoCliente || 'Pendiente',
      costoDisenador: row.costoDisenador != null ? Number(row.costoDisenador) : null,
      pagoDisenador: row.pagoDisenador || 'Pendiente',
      costoAsesor: row.costoAsesor != null ? Number(row.costoAsesor) : 0,
      pagoAsesor: row.pagoAsesor || 'Pendiente',
      utilidad: row.utilidad != null ? Number(row.utilidad) : null,
      notes: row.notes,
      archivosEnviados: Boolean(row.archivosEnviados),
      confRecepcion: row.confRecepcion || 'Pendiente',
      comprobante_url: row.comprobante_url || null,
      origen: row.origen || 'whatsapp',
      whatsapp_chat_id: row.whatsapp_chat_id,
      invoice_id: row.invoice_id
    };

    const response = await fetch(`${supabaseUrl}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(orderPayload)
    });

    if (response.ok) {
      console.log(`📡 [Supabase Sync] Pedido ${orderId} sincronizado exitosamente con el dashboard web`);
    } else {
      const errText = await response.text();
      console.warn(`⚠️ [Supabase Sync] Error sincronizando ${orderId}:`, errText);
    }
  } catch (err) {
    console.warn(`⚠️ [Supabase Sync] Excepción al sincronizar pedido:`, err.message);
  }
}

/**
 * Sube un Data URI base64 a Supabase Storage (bucket order-files)
 * Retorna la URL pública permanente del archivo.
 */
export async function uploadBase64ToSupabaseStorage(orderId, fileName, dataUri) {
  try {
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
    if (!matches) return null;
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');

    const supabaseUrl = process.env.SUPABASE_URL || 'https://ygpfvmevizoetnvsxsqu.supabase.co';
    const supabaseKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_f3fibrFoyyjwmAQ1rX1X-Q_UVS3nQtm';

    // Clave limpia sin caracteres conflictivos
    const safeName = fileName.replace(/[[\]]/g, '');
    const storagePath = `${orderId}/${safeName}`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/order-files/${storagePath}`;

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': mimeType,
        'x-upsert': 'true'
      },
      body: buffer
    });

    if (res.ok) {
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/order-files/${storagePath}`;
      return publicUrl;
    } else {
      const errText = await res.text();
      console.warn(`⚠️ [Supabase Storage] Error subiendo ${fileName}:`, errText);
      return null;
    }
  } catch (err) {
    console.error(`❌ [Supabase Storage] Excepción subiendo ${fileName}:`, err.message);
    return null;
  }
}
