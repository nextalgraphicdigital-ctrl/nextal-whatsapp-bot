import { google } from 'googleapis';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const envPath = path.resolve('c:/Users/richa/OneDrive/Desktop/Proyectos Zentry/Nextal Graphic interno/Nextal Graphic - Interno 2/whatsapp-service/.env');
dotenv.config({ path: envPath });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('\n======================================================');
  console.log('   CONFIGURACIÓN GOOGLE DRIVE OAUTH (CUOTA REAL)      ');
  console.log('======================================================\n');
  console.log('Para que Google Drive permita subir archivos sin error de cuota');
  console.log('necesitamos conectar tu cuenta nextalgraphicdigital@gmail.com.\n');

  let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId) {
    clientId = await question('Pega tu GOOGLE_OAUTH_CLIENT_ID: ');
  }
  if (!clientSecret) {
    clientSecret = await question('Pega tu GOOGLE_OAUTH_CLIENT_SECRET: ');
  }

  clientId = clientId.trim();
  clientSecret = clientSecret.trim();

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'http://localhost:3000/oauth2callback'
  );

  const scopes = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  console.log('\n1. Abre este enlace en tu navegador:');
  console.log('------------------------------------------------------');
  console.log(authUrl);
  console.log('------------------------------------------------------\n');
  console.log('2. Inicia sesión con nextalgraphicdigital@gmail.com y permite el acceso.');
  console.log('3. Al dar clic en Permitir, el navegador te redirigirá a una URL como:');
  console.log('   http://localhost:3000/oauth2callback?code=4/0A... (aunque diga página no encontrada)');
  console.log('4. Copia el parámetro "code" o la URL completa de la barra de direcciones.\n');

  let rawCode = await question('Pega el código o la URL completa aquí: ');
  rl.close();

  rawCode = rawCode.trim();
  let code = rawCode;
  if (rawCode.includes('code=')) {
    const urlParams = new URL(rawCode.startsWith('http') ? rawCode : `http://localhost/${rawCode}`).searchParams;
    code = urlParams.get('code') || rawCode;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('\n✅ ¡Tokens de Google Drive obtenidos con éxito!');
    console.log('Refresh Token:', tokens.refresh_token ? 'OK (Obtenido)' : 'Ya configurado');

    // Actualizar .env
    let envContent = fs.readFileSync(envPath, 'utf8');

    function updateOrAppend(key, val) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${val}`);
      } else {
        envContent += `\n${key}=${val}`;
      }
    }

    updateOrAppend('GOOGLE_OAUTH_CLIENT_ID', clientId);
    updateOrAppend('GOOGLE_OAUTH_CLIENT_SECRET', clientSecret);
    if (tokens.refresh_token) {
      updateOrAppend('GOOGLE_OAUTH_REFRESH_TOKEN', tokens.refresh_token);
    }

    fs.writeFileSync(envPath, envContent, 'utf8');

    // Copiar también a Desktop
    const desktopEnv = 'C:/Users/richa/Desktop/Proyectos Zentry/Nextal Graphic interno/Nextal Graphic - Interno 2/whatsapp-service/.env';
    if (fs.existsSync(desktopEnv)) {
      fs.writeFileSync(desktopEnv, envContent, 'utf8');
    }

    console.log('✅ Archivo .env actualizado en OneDrive y Desktop.');
    console.log('🎉 ¡Listo! Ahora Google Drive podrá crear carpetas Y subir todos los archivos sin límite ni errores.');
  } catch (err) {
    console.error('❌ Error al obtener token de Google:', err.message);
  }
}

main();
