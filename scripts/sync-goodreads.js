// Descarga los feeds RSS públicos de tus estanterías de Goodreads y los
// convierte al mismo formato de datos que usa la app a partir del CSV,
// guardándolos en public/library.json.
//
// Uso:
//   GOODREADS_USER_ID=12345678 node scripts/sync-goodreads.js
//
// Requiere Node.js 18+ (usa el fetch global) y que tu perfil de Goodreads
// sea público. Tu ID de usuario aparece en la URL de tu perfil:
// https://www.goodreads.com/user/show/12345678-tu-nombre

import { parseStringPromise } from "xml2js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const USER_ID = process.env.GOODREADS_USER_ID;
const SHELVES = ["read", "currently-reading", "to-read"];

if (!USER_ID) {
  console.error(
    "Falta GOODREADS_USER_ID. Ejecuta: GOODREADS_USER_ID=tu_id node scripts/sync-goodreads.js"
  );
  process.exit(1);
}

function stripCdata(value) {
  if (typeof value !== "string") return "";
  return value.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

async function fetchShelf(shelf) {
  const url = `https://www.goodreads.com/review/list_rss/${USER_ID}?shelf=${shelf}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; sala-de-lectura-sync/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`No se pudo leer la estantería "${shelf}" (HTTP ${res.status}). Comprueba que tu perfil sea público.`);
  }
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });
  const items = parsed?.rss?.channel?.item;
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];

  return list.map((item) => ({
    Title: stripCdata(item.title),
    Author: stripCdata(item.author_name),
    "My Rating": item.user_rating ? String(item.user_rating) : "0",
    "Exclusive Shelf": shelf,
    "Number of Pages": item.book?.num_pages ? String(item.book.num_pages) : "",
  }));
}

async function main() {
  console.log(`Sincronizando estanterías de Goodreads para el usuario ${USER_ID}…`);
  const results = [];
  for (const shelf of SHELVES) {
    try {
      const books = await fetchShelf(shelf);
      console.log(`  ${shelf}: ${books.length} libros`);
      results.push(...books);
    } catch (err) {
      console.error(`  ${shelf}: ${err.message}`);
    }
  }

  const outDir = path.resolve("public");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "library.json");
  await writeFile(outPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`Guardado ${results.length} libros en ${outPath}`);
  console.log("Refresca la app en el navegador para ver los cambios.");
}

main();
