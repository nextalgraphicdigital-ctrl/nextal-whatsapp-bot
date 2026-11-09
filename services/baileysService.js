import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/db.js';
import { handleInboundMessage } from '../controllers/messageController.js';

// Ruta absoluta para la sesión — garantiza que siempre se encuentre sin importar el cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_FOLDER = path.join(__dirname, '..', 'baileys_auth_info');

let sock = null;
let isInitializing = false;
let reconnectTimer = null;

// El emisor de Baileys no espera las promesas de los listeners. Mantener el
// trabajo de negocio fuera de ese flujo evita que una descarga, la BD o un
// paquete Signal defectuoso bloquee el procesamiento de mensajes posteriores.
let inboundQueue = Promise.resolve();
const INBOUND_PROCESSING_TIMEOUT_MS = 30_000;

const isSignalDecryptError = (error) => {
  const text = String(error?.stack || error?.message || error || '');
  return /bad mac|messagecountererror|key used already|never filled|failed to decrypt|sessionerror/i.test(text);
};

function withTimeout(promise, timeoutMs, description) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${description} superó ${timeoutMs / 1000}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// libsignal 6 imprime estos errores directamente con console.error antes de
// devolver el control a Baileys (que sí los captura). Esto no es una caída,
// pero miles de trazas pueden hacer que la terminal parezca congelada. Se
// suprime solamente ese diagnóstico interno y se conserva un aviso cada 30 s.
const nativeConsoleError = console.error.bind(console);
const nativeConsoleWarn = console.warn.bind(console);
const nativeConsoleInfo = console.info.bind(console);
let lastSignalConsoleNoticeAt = 0;

function installLibsignalConsoleFilter() {
  if (console.error.__nextalLibsignalFilterInstalled) return;

  const isLibsignalSessionDiagnostic = (args) => {
    const text = String(args[0] || '');
    return /closing open session in favor of incoming prekey bundle|closing session:|opening session:|removing old closed session:|migrating session to:/i.test(text);
  };

  const filteredConsoleError = (...args) => {
    const text = args.map(arg => String(arg?.stack || arg?.message || arg || '')).join(' ');
    if (isSignalDecryptError(text) || /failed to decrypt message with any known session/i.test(text)) {
      const now = Date.now();
      if (now - lastSignalConsoleNoticeAt >= 30_000) {
        lastSignalConsoleNoticeAt = now;
        nativeConsoleWarn('⚠️ [Signal] Paquetes no descifrables descartados; conexión y llaves locales se conservan.');
      }
      return;
    }
    nativeConsoleError(...args);
  };

  Object.defineProperty(filteredConsoleError, '__nextalLibsignalFilterInstalled', { value: true });
  console.error = filteredConsoleError;

  // libsignal usa warn/info sin logger configurable y llega a imprimir objetos
  // SessionEntry con material de claves. Son diagnósticos internos, no fallos.
  console.warn = (...args) => {
    if (!isLibsignalSessionDiagnostic(args)) nativeConsoleWarn(...args);
  };
  console.info = (...args) => {
    if (!isLibsignalSessionDiagnostic(args)) nativeConsoleInfo(...args);
  };
}

installLibsignalConsoleFilter();

function enqueueInboundMessage(message, sourceSocket, source) {
  inboundQueue = inboundQueue
    .then(async () => {
      if (!message?.key || message.key.fromMe || !message.message) return;
      await withTimeout(
        handleInboundMessage(message, sourceSocket),
        INBOUND_PROCESSING_TIMEOUT_MS,
        `Procesamiento del mensaje ${message.key.id || 'sin-id'}`
      );
    })
    .catch((error) => {
      const id = message?.key?.id || 'sin-id';
      if (isSignalDecryptError(error)) {
        console.warn(`⚠️ [Signal] Paquete descartado (${source}, ${id}); la sesión se conserva.`);
      } else {
        console.error(`❌ Error aislado procesando mensaje (${source}, ${id}):`, error?.message || error);
      }
    });
}

