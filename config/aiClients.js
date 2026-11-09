import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

export const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || ''
});

export const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY?.trim() || ''
});

export default { groq, genAI };
