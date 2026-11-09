import { groq } from '../config/aiClients.js';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

function getGeminiClient() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

/**
 * Transcribe un archivo de audio descargado (o URL pública de Supabase Storage)
 * utilizando Groq Whisper o fallback con Google Gemini Multimodal.
 */
export async function transcribeAudio(audioUrlOrBuffer) {
  let tempFilePath = null;
  let base64Data = null;
  let audioBuffer = null;

  try {
    if (typeof audioUrlOrBuffer === 'string' && audioUrlOrBuffer.startsWith('data:')) {
      const commaIdx = audioUrlOrBuffer.indexOf(',');
      base64Data = commaIdx !== -1 ? audioUrlOrBuffer.slice(commaIdx + 1) : audioUrlOrBuffer;
      audioBuffer = Buffer.from(base64Data, 'base64');
    } else if (typeof audioUrlOrBuffer === 'string' && audioUrlOrBuffer.startsWith('http')) {
      // Descargar desde URL pública
      const response = await fetch(audioUrlOrBuffer);
      const arrayBuffer = await response.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuffer);
      base64Data = audioBuffer.toString('base64');
    } else if (Buffer.isBuffer(audioUrlOrBuffer)) {
      audioBuffer = audioUrlOrBuffer;
      base64Data = audioBuffer.toString('base64');
    } else {
      throw new Error('Formato de audio no soportado para transcripción');
    }

    // 1. Intentar con Groq Whisper si la API key está disponible
    if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.startsWith('gsk_')) {
      try {
        tempFilePath = path.join(process.cwd(), `temp_audio_${Date.now()}.ogg`);
        fs.writeFileSync(tempFilePath, audioBuffer);
        const audioStream = fs.createReadStream(tempFilePath);

        console.log('🎙️ Transcribiendo audio con Groq Whisper...');
        const transcription = await groq.audio.transcriptions.create({
          file: audioStream,
          model: 'whisper-large-v3-turbo',
          language: 'es',
          response_format: 'json',
        });

        if (transcription?.text) {
          return transcription.text;
        }
      } catch (groqErr) {
        console.warn('⚠️ Groq Whisper falló (' + groqErr.message + '). Intentando con Gemini Multimodal...');
      }
    }

    // 2. Fallback de alta fidelidad: Gemini Multimodal
    const ai = getGeminiClient();
    if (ai && base64Data) {
      console.log('🎙️ Transcribiendo audio con Google Gemini Multimodal...');
      const candidateModels = ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-flash-latest'];
      for (const model of candidateModels) {
        try {
          const res = await ai.models.generateContent({
            model,
            contents: [
              { text: 'Transcribe de forma literal, precisa y completa esta nota de voz de audio de WhatsApp en español. Devuelve únicamente la transcripción exacta sin comentarios adicionales:' },
              { inlineData: { mimeType: 'audio/ogg', data: base64Data } }
            ]
          });
          const text = (res?.text || '').trim();
          if (text) {
            console.log(`✅ [Audio AI] Audio transcrito exitosamente con ${model}`);
            return text;
          }
        } catch (mErr) {
          console.warn(`⚠️ Error en modelo ${model} para audio:`, mErr.message);
        }
      }
    }

    return '[Audio no se pudo transcribir]';
  } catch (error) {
    console.error('❌ Error en Whisper Transcription:', error.message);
    return '[Audio no se pudo transcribir]';
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        // Ignorar fallo al borrar archivo temporal
      }
    }
  }
}
