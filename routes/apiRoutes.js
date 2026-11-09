import express from 'express';
import { sendSampleToCustomer } from '../controllers/sampleController.js';
import { query } from '../config/db.js';
import { deliverFinalFilesIfReady } from '../controllers/bufferController.js';

const router = express.Router();

// =====================================================
// SALUD Y QR
// =====================================================

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.post('/send-sample', sendSampleToCustomer);

// Reintento administrativo seguro: no entrega nada sin aprobación, pago total
// y presencia de PDF + archivo editable en la carpeta específica del pedido.
router.post('/orders/:id/deliver-final', async (req, res) => {
  try {
    const orderId = String(req.params.id || '').trim().toUpperCase();
    const result = await query(
      `SELECT telefono, whatsapp_chat_id FROM orders WHERE id = $1 LIMIT 1`,
      [orderId]
    );
    const order = result.rows[0];
    const phone = req.body?.phone || order?.telefono || order?.whatsapp_chat_id;
    if (!order || !phone) return res.status(404).json({ error: 'No se encontró un teléfono de WhatsApp para este pedido' });
    const outcome = await deliverFinalFilesIfReady({ orderId, phone });
    return res.json({ success: true, ...outcome });
  } catch (error) {
    console.error('❌ Error al intentar entrega final:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.get('/status-qr', async (req, res) => {
  try {
    const result = await query(`SELECT status, qr_code_base64, updated_at FROM sesion_whatsapp WHERE id = 1 LIMIT 1`);
    if (!result.rows || result.rows.length === 0) {
      return res.json({ status: 'DISCONNECTED', qr_code_base64: null });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =====================================================
// ORDERS - GET, POST, PUT, DELETE
// =====================================================

router.get('/orders', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM orders ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders', async (req, res) => {
  try {
    const o = req.body;
    await query(
      `INSERT INTO orders (id, fecha, "pedidoNum", cliente, "razonSocial", telefono, canal, "tipoDiseno",
        estado, referencia, ciudad, valor, "pagoCliente", disenador, "costoDisenador", "pagoDisenador",
        asesor, "costoAsesor", "pagoAsesor", notes, qc_status, drive_url, origen, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
       ON CONFLICT (id) DO UPDATE SET
         estado = EXCLUDED.estado, valor = EXCLUDED.valor, "pagoCliente" = EXCLUDED."pagoCliente",
         disenador = EXCLUDED.disenador, notes = EXCLUDED.notes, qc_status = EXCLUDED.qc_status`,
      [o.id, o.fecha, o.pedidoNum, o.cliente, o.razonSocial, o.telefono, o.canal, o.tipoDiseno,
       o.estado, o.referencia, o.ciudad, o.valor, o.pagoCliente, o.disenador, o.costoDisenador,
       o.pagoDisenador, o.asesor, o.costoAsesor, o.pagoAsesor, o.notes,
       o.qc_status || 'pendiente_diseno', o.drive_url || null, o.origen || 'portal_cliente']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/orders/:id', async (req, res) => {
  try {
    const o = req.body;
    const { id } = req.params;
    await query(
      `UPDATE orders SET
         fecha=$1, "pedidoNum"=$2, cliente=$3, "razonSocial"=$4, telefono=$5, canal=$6,
         "tipoDiseno"=$7, estado=$8, referencia=$9, ciudad=$10, valor=$11, "pagoCliente"=$12,
         disenador=$13, "costoDisenador"=$14, "pagoDisenador"=$15, asesor=$16, "costoAsesor"=$17,
         "pagoAsesor"=$18, notes=$19, qc_status=$20, drive_url=$21
       WHERE id=$22`,
      [o.fecha, o.pedidoNum, o.cliente, o.razonSocial, o.telefono, o.canal,
       o.tipoDiseno, o.estado, o.referencia, o.ciudad, o.valor, o.pagoCliente,
       o.disenador, o.costoDisenador, o.pagoDisenador, o.asesor, o.costoAsesor,
       o.pagoAsesor, o.notes, o.qc_status || 'pendiente_diseno', o.drive_url || null, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/orders/:id', async (req, res) => {
  try {
    await query(`DELETE FROM orders WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// CLIENTS
// =====================================================

router.get('/clients', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM clients ORDER BY created_at DESC, name ASC`);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

router.post('/clients', async (req, res) => {
  try {
    const { id, name, phone, email } = req.body;
    await query(
      `INSERT INTO clients (id, name, phone, email, created_at) VALUES ($1,$2,$3,$4, NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, email=EXCLUDED.email`,
      [id, name, phone, email]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/clients/:id', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const { id } = req.params;
    await query(
      `UPDATE clients SET name=$1, phone=$2, email=$3 WHERE id=$4`,
      [name, phone, email, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/clients/:id', async (req, res) => {
  try {
    await query(`DELETE FROM clients WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// DESIGNERS
// =====================================================

router.get('/designers', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM designers ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

router.post('/designers', async (req, res) => {
  try {
    const { id, name, email, phone, specialty, photo } = req.body;
    await query(
      `INSERT INTO designers (id, name, email, phone, specialty, photo) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone,
         specialty=EXCLUDED.specialty, photo=EXCLUDED.photo`,
      [id, name, email, phone, specialty, photo]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// ADVISORS
// =====================================================

router.get('/advisors', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM advisors ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

router.post('/advisors', async (req, res) => {
  try {
    const { id, name, email } = req.body;
    await query(
      `INSERT INTO advisors (id, name, email) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email`,
      [id, name, email]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// BUSINESS NAMES (Razones Sociales)
// =====================================================

router.get('/business-names', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM business_names ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

router.post('/business-names', async (req, res) => {
  try {
    const { id, name, clientId } = req.body;
    await query(
      `INSERT INTO business_names (id, name, "clientId") VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, "clientId"=EXCLUDED."clientId"`,
      [id, name, clientId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// DESIGN TYPES
// =====================================================

router.get('/design-types', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM design_types ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

router.post('/design-types', async (req, res) => {
  try {
    const { id, name, duration_hours } = req.body;
    await query(
      `INSERT INTO design_types (id, name, duration_hours) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, duration_hours=EXCLUDED.duration_hours`,
      [id, name, duration_hours]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// TRACKING UNIVERSAL (cliente consulta su pedido)
// =====================================================

router.get('/tracking/:id', async (req, res) => {
  try {
    const cleanId = req.params.id.trim().toUpperCase();
    const orderRes = await query(
      `SELECT id, fecha, "pedidoNum", cliente, "tipoDiseno", estado, qc_status, drive_url, muestra_url, created_at
       FROM orders WHERE id = $1 LIMIT 1`,
      [cleanId]
    );
    if (!orderRes.rows || orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    const revRes = await query(
      `SELECT version, muestra_url, feedback_cliente, feedback_qc, estado, created_at
       FROM revisiones WHERE order_id = $1 ORDER BY created_at DESC`,
      [cleanId]
    );
    return res.json({ order: orderRes.rows[0], revisiones: revRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
