import { GoogleGenAI } from '@google/genai';
import { query } from '../config/db.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __serviceDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__serviceDir, '../.env') });

/**
 * Obtiene y valida la clave de API de Gemini desde el entorno con fallback y registro enmascarado.
 */
function getGeminiApiKey() {
  const rawKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API;
  const apiKey = rawKey?.trim().replace(/^["']|["']$/g, '');
  const masked = apiKey
    ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)} (longitud: ${apiKey.length} caracteres)`
    : 'VACÍA / INDEFINIDA';
  console.log(`🔑 [Gemini Auth] process.env.GEMINI_API_KEY -> ${masked}`);
  return apiKey;
}

/**
 * Consulta el catálogo de precios de PostgreSQL mediante TCP (services_pricing)
 */
async function fetchCatalog() {
  try {
    const res = await query(
      `SELECT categoria, variante_tinta, precio FROM services_pricing WHERE activo = true`
    );

    if (!res.rows || res.rows.length === 0) {
      return 'Catálogo predeterminado: Tarjetas de Presentación 1x0 ($8.000), 2x0 ($10.000), 4x0 ($15.000), 4x4 ($18.000).';
    }

    return res.rows
      .map((item) => `- ${item.categoria} (${item.variante_tinta}): $${item.precio}`)
      .join('\n');
  } catch (err) {
    console.warn('⚠️ No se pudo consultar services_pricing en Postgres TCP, usando fallback:', err.message);
    return 'Catálogo predeterminado: Tarjetas de Presentación 1x0 ($8.000), 2x0 ($10.000), 4x0 ($15.000), 4x4 ($18.000).';
  }
}

/**
 * Ejecuta una llamada a la API de Gemini con manejo robusto de cuota (Error 429 RESOURCE_EXHAUSTED).
 * Aplica reintentos automáticos con pausa exponencial (backoff) y jitter aleatorio.
 */
async function callGeminiWithRetry(callFn, maxRetries = 3, baseDelayMs = 2500) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callFn();
    } catch (err) {
      lastError = err;
      const errorMessage = (err?.message || '').toLowerCase();
      const errorStatus = err?.status || err?.statusCode || 0;

      const isRateLimit =
        errorStatus === 429 ||
        errorMessage.includes('429') ||
        errorMessage.includes('resource_exhausted') ||
        errorMessage.includes('quota') ||
        errorMessage.includes('rate limit');

      const isTransient =
        errorStatus === 503 ||
        errorMessage.includes('overloaded') ||
        errorMessage.includes('unavailable') ||
        errorMessage.includes('timeout');

      if ((isRateLimit || isTransient) && attempt < maxRetries) {
        const delay = Math.round(baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000);
        console.warn(
          `⏳ [Gemini API 429 / Cuota] Límite por minuto alcanzado. Pausando ${(delay / 1000).toFixed(1)}s antes del reintento (${attempt + 1}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

/**
 * Procesa el texto del cliente extrayendo los productos, precios y resumen estructurado.
 * Utiliza reintentos automáticos contra error 429 y fallback dinámico entre modelos.
 */
export async function extractOrderDetails(rawText, activeOrdersContext = '') {
  const catalogStr = await fetchCatalog();
  const apiKey = getGeminiApiKey();

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no está configurada en el entorno');
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Actúa como el agente virtual de atención al cliente, ventas y automatización de "Nextal Graphic", el aliado creativo del sector publicitario en Colombia. Tu tono es profesional, cercano, comercial, fluido y empleas un español natural de Colombia.

REGLA FUNDAMENTAL DEL MODELO DE NEGOCIO (IMPRESCINDIBLE):
Nextal Graphic es un estudio que vende EXCLUSIVAMENTE SERVICIO DE DISEÑO GRÁFICO (archivos editables y artes finales por capas listos para imprenta).
Nextal Graphic NO imprime, NO fabrica y NO instala materiales físicos.
Por lo tanto:
1. El precio NUNCA depende de medidas (centímetros o metros), ni de materiales físicos, ni de instalación.
2. Si el cliente menciona medidas (ej: "172 cm de ancho x 191 cm de alto", "2x1 metros", "tamaño carta"), esas medidas son simplemente las dimensiones en las que el diseñador va a maquetar el archivo digital.
3. TODOS los precios son 100% FIJOS y OBLIGATORIOS según el CATÁLOGO OFICIAL DE PRECIOS. NUNCA pongas precio 0 ni digas "por cotizar". Debes mapear siempre la solicitud directamente al producto correspondiente:
   - Si pide diseño para ventanas, vidrios, vitrinas o locales (con medidas o fotos): mapea DIRECTAMENTE a "Adhesivo" ($15.000 COP). ¡NUNCA preguntes si es microperforado o corte vinilo, porque nosotros solo hacemos el diseño gráfico y su valor fijo es $15.000 COP!
   - Si pide diseño de tarjetas: "Tarjetas de Presentación" (1x0/1x1: $8.000, 2x0/2x1: $10.000, 4x0/4x1: $15.000, 4x4: $18.000).
   - Si pide volantes: "Volantes Publicitarios" (1x0: $10.000, 2x0: $12.000, 4x0: $15.000, 4x4: $25.000).
   - Si pide pendón: "Pendón" ($15.000).
   - Si pide aviso comercial: "Aviso" ($15.000).
   - Si pide logo: "Logo" (1 Propuesta: $70.000, 3 Propuestas: $150.000) o "Redibujo de Logo" ($20.000).
   - Si pide sticker/etiqueta: "Sticker" ($15.000) o "Etiqueta" (1x0: $14.000, 4x0: $20.000).
   - Si pide cualquier otro servicio, consulta el CATÁLOGO OFICIAL y usa el precio exacto de la opción seleccionada.

CATÁLOGO OFICIAL DE PRECIOS (ÚNICA FUENTE DE VERDAD):
${catalogStr}

${activeOrdersContext ? `PEDIDOS ACTIVOS PREVIAMENTE REGISTRADOS PARA ESTE CLIENTE:\n${activeOrdersContext}\n` : ''}

REGLAS CONVERSACIONALES:
1. FLUJO DE SALUDO INICIAL (SIN PRODUCTOS NI PEDIDO):
   Si el cliente solo saluda ("hola", "buenas tardes", "¿cómo están?") sin indicar ninguna necesidad de diseño ni adjuntar imágenes o notas de voz explicativas:
   "productos": []
   "needsClarification": false
   "resumenGeneral": EXACTAMENTE:
   "¡Hola! 👋 Bienvenido a Nextal Graphic, el aliado creativo del sector publicitario.
¿En qué podemos ayudarte hoy? Cuéntanos qué servicio necesitas cotizar."

2. FLUJO DE COTIZACIÓN (CUANDO EL CLIENTE ENVÍA INSUMOS O EXPLICA EL TRABAJO):
   - Si el cliente envía fotos, audios, textos o medidas indicando lo que necesita (ej: diseño para ventana de 172x191 cm, pendón, tarjetas, logo, etc.):
     * "needsClarification": false
     * Extrae los productos para preparar una cotización. Mencionar un producto, solicitar precios o explicar un trabajo NO es confirmación de pedido. El sistema externo solo registra cuando el cliente escribe una aceptación explícita como “Confirmo el pedido”, “Sí lo quiero” o “Hagámoslo”.
     * NO hagas preguntas innecesarias sobre técnicas de impresión ni materiales. Mapea la solicitud directamente al servicio de diseño gráfico correspondiente (ej: ventana -> "Adhesivo", $15.000 COP).
* Si pide 1, 2 o más diseños distintos que necesita juntos, extrae CADA uno como un objeto en "productos".
* Si el cliente está comparando opciones mutuamente excluyentes (por ejemplo, "1x0, 2x0 o 4x0", "A/B/C", "opción X o Y"), incluye cada alternativa como producto, coloca "sonAlternativas": true y "montoTotalCalculado": 0. No sumes alternativas: cada precio corresponde a una opción individual y la aplicación solicitará elegir A/B/C.
     * En "medidas": extrae de forma limpia y puntual las dimensiones solicitadas (ej: "172 cm ancho x 191 cm alto", "2 x 1 m", "9 x 5 cm"). Si no indicó medidas o no aplica, coloca "No especificadas".
     * En "notasDiseno": redacta un resumen claro, limpio y conciso de los requerimientos y especificaciones del diseño indicados por el cliente (ej: "Diseño para vitrina de local comercial. Incluir logo de la empresa y lista de servicios publicitarios."). NUNCA incluyas saludos ni el texto completo del chat.
     * En "descripcionDetallada": redacta un resumen técnico completo y minucioso de lo que el cliente indicó para ese diseño (medidas de maquetación digital como 172 cm ancho x 191 cm alto, fotos de referencia, código de barras, insumos enviados al correo, etc.).
* "montoTotalCalculado": suma exacta únicamente de productos que el cliente quiere juntos. Si "sonAlternativas": true, usa 0.

3. FLUJO DE CLARIFICACIÓN (SOLO CUANDO NO SE TIENE NINGUNA IDEA DE QUÉ SERVICIO REQUIERE):
   - Si el cliente envía una consulta completamente ambigua sin especificar trabajo ni mandar medidas (ej: "hola, cuánto cobran por un trabajo?", "¿qué servicios tienen?"):
     * "productos": []
     * "needsClarification": true
     * "resumenGeneral": Pregunta cordial orientándolo sobre los servicios principales de nuestro catálogo (Tarjetas, Volantes, Adhesivos, Pendones, Logos).

4. Si en la conversación el cliente menciona su nombre o la persona para quien es el trabajo (o si envió un contacto como "Cristina Martínez L"), extráelo en "nombreCliente". Si no se menciona, asigna "Cliente WhatsApp".

5. Extrae "razonSocial" POR SEPARADO cuando el cliente indique el nombre de su empresa, negocio, marca, local o razón social (por ejemplo: "Diseños ACME SAS", "Panadería La 14"). Ese es el valor que aparecerá en el dashboard y en rastreo. No inventes una empresa ni uses el teléfono, un banco o el nombre genérico "Cliente WhatsApp"; si no hay empresa claramente mencionada, devuelve "Persona Natural".

6. DEVUELVE ÚNICAMENTE UN JSON VÁLIDO con esta estructura exacta, sin texto adicional, sin bloques de código Markdown:
{
  "nombreCliente": "string",
  "razonSocial": "string",
  "needsClarification": false,
  "sonAlternativas": false,
  "productos": [
    {
      "tipoDiseno": "string",
      "varianteTinta": "string",
      "medidas": "string (ej: 172 cm ancho x 191 cm alto)",
      "notasDiseno": "string (resumen conciso de requerimientos del diseño)",
      "descripcionDetallada": "string",
      "precioUnitario": 0
    }
  ],
  "montoTotalCalculado": 0,
  "resumenGeneral": "string"
}

MENSAJES Y CONTEXTO DEL CLIENTE:
${rawText}`;

  console.log('🤖 Consultando a Google Gemini estructurado...');

  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-flash-lite-latest',
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
    'gemini-3.7-flash'
  ];
  let response = null;
  let lastError = null;

  for (const model of candidateModels) {
    try {
      response = await callGeminiWithRetry(async () => {
        return await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        });
      }, 3, 2000);

      if (response && response.text) {
        console.log(`✅ Gemini respondió con éxito utilizando el modelo: ${model}`);
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ [Gemini] Modelo ${model} no disponible o agotado temporalmente (${err.message}). Probando alternativo...`);
    }
  }

  // Fallback seguro si la cuota externa de Google está 100% saturada
  if (!response || !response.text) {
    console.error(`❌ [Gemini Quota Fallback] No se pudo obtener respuesta tras reintentos: ${lastError?.message}`);
    return {
      nombreCliente: "Cliente WhatsApp",
      razonSocial: "Persona Natural",
      productos: [],
      montoTotalCalculado: 0,
      needsClarification: true,
      apiOverloaded: true,
      resumenGeneral: null
    };
  }

  try {
    const textResponse = response.text;
    const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (parseErr) {
    console.error('❌ Error parseando JSON de Gemini:', parseErr.message);
    return {
      nombreCliente: "Cliente WhatsApp",
      razonSocial: "Persona Natural",
      productos: [],
      montoTotalCalculado: 0,
      needsClarification: true,
      resumenGeneral: "¡Hola! Para poder armar tu cotización exacta, ¿nos confirmas qué tipo de diseño requieres de nuestro catálogo (adhesivo, pendón, tarjetas, flyer, logo, etc.)?"
    };
  }
}

