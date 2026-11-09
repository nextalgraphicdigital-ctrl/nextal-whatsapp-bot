import { getGoogleDriveClient } from '../config/googleDrive.js';
import { Readable } from 'stream';

const PARENT_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID;

/**
 * Extrae el folderId de un enlace de Google Drive.
 * Soporta formatos:
 *   - https://drive.google.com/drive/folders/FOLDER_ID
 *   - https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
 *   - https://drive.google.com/open?id=FOLDER_ID
 */
export function getFolderIdFromUrl(driveUrl) {
  if (!driveUrl) return null;
  try {
    // Formato /folders/ID
    const foldersMatch = driveUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (foldersMatch) return foldersMatch[1];
    // Formato ?id=ID o &id=ID
    const idMatch = driveUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) return idMatch[1];
  } catch (e) {}
  return null;
}

/**
 * Convierte un Data URI base64 (ej: "data:image/jpeg;base64,/9j/4AAQ...")
 * en un Buffer y lo sube directamente a la carpeta de Drive indicada.
 * Retorna la URL pública del archivo subido, o null si falla.
 */
export async function uploadBase64ToFolder(folderId, fileName, dataUri) {
  if (!folderId || !dataUri) return null;
  try {
    // Separar el header del contenido base64
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
    if (!matches) {
      console.warn(`⚠️ [Drive] Data URI inválido para ${fileName}`);
      return null;
    }
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    return await uploadFileToFolder(folderId, fileName, mimeType, buffer);
  } catch (e) {
    console.error(`❌ [Drive] Error subiendo ${fileName}:`, e.message);
    return null;
  }
}

/**
 * Crea una subcarpeta en Google Drive dentro del PARENT_DRIVE_FOLDER_ID
 * Retorna la URL pública/compartida de la carpeta.
 */
export async function createOrderFolder(folderName) {
  const drive = getGoogleDriveClient();
  if (!drive) {
    console.warn('⚠️ Google Drive no configurado. Retornando URL vacía.');
    return 'https://drive.google.com/drive/my-drive';
  }

  try {
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: PARENT_DRIVE_FOLDER_ID ? [PARENT_DRIVE_FOLDER_ID] : [],
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });

    // Otorgar permisos de lectura/escritura pública al enlace
    try {
      await drive.permissions.create({
        fileId: response.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      });
    } catch (permErr) {
      console.warn('Permisos de Drive warning:', permErr.message);
    }

    console.log(`📁 Carpeta creada en Google Drive: ${folderName} -> ${response.data.webViewLink}`);
    return response.data.webViewLink;
  } catch (error) {
    console.error('❌ Error al crear carpeta en Google Drive:', error.message);
    return 'https://drive.google.com/drive/my-drive';
  }
}

/**
 * Sube un buffer de archivo (foto, documento, referencia) a una carpeta de Google Drive.
 */
export async function uploadFileToFolder(folderId, fileName, mimeType, buffer) {
  const drive = getGoogleDriveClient();
  if (!drive) return null;

  try {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType: mimeType || 'application/octet-stream',
      body: stream,
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });

    return file.data.webViewLink;
  } catch (error) {
    if (error.message?.includes('storage quota') || error.message?.includes('Service Accounts do not have storage')) {
      console.warn(`⚠️ [Google Drive] No se pudo subir ${fileName} por límite de cuota de Service Account. Se requiere OAuth de usuario.`);
    } else {
      console.error(`❌ Error al subir archivo ${fileName} a Drive:`, error.message);
    }
    return null;
  }
}

/**
 * Comprueba que la carpeta del pedido realmente contiene los entregables
 * finales antes de compartirla con el cliente.
 */
export async function getFinalDeliverables(folderId) {
  if (!folderId) return { pdf: [], editable: [], files: [] };
  const drive = getGoogleDriveClient();
  if (!drive) return { pdf: [], editable: [], files: [] };

  try {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,webViewLink,webContentLink)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    const files = response.data.files || [];
    const pdf = files.filter(file => /\.pdf$/i.test(file.name || '') || file.mimeType === 'application/pdf');
    const editable = files.filter(file =>
      /\.(ai|psd|cdr|svg|eps|indd|afdesign|zip|rar)$/i.test(file.name || '')
    );
    return { pdf, editable, files };
  } catch (error) {
    console.warn('⚠️ [Drive] No se pudieron verificar los entregables finales:', error.message);
    return { pdf: [], editable: [], files: [] };
  }
}
