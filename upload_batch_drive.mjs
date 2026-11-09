import dotenv from 'dotenv';
dotenv.config();

import { query } from './config/db.js';
import { uploadFileToFolder } from './services/driveService.js';
import { syncOrderToSupabase } from './controllers/bufferController.js';

async function main() {
  const folderId = '1a6KtW6PaonMw_7mO51eJvEpJ_K-IEO9Y';
  const driveUrl = `https://drive.google.com/drive/folders/${folderId}`;

  const res = await query(`
    SELECT id, message_type, content, media_url 
    FROM whatsapp_inbound_buffer 
    WHERE phone_number LIKE '%118579785658460%' AND message_type = 'image'
    ORDER BY id ASC
  `);

  console.log(`Subiendo ${res.rows.length} imágenes de NG-0180 a Google Drive (Carpeta: ${folderId})...`);
  let count = 0;
  let idx = 1;

  for (const row of res.rows) {
    const dataUri = row.content || row.media_url;
    if (!dataUri || !dataUri.startsWith('data:')) continue;
    const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
    if (!matches) continue;
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const fileName = `NG-0180_ref_${idx}.${ext}`;

    const link = await uploadFileToFolder(folderId, fileName, mimeType, buffer);
    if (link) {
      console.log(`✅ [Drive] ${fileName} subido exitosamente!`);
      count++;
    }
    idx++;
  }

  console.log(`🎉 ¡Total imágenes subidas a la carpeta de Google Drive: ${count}!`);

  await query(`
    UPDATE orders SET
      drive_url = $1,
      "driveFolderUrl" = $1,
      "driveFolderId" = $2
    WHERE id = 'NG-0180'
  `, [driveUrl, folderId]);

  await syncOrderToSupabase('NG-0180');
  console.log('NG-0180 sincronizado.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
