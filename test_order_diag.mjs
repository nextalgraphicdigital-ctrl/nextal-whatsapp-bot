import { query } from './config/db.js';

async function main() {
  try {
    const o = await query("SELECT * FROM orders WHERE id LIKE '%179%' OR cliente ILIKE '%LUIS%' OR \"razonSocial\" ILIKE '%EDITORIAL%'");
    console.log('SEARCH FOR LUIS / EDITORIAL / 179 IN orders:\n', o.rows);
  } catch (e) {
    console.error(e);
  }
}
main().then(() => process.exit(0));