/**
 * Relaciona cada adjunto con el producto al que pertenece cuando una sola
 * conversación contiene varios pedidos. Gemini ve las referencias y recibe los
 * detalles de cada producto; el fallback conserva el orden de llegada.
 */
export async function assignDesignAssetsToProducts(products, assets) {
  const safeProducts = Array.isArray(products) ? products : [];
  const safeAssets = Array.isArray(assets) ? assets : [];
  const fallback = () => safeAssets.map((_, assetIndex) => ({
    assetIndex,
    productIndex: safeProducts.length ? assetIndex % safeProducts.length : 0
  }));

  if (safeProducts.length <= 1 || safeAssets.length === 0) return fallback();

  const apiKey = getGeminiApiKey();
  if (!apiKey) return fallback();

  const visibleAssets = safeAssets.slice(0, 10);
  const productContext = safeProducts.map((product, index) =>
    `PRODUCTO ${index}: ${product.tipoDiseno || 'Diseño'} | medidas: ${product.medidas || 'No especificadas'} | requisitos: ${product.notasDiseno || product.descripcionDetallada || 'Sin detalles'}`
  ).join('\n');
  const parts = [{
    text: `Eres coordinador de producción gráfica. Relaciona cada ARCHIVO con UN solo producto del pedido al que realmente pertenece. Usa el contenido visual del archivo y su leyenda para decidir. Un comprobante bancario NO pertenece a ningún producto: usa productIndex -1. Si no hay evidencia suficiente, conserva el orden de llegada: archivo 0 con producto 0, archivo 1 con producto 1, y así sucesivamente.\n\n${productContext}\n\nDevuelve únicamente JSON: {"assignments":[{"assetIndex":0,"productIndex":0,"reason":"breve"}]}.`
  }];

  visibleAssets.forEach((asset, index) => {
    const match = typeof asset.media_url === 'string' && asset.media_url.match(/^data:([^;]+);base64,(.+)$/s);
    parts.push({ text: `ARCHIVO ${index}. Leyenda del cliente: ${asset.content || 'Sin leyenda'}` });
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  });

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: [{ role: 'user', parts }],
      config: { temperature: 0, responseMimeType: 'application/json' }
    }), 1, 1000);
    const parsed = JSON.parse(response.text.replace(/```json|```/g, '').trim());
    const valid = (parsed.assignments || []).filter(item =>
      Number.isInteger(item?.assetIndex) && item.assetIndex >= 0 && item.assetIndex < visibleAssets.length &&
      Number.isInteger(item?.productIndex) && item.productIndex >= -1 && item.productIndex < safeProducts.length
    );
    if (valid.length === visibleAssets.length) {
      const extra = safeAssets.slice(visibleAssets.length).map((_, extraIndex) => ({
        assetIndex: visibleAssets.length + extraIndex,
        productIndex: (visibleAssets.length + extraIndex) % safeProducts.length
      }));
      return [...valid, ...extra];
    }
  } catch (err) {
    console.warn(`⚠️ [IA ARCHIVOS] No se pudo clasificar adjuntos por pedido: ${err.message}`);
  }

  return fallback();
}

