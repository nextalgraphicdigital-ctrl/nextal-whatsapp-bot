import { google } from 'googleapis';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

let authClient = null;
let driveClient = null;

export function getGoogleDriveClient() {
  if (driveClient) return driveClient;

  try {
    const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

    if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
      const oauth2Client = new google.auth.OAuth2(
        oauthClientId,
        oauthClientSecret
      );
      oauth2Client.setCredentials({
        refresh_token: oauthRefreshToken
      });
      driveClient = google.drive({ version: 'v3', auth: oauth2Client });
      console.log('✅ Google Drive API autenticado con cuenta de usuario (OAuth2)');
      return driveClient;
    }

    const rawCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!rawCredentials) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no está configurado en .env');
    }

    const credentials = typeof rawCredentials === 'string' 
      ? JSON.parse(rawCredentials) 
      : rawCredentials;

    authClient = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'],
    });

    driveClient = google.drive({ version: 'v3', auth: authClient });
    console.log('✅ Google Drive API autenticado con Service Account');
    return driveClient;
  } catch (error) {
    console.error('❌ ERROR al configurar Google Drive API:', error.message);
    return null;
  }
}
