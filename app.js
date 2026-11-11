// Última barrera: Baileys debe capturar estos errores internamente. Si una
// dependencia deja escapar uno, se registra y se conserva la sesión; nunca se
// borra estado Signal ni se deja que un rechazo no manejado silencie al bot.
const isRecoverableSignalError = (error) => {
  const text = String(error?.stack || error?.message || error || '');
  return /bad mac|messagecountererror|key used already|never filled|failed to decrypt|sessionerror/i.test(text);
};

process.on('unhandledRejection', (reason) => {
  if (isRecoverableSignalError(reason)) {
    console.warn('⚠️ [Signal] Rechazo de descifrado aislado; el servicio continúa.');
    return;
  }
  console.warn('⚠️ [UnhandledRejection capturado]:', reason?.message || String(reason));
});

process.on('uncaughtException', (err) => {
  if (isRecoverableSignalError(err)) {
    console.warn('⚠️ [Signal] Excepción de descifrado aislada; el servicio continúa.');
    return;
  }
  console.error('💥 [UncaughtException capturado]:', err?.message || String(err));
});

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRoutes from './routes/apiRoutes.js';
import { initBaileys } from './services/baileysService.js';
import { processInboundBuffers } from './controllers/bufferController.js';
import { startTelegramControl } from './services/telegramControlService.js';
import { verifyCloudWebhook, receiveCloudWebhook } from './controllers/cloudWebhookController.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
// Conserva el modo anterior si una instalación todavía no configuró Cloud API.
// Las instalaciones nuevas deben usar WHATSAPP_TRANSPORT=cloud en su .env.
const usingCloudApi = String(process.env.WHATSAPP_TRANSPORT || 'baileys').toLowerCase() === 'cloud';

// Middlewares
app.use(cors());
// Conserva el cuerpo exacto para validar la firma de Meta cuando se configure
// WHATSAPP_APP_SECRET. Las demás rutas siguen recibiendo JSON normalmente.
app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer; } }));

// Rutas API
app.use('/api', apiRoutes);
app.get('/webhooks/whatsapp', verifyCloudWebhook);
app.post('/webhooks/whatsapp', receiveCloudWebhook);

// Iniciar Servidor HTTP
const httpServer = app.listen(PORT, async () => {
  console.log(`🚀 Microservicio WhatsApp escuchando en el puerto ${PORT}`);

  // Cloud API recibe mensajes por webhook. Baileys solo se conserva como
  // alternativa local temporal y no debe iniciarse en modo oficial.
  try {
    if (usingCloudApi) {
      console.log('☁️ WhatsApp Cloud API activa. Esperando mensajes en /webhooks/whatsapp');
    } else {
      await initBaileys();
    }
    await startTelegramControl();

    console.log('🔄 Iniciando motor de Debounce / Búfer (Evaluación cada 3 segundos)...');
    setInterval(async () => {
      await processInboundBuffers();
    }, 3000);

  } catch (error) {
    console.error('❌ Error al iniciar el transporte de WhatsApp:', error.message);
  }
});

// Si alguien intenta iniciar una segunda copia, no es un fallo de Baileys ni
// del mensaje entrante: la instancia existente ya es dueña del puerto. Salimos
// limpiamente antes de que esa copia cree listeners o intervalos duplicados.
httpServer.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`⚠️ El bot ya está activo en el puerto ${PORT}. No inicies una segunda instancia.`);
    process.exit(1);
    return;
  }
  console.error('❌ No se pudo iniciar el servidor HTTP:', error?.message || String(error));
  process.exit(1);
});