/**
 * Analiza de forma multimodal una imagen (comprobante de pago bancario)
 * con la capacidad de visión de Gemini y protección ante error 429.
 */
export async function validatePaymentReceipt(imageInput, mimeType = 'image/jpeg', userText = '') {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no está configurada en el entorno');
  }

  let base64Data = '';
  let finalMimeType = mimeType || 'image/jpeg';

  if (Buffer.isBuffer(imageInput)) {
    base64Data = imageInput.toString('base64');
  } else if (typeof imageInput === 'string') {
    if (imageInput.startsWith('data:')) {
      const match = imageInput.match(/^data:([^;]+);base64,(.*)$/);
      if (match) {
        finalMimeType = match[1];
        base64Data = match[2];
      } else {
        base64Data = imageInput;
      }
    } else {
      base64Data = imageInput;
    }
  }

  if (!base64Data) {
    return {
      esComprobanteValido: false,
      banco: '',
      montoDetectado: 0,
      numeroReferencia: '',
      fechaHora: '',
      motivo: 'No se recibió contenido de imagen válido para analizar.'
    };
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Actúa como un auditor bancario y financiero estricto para "Nextal Graphic".
Tu misión es examinar la imagen adjunta para determinar si visualmente corresponde a un COMPROBANTE DE PAGO O TRANSFERENCIA BANCARIA REAL.

CRITERIOS DE APROBACIÓN ("esComprobanteValido": true):
1. La imagen debe ser una captura o fotografía de un comprobante de transferencia bancaria, pasarela de pago o billetera digital reconocida (ej: Bancolombia, Nequi, Daviplata, Dale, Movii, BBVA, Banco de Bogotá, PSE, Transfiya, recibo físico de corresponsal bancario o consignación).
2. REGLA ESPECIAL COMPROBANTES CON QR (NEQUI / DAVIPLATA):
   Los comprobantes digitales oficiales generados por Nequi frecuentemente incluyen en la parte superior un código QR con el texto "Escanea este QR con Nequi para verificar tu envío al instante", seguido de los datos "Para:", "¿Cuánto?:", "Número Nequi:", "Fecha:" y "Referencia:".
   ESTOS COMPROBANTES CON CÓDIGO QR SON 100% VÁLIDOS Y CONFIRMAN UNA TRANSFERENCIA REAL EXITOSA. DEBES CLASIFICARLOS COMO "esComprobanteValido": true.
3. Debe reflejar una transacción exitosa o aprobada (no fallida ni rechazada).
4. Extrae el monto transferido, el banco y el código/número de aprobación o comprobante si es visible.

CRITERIOS DE RECHAZO ("esComprobanteValido": false):
- Si la imagen es una foto de una persona, selfie, meme, paisaje, foto de producto, boceto gráfico o cualquier imagen ajena a un pago financiero.
- Si es un saldo de cuenta sin comprobante de transferencia hacia Nextal Graphic.
- Si la imagen está borrosa, ilegible o parece claramente manipulada.

TEXTO ACOMPAÑANTE ENVIADO POR EL CLIENTE:
"${userText || 'Sin texto adjunto'}"

DEVUELVE ÚNICAMENTE UN JSON VÁLIDO CON ESTA ESTRUCTURA EXACTA (sin bloques de código markdown, sin texto adicional):
{
  "esComprobanteValido": boolean,
  "banco": "string (ej: Bancolombia, Nequi, Daviplata, etc.)",
  "montoDetectado": number,
  "numeroReferencia": "string",
  "fechaHora": "string",
  "motivo": "string (explicación breve y profesional de la evaluación visual)"
}`;

  console.log('🔍 Analizando comprobante con Gemini Multimodal Vision...');

  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-flash-lite-latest',
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash',
    'gemini-3.7-flash'
  ];
  let response = null;
  let lastError = null;

  for (const model of candidateModels) {
    try {
      response = await callGeminiWithRetry(async () => {
        return await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType: finalMimeType,
                    data: base64Data
                  }
                }
              ]
            }
          ],
          config: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        });
      }, 3, 2000);

      if (response && response.text) {
        console.log(`✅ Comprobante evaluado con éxito con el modelo: ${model}`);
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ [Gemini Vision] Modelo ${model} falló (${err.message}). Probando alternativo...`);
    }
  }

  // Fallback si la API de Google Vision está saturada por cuota 429
  if (!response || !response.text) {
    console.error(`❌ [Gemini Vision Quota Fallback] Falló tras reintentos: ${lastError?.message}`);
    return {
      esComprobanteValido: false,
      isApiOverloaded: true,
      banco: "Pendiente de verificación",
      montoDetectado: 0,
      numeroReferencia: "Pendiente",
      fechaHora: new Date().toISOString(),
      motivo: "El servicio de verificación automática está temporalmente ocupado por alta demanda de cuota."
    };
  }

  try {
    const textResponse = response.text;
    const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    // Salvaguarda: si detectó banco conocido (Nequi/Bancolombia/Daviplata), monto > 0 y número de referencia válido, es un comprobante válido
    if (!parsed.esComprobanteValido && parsed.montoDetectado > 0 && parsed.numeroReferencia && parsed.numeroReferencia !== 'Pendiente') {
      const bankLower = (parsed.banco || '').toLowerCase();
      if (bankLower.includes('nequi') || bankLower.includes('bancolombia') || bankLower.includes('daviplata')) {
        console.log(`🛡️ [Vision Safety Rule] Comprobante de ${parsed.banco} por $${parsed.montoDetectado} (Ref: ${parsed.numeroReferencia}) validado por consistencia de datos.`);
        parsed.esComprobanteValido = true;
      }
    }

    return parsed;
  } catch (parseErr) {
    return {
      esComprobanteValido: false,
      banco: "Error de lectura",
      montoDetectado: 0,
      numeroReferencia: "",
      fechaHora: new Date().toISOString(),
      motivo: "No se pudo interpretar el resultado visual del comprobante."
    };
  }
}

