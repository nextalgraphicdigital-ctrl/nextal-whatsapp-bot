import { sendWhatsappWithDelay } from '../services/baileysService.js';
import { query } from '../config/db.js';

// Evita dobles clics y peticiones simultáneas para un mismo pedido.
const sendingOrders = new Set();

/**
 * Recibe la solicitud del panel Web cuando el Admin/QC presiona "Aprobar y Enviar"
 * Body: { orderId: "NG-0174", sampleUrl: "https://...", phone: "+57..." }
 */
export async function sendSampleToCustomer(req, res) {
  let orderId, sampleUrl, phone, telephone, Telephone, customNote;
  try {
    ({ orderId, sampleUrl, phone, telephone, Telephone, customNote } = req.body);

    if (!orderId) {
      return res.status(400).json({ error: 'Falta el identificador del pedido' });
    }

    if (sendingOrders.has(orderId)) {
      return res.status(409).json({ error: 'Este pedido ya se está enviando. Espera la confirmación antes de volver a intentarlo.' });
    }
    sendingOrders.add(orderId);

    console.log(`📡 Recibida orden de envío de muestra para ${orderId}`);

    // Consultar información de la orden mediante TCP Postgres
    const orderRes = await query(
      `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );

    const order = orderRes.rows[0];

    if (!order) {
      return res.status(404).json({ error: `Orden ${orderId} no encontrada` });
    }

    // El panel puede enviarlo, pero la fuente principal es siempre el teléfono guardado en el pedido.
    const targetPhone = phone || telephone || Telephone || order.telefono || order.whatsapp_chat_id;
    if (!targetPhone) {
      return res.status(400).json({ error: `El pedido ${orderId} no tiene un teléfono de WhatsApp asociado` });
    }

    // `referencia` es el arte cargado por el diseñador en el panel de revisiones.
    const imageUrl = sampleUrl || order.muestra_url || order.referencia;
    if (!imageUrl) {
      return res.status(400).json({ error: 'No hay una imagen de propuesta para enviar al cliente' });
    }

    const messageText = 
      `🎨 *¡Tu propuesta de diseño está lista!*\n\n` +
      `📌 *Pedido:* ${orderId}\n` +
      `✍️ *Tipo:* ${order.tipoDiseno || order.tipo_diseno || ''}\n` +
      `${customNote ? `\n💬 *Nota del diseñador:* ${customNote}\n` : ''}\n` +
      `Por favor revisa la imagen enviada. Responde *"Aprobado"* si todo está correcto o indícanos qué cambios deseas realizar.\n\n` +
      `✅ Tienes *3 cambios gratuitos*. A partir del *cuarto cambio*, cada ajuste adicional tiene un valor de *$2.000 COP*.`;

    // Enviar por Baileys con delay anti-baneo (2-7 segundos)
    // El envío tiene un límite para que una conexión interrumpida no deje la
    // petición web esperando indefinidamente ni el botón en un estado ambiguo.
    const success = await Promise.race([
      sendWhatsappWithDelay(targetPhone, messageText, imageUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('El envío a WhatsApp excedió 35 segundos. Verifica la conexión del bot.')), 35_000))
    ]);

    if (success) {
      // Actualizar estado en PostgreSQL
      await query(
        `UPDATE orders SET qc_status = 'revision_cliente', muestra_url = $1, updated_at = NOW() WHERE id = $2`,
        [imageUrl, orderId]
      );

      return res.json({ success: true, message: `Muestra enviada exitosamente por WhatsApp a ${targetPhone}` });
    } else {
      return res.status(500).json({ error: 'Fallo al enviar mensaje mediante Baileys' });
    }

  } catch (err) {
    console.error('❌ Error en sendSampleToCustomer:', err.message);
    return res.status(500).json({ error: err.message });
  }
  finally {
    if (orderId) sendingOrders.delete(orderId);
  }
}