export function getWASocket() {
  return sock;
}

export function getSocket() {
  return sock;
}

// Cache en memoria para reintentos de descifrado Signal (resuelve Bad MAC / Session Error)
const msgRetryCounterCache = {
  store: new Map(),
  get(key) { return this.store.get(key); },
  set(key, value) { this.store.set(key, value); },
  del(key) { this.store.delete(key); }
};

/**
 * Inicializa la conexión con WhatsApp mediante Baileys y sincroniza el QR con PostgreSQL mediante TCP
 */
export async function initBaileys() {
  if (isInitializing) return sock;
  if (sock?.ws?.isOpen) return sock;
  isInitializing = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

  const nextSocket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    msgRetryCounterCache,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    // Espaciar los reintentos de descifrado Signal para no saturar el bus de mensajes
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 2,
    // getMessage se usa exclusivamente para reenviar mensajes salientes propios.
    // Devolver mensajes entrantes de la BD aquí puede provocar reintentos inválidos.
    getMessage: async () => undefined
  });
  sock = nextSocket;

  nextSocket.ev.on('creds.update', saveCreds);

  nextSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Nuevo Código QR generado por Baileys. Actualizando estado en PostgreSQL...');
      try {
        const qrTerminal = await QRCode.toString(qr, { type: 'terminal', small: true });
        console.log('\n' + qrTerminal + '\n');
        console.log('👆 Escanea el código QR de arriba desde tu WhatsApp (Dispositivos vinculados)');
      } catch (termErr) {
        console.warn('⚠️ No se pudo generar QR en consola:', termErr.message);
      }

      try {
        const qrBase64 = await QRCode.toDataURL(qr);
        await query(
          `INSERT INTO sesion_whatsapp (id, status, qr_code_base64, updated_at)
           VALUES (1, 'QR_READY', $1, NOW())
           ON CONFLICT (id) DO UPDATE SET status = 'QR_READY', qr_code_base64 = $1, updated_at = NOW()`,
          [qrBase64]
        );
      } catch (err) {
        console.error('❌ Error al guardar QR Base64 en DB:', err.message);
      }
    }

    if (connection === 'open') {
      console.log('✅ Conexión con WhatsApp Establecida y Activa');
      try {
        await query(
          `INSERT INTO sesion_whatsapp (id, status, qr_code_base64, updated_at)
           VALUES (1, 'CONNECTED', NULL, NOW())
           ON CONFLICT (id) DO UPDATE SET status = 'CONNECTED', qr_code_base64 = NULL, updated_at = NOW()`
        );
      } catch (err) {
        console.error('❌ Error al actualizar estado CONNECTED en DB:', err.message);
      }
    }

    if (connection === 'close') {
      if (nextSocket !== sock) return; // cierre de un socket anterior
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Conexión cerrada. Razón status: ${statusCode}. Reconectando: ${shouldReconnect}`);

      try {
        await query(
          `INSERT INTO sesion_whatsapp (id, status, updated_at)
           VALUES (1, 'DISCONNECTED', NOW())
           ON CONFLICT (id) DO UPDATE SET status = 'DISCONNECTED', updated_at = NOW()`
        );
      } catch (err) {
        console.error('❌ Error al actualizar estado DISCONNECTED en DB:', err.message);
      }

      if (shouldReconnect) {
        // Una única reconexión evita dos sockets compitiendo por las mismas llaves.
        if (!reconnectTimer) {
          console.log('🔄 Reconectando en 5 segundos...');
          sock = null;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void initBaileys().catch(error => console.error('❌ Error de reconexión:', error.message));
          }, 5000);
        }
      } else {
        // No borrar la sesión automáticamente. Un logout real requiere una acción
        // explícita; un error Signal jamás debe terminar en un QR forzado.
        sock = null;
        console.warn('🚪 Sesión cerrada por WhatsApp. Se conservaron las credenciales; se requiere reautorización explícita.');
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DIAGNÓSTICO GLOBAL: interceptar TODOS los eventos que emite el socket
  // Esto nos permite ver exactamente qué está emitiendo Baileys en tiempo real
  // ─────────────────────────────────────────────────────────────────────────
  nextSocket.ev.process((events) => {
    const evNames = Object.keys(events);
    if (evNames.length > 0) {
      // Filtrar creds.update para no saturar la consola
      const filteredNames = evNames.filter(n => n !== 'creds.update');
      if (filteredNames.length > 0) {
        console.log(`🔔 [EV BATCH]:`, filteredNames.join(' | '));
      }
    }

    // Este callback debe ser síncrono: `ev.process` no espera promesas.
    if (events['messages.upsert']) {
      const { messages, type } = events['messages.upsert'];
      console.log(`📨 [PROCESS] messages.upsert tipo=${type}, count=${messages?.length}`);

      for (const msg of (messages || [])) {
        if (!msg) continue;
        if (msg.key?.fromMe) {
          console.log(`  ↩️ Ignorado (fromMe): ${msg.key?.id}`);
          continue;
        }

        console.log(`  📩 Mensaje de ${msg.key?.remoteJid} [id=${msg.key?.id}]`);
        if (!msg.message || Object.keys(msg.message || {}).length === 0) {
          console.log(`  ℹ️ Mensaje sin payload 'message' (id=${msg.key?.id}, status=${msg.status}, stubType=${msg.messageStubType})`);
        }

        enqueueInboundMessage(msg, nextSocket, 'upsert');
      }
    }

    // Procesar mensajes descifrados o actualizados tras reintento de Baileys
    if (events['messages.update']) {
      for (const item of (events['messages.update'] || [])) {
        if (item.update?.message && !item.key?.fromMe) {
          console.log(`🔓 [DECRYPT-RETRY] Mensaje descifrado exitosamente tras reintento para ${item.key?.remoteJid} [id=${item.key?.id}]`);
          const fullMsg = { key: item.key, message: item.update.message, ...item.update };
          enqueueInboundMessage(fullMsg, nextSocket, 'decrypt-retry');
        }
      }
    }

    // Los paquetes Signal corruptos se registran y se descartan. Nunca se borran
    // session-* ni sender-key-* porque eso agrava la desincronización.
    if (events['messages.decrypt-error']) {
      for (const failedMsg of (events['messages.decrypt-error'] || [])) {
        const remoteJid = failedMsg?.key?.remoteJid || '';
        console.warn(`⚠️ [DECRYPT-ERR] Paquete Signal descartado para ${remoteJid || 'origen desconocido'}; sesión conservada.`);
      }
    }
  });

  // Mantener también ev.on() como respaldo (doble cobertura)
  nextSocket.ev.on('messages.upsert', (upsert) => {
    const { messages, type } = upsert || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) return;
    for (const message of messages) {
      const direction = message?.key?.fromMe ? 'propio (ignorado)' : 'entrante';
      console.log(`📨 [WhatsApp recibido] ${direction}; tipo=${type}; id=${message?.key?.id || 'sin-id'}; chat=${message?.key?.remoteJid || 'sin-chat'}`);
    }
  });

  console.log('✅ [Baileys] Listeners registrados (ev.process + ev.on)');

  return nextSocket;
  } finally {
    isInitializing = false;
  }
}

/**
 * Envía un mensaje por WhatsApp con un delay simulado de comportamiento humano (2-5 segundos)
 * Soporta parámetros individuales o un objeto con { phone, Telephone, telephone, remoteJid, text, mediaUrl }
 */
export async function sendWhatsappWithDelay(phoneOrOptions, textParam, mediaUrlParam = null) {
  if (!sock || sock.ws?.isOpen === false) {
    console.error('❌ No hay conexión activa de Baileys para enviar el mensaje');
    return false;
  }

  // Soporte universal para argumentos posicionales u objeto de opciones
  let targetPhone = phoneOrOptions;
  let text = textParam;
  let mediaUrl = mediaUrlParam;

  if (typeof phoneOrOptions === 'object' && phoneOrOptions !== null) {
    targetPhone = phoneOrOptions.phone ||
                  phoneOrOptions.Telephone ||
                  phoneOrOptions.telephone ||
                  phoneOrOptions.remoteJid ||
                  phoneOrOptions.to ||
                  phoneOrOptions.jid;
    text = phoneOrOptions.text || phoneOrOptions.message || textParam;
    mediaUrl = phoneOrOptions.mediaUrl || phoneOrOptions.imageUrl || mediaUrlParam;
  }

  // Variables normalizadas y con ámbito seguro
  const rawPhone = (targetPhone || '').toString().trim();
  const cleanPhone = rawPhone.replace(/@.*$/, '').replace(/\D/g, '');
  const Telephone = cleanPhone;
  const telephone = cleanPhone;

  // Detección de LID (WhatsApp Linked Device / Privacy ID)
  // Los identificadores LID de WhatsApp tienen 14 o 15 dígitos generados por la red de privacidad de Meta
  const isLid = cleanPhone.length === 15 || (cleanPhone.length === 14 && !cleanPhone.startsWith('49'));

  let jid = rawPhone;
  if (!jid.includes('@')) {
    jid = isLid ? `${cleanPhone}@lid` : `${cleanPhone}@s.whatsapp.net`;
  } else if (isLid && jid.endsWith('@s.whatsapp.net')) {
    console.log(`🔄 [LID Routing] Redirigiendo ${jid} al canal real de privacidad LID: ${cleanPhone}@lid`);
    jid = `${cleanPhone}@lid`;
  }

  // Retraso aleatorio de 2 a 5 segundos (anti-baneo de Meta)
  const delayMs = Math.floor((Math.random() * 3 + 2) * 1000);
  console.log(`⏳ Simulando escritura humana (${(delayMs / 1000).toFixed(1)}s) para ${jid}...`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const sendWithTimeout = (jidToSend, payload) => withTimeout(
    sock.sendMessage(jidToSend, payload),
    25_000,
    `El envío a ${jidToSend}`
  );

  try {
    if (mediaUrl) {
      const imagePayload = Buffer.isBuffer(mediaUrl)
        ? mediaUrl
        : (typeof mediaUrl === 'string' && !mediaUrl.startsWith('http') && fs.existsSync(mediaUrl))
          ? fs.readFileSync(mediaUrl)
          : { url: mediaUrl };

      await sendWithTimeout(jid, {
        image: imagePayload,
        caption: text,
      });
    } else {
      await sendWithTimeout(jid, { text });
    }
    console.log(`✅ Mensaje enviado exitosamente a ${jid}`);
    return true;
  } catch (error) {
    console.error(`❌ Error al enviar mensaje por Baileys a ${jid}:`, error.message);
    // Si falló y era @s.whatsapp.net con dígitos de LID, reintentar con @lid
    if (jid.endsWith('@s.whatsapp.net') && cleanPhone.length >= 14) {
      const lidJid = `${cleanPhone}@lid`;
      try {
        console.log(`🔄 Reintentando envío por canal alternativo LID: ${lidJid}...`);
        if (mediaUrl) {
          const imagePayload = Buffer.isBuffer(mediaUrl)
            ? mediaUrl
            : (typeof mediaUrl === 'string' && !mediaUrl.startsWith('http') && fs.existsSync(mediaUrl))
              ? fs.readFileSync(mediaUrl)
              : { url: mediaUrl };

          await sendWithTimeout(lidJid, { image: imagePayload, caption: text });
        } else {
          await sendWithTimeout(lidJid, { text });
        }
        console.log(`✅ Mensaje enviado exitosamente a ${lidJid}`);
        return true;
      } catch (lidErr) {
        console.error(`❌ Reintento con ${lidJid} falló:`, lidErr.message);
      }
    }
    return false;
  }
}

export const sendWhatsAppWithDelay = sendWhatsappWithDelay;
export { sendWhatsappWithDelay as sendWhatsApp };