/**
 * Evalúa si el mensaje del cliente (texto o nota de voz transcrita) corresponde
 * a observaciones, correcciones, cambios o aprobación sobre un diseño anterior
 * (incluso si nos contestan 2 días después), o si es una nueva solicitud comercial.
 */
export async function detectFeedbackOrAdjustment(rawText, recentOrder) {
  if (!recentOrder || !rawText) return { isFeedback: false };

  const apiKey = getGeminiApiKey();
  if (!apiKey) return { isFeedback: false };

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `Actúa como el supervisor de control de calidad y atención al cliente de "Nextal Graphic".
Tu misión es determinar si el siguiente mensaje de un cliente corresponde a:
1. "cambios": Ajustes, correcciones, modificaciones o cambios a un diseño que ya se le había enviado o estaba en proceso (ej: "para unos cambios del diseño anterior", "cámbiame el color", "quítale esto", "ponle este número", "la foto está al correo", "¿así está bien el diseño?", "mira los cambios").
2. "aprobacion": Aprobación del diseño enviado (ej: "aprobado", "está perfecto", "me gustó", "listo así").
3. "consulta_avance": Pregunta por el estado de su diseño (ej: "¿cómo va mi diseño?", "no me han dado respuesta", "¿cuándo me entregan?").
4. "nuevo_pedido": Si el cliente está solicitando o cotizando un producto NUEVO y diferente (ej: "ahora cotízame unos volantes", "necesito otro diseño de tarjetas").
5. "otro": Saludo genérico o mensaje casual no relacionado.

CONTEXTO DEL PEDIDO ANTERIOR DEL CLIENTE:
- ID: ${recentOrder.id}
- Tipo de Diseño: ${recentOrder.tipoDiseno || 'Diseño Gráfico'}
- Estado actual: ${recentOrder.estado || 'En proceso'} (Fase: ${recentOrder.qc_status || 'pendiente_diseno'})
- Notas registradas: ${(recentOrder.notes || '').substring(0, 200)}

MENSAJE / AUDIO DEL CLIENTE:
"${rawText}"

DEVUELVE ÚNICAMENTE UN JSON VÁLIDO CON ESTA ESTRUCTURA EXACTA (sin bloques de código markdown, sin texto extra):
{
  "isFeedback": boolean,
  "type": "cambios" | "aprobacion" | "consulta_avance" | "nuevo_pedido" | "otro",
  "resumen": "string (resumen muy conciso de los cambios o motivo)"
}`;

  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-flash-lite-latest',
    'gemini-3.8-flash'
  ];

  for (const model of candidateModels) {
    try {
      const response = await callGeminiWithRetry(async () => {
        return await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          }
        });
      }, 2, 1500);

      if (response && response.text) {
        const cleanJson = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson);
      }
    } catch (err) {
      // Intentar con el siguiente modelo
    }
  }

  // Fallback heurístico si no hay conexión con Gemini
  const lower = rawText.toLowerCase();
  const isAprob = lower.includes('aprobado') || lower.includes('apruebo') || lower.includes('está perfecto') || lower.includes('conforme');
  const isCambio = lower.includes('cambio') || lower.includes('ajuste') || lower.includes('modific') || lower.includes('correg') || lower.includes('quitar') || lower.includes('poner') || lower.includes('letra');

  if (isAprob) {
    return { isFeedback: true, type: 'aprobacion', resumen: 'Aprobación del cliente' };
  }
  if (isCambio) {
    return { isFeedback: true, type: 'cambios', resumen: rawText.substring(0, 100) };
  }

  return { isFeedback: false, type: 'otro', resumen: '' };
}
