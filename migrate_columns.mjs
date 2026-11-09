import { query } from './config/db.js';

async function migrate() {
  try {
    console.log('Updating NG-0016 and fixing null fields...');
    await query(`
      UPDATE orders SET
        "metodoPago" = 'Nequi',
        "costoDisenador" = 6000,
        "costoAsesor" = 0,
        utilidad = 9000,
        "pagoCliente" = 'Pagado',
        "driveFolderId" = '1SbZ9oS4DNgHS5jtMT-3FTgN-ICAzuC4M',
        "driveFolderUrl" = 'https://drive.google.com/drive/folders/1SbZ9oS4DNgHS5jtMT-3FTgN-ICAzuC4M',
        drive_url = 'https://drive.google.com/drive/folders/1SbZ9oS4DNgHS5jtMT-3FTgN-ICAzuC4M',
        referencia = 'https://drive.google.com/drive/folders/1SbZ9oS4DNgHS5jtMT-3FTgN-ICAzuC4M',
        "archivosEnviados" = TRUE
      WHERE id = 'NG-0016'
    `);
    
    await query(`
      UPDATE orders SET
        utilidad = COALESCE(valor, 0) - COALESCE("costoDisenador", 0) - COALESCE("costoAsesor", 0)
      WHERE utilidad IS NULL
    `);
    
    console.log('✅ NG-0016 and utilidades updated successfully!');
    
    const check = await query(`SELECT id, cliente, valor, abono, "metodoPago", "driveFolderId", "archivosEnviados", utilidad FROM orders WHERE id = 'NG-0016'`);
    console.log('NG-0016 current state:\n', check.rows[0]);
  } catch (e) {
    console.error('❌ Error during update:', e);
  }
}

migrate().then(() => process.exit(0));
