import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRoutes from './routes/apiRoutes.js';
import { initBaileys } from './services/baileysService.js';
import { processInboundBuffers } from './controllers/bufferController.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Rutas API
app.use('/api', apiRoutes);

// Iniciar Servidor HTTP
app.listen(PORT, async () => {
  console.log(`🚀 Microservicio WhatsApp escuchando en el puerto ${PORT}`);

  // Iniciar servicio Baileys (WhatsApp Web Socket)
  try {
    await initBaileys();
    // baileysService es el único dueño de messages.upsert. Así ningún listener
    // adicional puede bloquear ni duplicar el flujo protegido de Baileys.

    console.log('🔄 Iniciando motor Cron de Debounce (Evaluación cada 30 segundos)...');
    setInterval(async () => {
      await processInboundBuffers();
    }, 30000);

  } catch (error) {
    console.error('❌ Error al iniciar Baileys Service:', error.message);
  }
});
