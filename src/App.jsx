import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import {
  BookOpen, Upload, X, ChevronDown, Check, RotateCcw,
  Bookmark, BookmarkCheck, ExternalLink, Trash2, RefreshCw,
} from "lucide-react";

// Síntesis de tus estilos favoritos: acuarela + escandinavo + cottagecore +
// mediterráneo + art decó + terracota, con fondo muy claro.
const PALETTE = {
  bg: "#FDFBF3",
  sage: "#B0BA99",
  sageWash: "#E4E8D9",
  terracotta: "#B5734A",
  terracottaDeep: "#8F4A28",
  ink: "#4E220F",
  inkSoft: "#6E5344",
  white: "#FFFFFF",
};

const STORAGE_KEY = "next-read-lab:analysis";
const SAVED_KEY = "next-read-lab:saved";
const DISMISSED_KEY = "next-read-lab:dismissed";
const AVOIDED_GENRES_KEY = "next-read-lab:avoided-genres";
const GOODREADS_USER_KEY = "next-read-lab:goodreads-user-id";
const LAST_IDENTITY_KEY = "next-read-lab:last-identity";
const LIBRARY_BOOKS_KEY = "next-read-lab:library-books";
// Cada persona que usa la app en este mismo ordenador (una cuenta de Goodreads
// conectada, o un csv con un nombre de archivo distinto) tiene su propia
// "identidad": sus guardados, descartados y análisis se guardan bajo una
// clave propia, para que no se mezclen entre sí.
function scopedKey(base, identityKey) {
  return `${base}::${identityKey || "sin-identidad"}`;
}

const GOODREADS_SHELVES = ["read", "currently-reading", "to-read"];

// Goodreads no permite leer su feed RSS directamente desde el navegador
// (no envía las cabeceras CORS necesarias), así que lo pedimos a través de
// un proxy público que sí las añade. Ninguno de estos servicios gratuitos
// garantiza un tiempo de actividad del 100%, así que probamos varios en
// orden: si el primero falla o no responde, seguimos con el siguiente antes
// de dar el conjunto por fallido. (corsproxy.io quedó fuera de esta lista
// porque ahora exige registro y clave de API incluso en su plan gratuito).
const CORS_PROXIES = [
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

function parseGoodreadsRssXml(xmlText, shelf) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  if (doc.querySelector("parsererror")) return null;
  if (!doc.querySelector("rss, channel")) return null;
  return Array.from(doc.querySelectorAll("item")).map((item) => {
    const text = (selector) => item.querySelector(selector)?.textContent?.trim() || "";
    return {
      Title: text("title"),
      Author: text("author_name"),
      "My Rating": text("user_rating") || "0",
      "Exclusive Shelf": shelf,
      "Number of Pages": text("book num_pages") || text("num_pages") || "",
    };
  });
}
// Tu propio proxy (un Cloudflare Worker que tú controlas — ver README,
// "Tu propio proxy con Cloudflare Workers"). Si lo configuras, se usa
// siempre primero, por ser el más fiable; si no lo configuras, la app
// sigue funcionando con los proxies públicos de abajo como única vía.
const OWN_PROXY_URL = import.meta.env.VITE_GOODREADS_PROXY_URL || "";

// Cada intento fallido queda anotado ({ via, kind, status }) para que
// connectGoodreadsAccount pueda explicar al usuario qué ha pasado.
class ShelfFetchError extends Error {
  constructor(message, attempts) {
    super(message);
    this.attempts = attempts;
  }
}

let warnedMissingOwnProxy = false;

async function fetchGoodreadsShelf(userId, shelf) {
  const goodreadsUrl = `https://www.goodreads.com/review/list_rss/${userId}?shelf=${shelf}`;
  const attempts = [];

  if (OWN_PROXY_URL) {
    const ownUrl = `${OWN_PROXY_URL}?userId=${encodeURIComponent(userId)}&shelf=${encodeURIComponent(shelf)}`;
    // Los fallos de tu proxy se avisan en la consola: un 200 con algo que no
    // es RSS no deja ningún otro rastro y el flujo pasaría a los públicos sin más.
    try {
      const r = await fetch(ownUrl);
      if (r.ok) {
        const xmlText = await r.text();
        const rows = parseGoodreadsRssXml(xmlText, shelf);
        if (rows !== null) return rows;
        attempts.push({ via: "own", kind: "format" });
        console.warn(`[Goodreads] Tu proxy respondió ${r.status}, pero no con el RSS de Goodreads (${ownUrl}). La respuesta empieza así:`, xmlText.slice(0, 300));
      } else {
        attempts.push({ via: "own", kind: "http", status: r.status });
        console.warn(`[Goodreads] Tu proxy respondió con un error ${r.status} (${ownUrl}).`);
      }
    } catch (e) {
      attempts.push({ via: "own", kind: "network" });
      console.warn(`[Goodreads] No se pudo contactar con tu proxy (${ownUrl}): ${e.message}`);
    }
  } else if (!warnedMissingOwnProxy) {
    warnedMissingOwnProxy = true;
    console.warn("[Goodreads] Este build no tiene VITE_GOODREADS_PROXY_URL: solo se usan los proxies públicos.");
  }

  for (const buildProxyUrl of CORS_PROXIES) {
    const url = buildProxyUrl(goodreadsUrl);
    try {
      const r = await fetch(url);
      if (!r.ok) {
        attempts.push({ via: new URL(url).host, kind: "http", status: r.status });
        continue;
      }
      const xmlText = await r.text();
      const rows = parseGoodreadsRssXml(xmlText, shelf);
      if (rows === null) {
        attempts.push({ via: new URL(url).host, kind: "format" });
        continue;
      }
      return rows;
    } catch {
      attempts.push({ via: new URL(url).host, kind: "network" });
      // seguimos con el siguiente proxy de la lista
    }
  }
  throw new ShelfFetchError(`No se pudo leer la estantería "${shelf}".`, attempts);
}

// Un fallo es "del servicio" cuando no hubo respuesta o el intermediario
// respondió con un error suyo (5xx, 429 por exceso de peticiones, los 52x de
// Cloudflare). Un 404 o una respuesta que no es RSS pueden venir de Goodreads
// (número de usuario mal escrito, perfil privado), así que no los contamos.
function isServiceFailure(attempt) {
  return attempt.kind === "network" || (attempt.kind === "http" && (attempt.status >= 500 || attempt.status === 429));
}

// Conecta con la cuenta de Goodreads directamente desde el navegador: sin
// terminal, sin instalar nada. Lanza un error legible si algo falla, para
// mostrarlo tal cual al usuario.
async function connectGoodreadsAccount(userId) {
  const cleanId = userId.trim();
  if (!/^\d+$/.test(cleanId)) {
    throw new Error("Ese no parece un ID de Goodreads válido. Debe ser solo números (lo encuentras en la URL de tu perfil).");
  }
  const results = [];
  const failures = [];
  let anySucceeded = false;
  for (const shelf of GOODREADS_SHELVES) {
    try {
      const rows = await fetchGoodreadsShelf(cleanId, shelf);
      results.push(...rows);
      anySucceeded = true;
    } catch (e) {
      failures.push(e);
      // seguimos con las demás estanterías aunque una falle
    }
    await sleep(300);
  }
  if (!anySucceeded) {
    const attempts = failures.flatMap((e) => e.attempts || []);
    if (attempts.length && attempts.every(isServiceFailure)) {
      throw new Error("Ahora mismo no consigo llegar a Goodreads: los servicios que uso para leer tu perfil no responden. No es un problema de tu cuenta. Prueba de nuevo en un rato o, mientras tanto, sube el CSV de tu biblioteca, que no depende de ellos.");
    }
    throw new Error("No he podido leer tu Goodreads. Comprueba que el número de usuario es correcto y que tu perfil es público (Settings → Profile). Si todo está bien, puede que el servicio que uso para leerlo esté fallando: prueba más tarde o sube el CSV de tu biblioteca.");
  }
  if (!results.length) {
    throw new Error("Me he conectado, pero no he encontrado ningún libro en tus estanterías. Comprueba que tienes libros marcados como leídos en Goodreads.");
  }
  return results;
}

function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-záéíóúñü0-9\s]/gi, "")
    .trim();
}

function parseGoodreadsCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: reject,
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Clave opcional de Google Books (ver README: "Evitar el error 429"). Sin
// ella, el límite de peticiones sin autenticar es muy bajo y se agota rápido
// entre varias pruebas; con ella, sube considerablemente.
const GOOGLE_BOOKS_API_KEY = import.meta.env.VITE_GOOGLE_BOOKS_API_KEY || "";

function withKey(url) {
  return GOOGLE_BOOKS_API_KEY ? `${url}&key=${GOOGLE_BOOKS_API_KEY}` : url;
}

// Esto ejecuta las llamadas de una en una (con una pausa entre cada una) en
// vez de lanzarlas todas a la vez, y reintenta con espera creciente si
// Google responde con un 429 (demasiadas peticiones).
async function fetchWithRetry(url, { retries = 4, baseDelay = 1200 } = {}) {
  // 429 = demasiadas peticiones; 500/502/503/504 = fallos pasajeros del
  // propio servidor de Google, no relacionados con tu clave ni tu código.
  const transientStatuses = [429, 500, 502, 503, 504];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(withKey(url));
    if (!transientStatuses.includes(r.status)) return r;
    await sleep(baseDelay * (attempt + 1));
  }
  return fetch(withKey(url));
}

async function runSequentially(items, worker, delayMs = 400) {
  const results = [];
  for (const item of items) {
    results.push(await worker(item));
    await sleep(delayMs);
  }
  return results;
}

async function fetchVolumeInfo(title, author) {
  const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
  try {
    const r = await fetchWithRetry(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`);
    if (!r.ok) return null;
    const data = await r.json();
    const item = data.items?.[0];
    if (!item) return null;
    return { categories: item.volumeInfo.categories || [], language: item.volumeInfo.language || null };
  } catch {
    return null;
  }
}

function extractIsbn13(item) {
  const ids = item.volumeInfo?.industryIdentifiers || [];
  const isbn13 = ids.find((i) => i.type === "ISBN_13")?.identifier;
  const isbn10 = ids.find((i) => i.type === "ISBN_10")?.identifier;
  return isbn13 || isbn10 || null;
}

async function searchCandidates(query) {
  const q = encodeURIComponent(query);
  try {
    const r = await fetchWithRetry(
      `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=16&langRestrict=es&printType=books`
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data.items || [])
      .filter((item) => item.volumeInfo?.title)
      .map((item) => ({
        id: item.id,
        title: item.volumeInfo.title,
        authors: item.volumeInfo.authors || [],
        categories: item.volumeInfo.categories || [],
        averageRating: item.volumeInfo.averageRating || 0,
        ratingsCount: item.volumeInfo.ratingsCount || 0,
        thumbnail: (item.volumeInfo.imageLinks?.thumbnail || "").replace("http://", "https://"),
        infoLink: item.volumeInfo.infoLink || null,
        description: item.volumeInfo.description || "",
        language: item.volumeInfo.language || null,
        publisher: item.volumeInfo.publisher || null,
        publishedDate: item.volumeInfo.publishedDate || null,
        isbn: extractIsbn13(item),
      }));
  } catch {
    return [];
  }
}

// Editoriales que, en el mercado español, funcionan como referencia habitual
// para la literatura traducida de cada idioma de origen. Esto es un criterio
// editorial general nuestro (reputación de catálogo), no una garantía de que
// esa traducción concreta sea mejor que otra — se lo decimos así al usuario.
const PUBLISHER_REPUTATION = {
  de: [
    { match: /acantilado/i, note: "Acantilado es la editorial de referencia para literatura en alemán en el mercado español (Zweig, Roth, Kafka...)." },
    { match: /anagrama/i, note: "Anagrama tiene un catálogo consolidado de narrativa centroeuropea traducida." },
  ],
  fr: [
    { match: /anagrama/i, note: "Anagrama es una referencia habitual para narrativa francesa contemporánea en español." },
    { match: /alfaguara/i, note: "Alfaguara publica gran parte de la narrativa francesa comercial traducida al español." },
  ],
  it: [
    { match: /anagrama/i, note: "Anagrama tiene un catálogo consolidado de narrativa italiana traducida." },
    { match: /lumen/i, note: "Lumen es la editorial histórica de referencia para varios clásicos italianos en español (como Umberto Eco)." },
  ],
  en: [
    { match: /alba/i, note: "Alba Editorial es una referencia habitual para clásicos de literatura anglosajona, con ediciones cuidadas y anotadas." },
    { match: /penguin/i, note: "Penguin Clásicos es una de las colecciones más consolidadas para clásicos en lengua inglesa." },
    { match: /alianza/i, note: "Alianza Editorial tiene un catálogo extenso y asequible de clásicos anglosajones." },
    { match: /duomo/i, note: "Duomo es una editorial habitual para ficción contemporánea anglosajona traducida." },
  ],
  ru: [
    { match: /alba/i, note: "Alba Editorial cuenta con ediciones cuidadas de varios clásicos rusos." },
    { match: /alianza/i, note: "Alianza Editorial tiene un catálogo extenso de clásicos rusos traducidos." },
  ],
};

function getPublisherNote(language, publisher) {
  if (!language || !publisher) return null;
  const entries = PUBLISHER_REPUTATION[language];
  if (!entries) return null;
  const match = entries.find((e) => e.match.test(publisher));
  return match ? match.note : null;
}

// Open Library a veces recoge el nombre del traductor en el campo "by_statement"
// o "contributions" de una edición concreta (buscada por ISBN). No todas las
// ediciones lo tienen catalogado, y esta API puede fallar por CORS según el
// endpoint, así que cualquier fallo aquí se trata como "no encontrado", nunca
// como un error que rompa el resto de la ficha.
async function fetchTranslatorFromOpenLibrary(isbn) {
  if (!isbn) return null;
  try {
    const r = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`
    );
    if (!r.ok) return null;
    const data = await r.json();
    const entry = data[`ISBN:${isbn}`];
    if (!entry) return null;
    const candidates = [
      ...(entry.contributions || []),
      entry.by_statement || "",
    ].join(" | ");
    const match = candidates.match(/(?:traduc\w*|translat\w*)[^a-zA-Z]*(?:de|by|por)?\s*:?\s*([A-ZÁÉÍÓÚÑ][\wÀ-ÿ'’.-]+(?:\s+[A-ZÁÉÍÓÚÑ][\wÀ-ÿ'’.-]+){0,3})/i);
    if (match) return match[1].trim();
    return null;
  } catch {
    return null;
  }
}

// Busca específicamente una edición en español para mostrar en "mejor edición"
async function fetchSpanishEdition(title, author) {
  const q = encodeURIComponent(`intitle:${title} inauthor:${author}`);
  try {
    const r = await fetchWithRetry(
      `https://www.googleapis.com/books/v1/volumes?q=${q}&langRestrict=es&maxResults=5&printType=books`
    );
    if (!r.ok) return null;
    const data = await r.json();
    const items = data.items || [];
    // Preferimos, en este orden: una editorial de referencia conocida para el
    // idioma original, cualquier edición con editorial identificada, o la
    // primera disponible.
    const withPublisher = items.filter((it) => it.volumeInfo?.publisher);
    const item = withPublisher[0] || items[0];
    if (!item) return null;
    return {
      publisher: item.volumeInfo.publisher || null,
      publishedDate: item.volumeInfo.publishedDate || null,
      thumbnail: (item.volumeInfo.imageLinks?.thumbnail || "").replace("http://", "https://"),
      infoLink: item.volumeInfo.infoLink || null,
      isbn: extractIsbn13(item),
      candidateCount: withPublisher.length,
    };
  } catch {
    return null;
  }
}

// Google Books devuelve las categorías en inglés. Las traducimos, y guardamos
// también su artículo para que las frases concuerden ("tu gusto por la novela
// histórica", "tu gusto por el humor").
const GENRE_ES = {
  "Fiction": ["ficción", "la"],
  "Literary": ["ficción literaria", "la"],
  "Literary Fiction": ["ficción literaria", "la"],
  "Historical": ["novela histórica", "la"],
  "Psychological": ["novela psicológica", "la"],
  "Biography & Autobiography": ["memorias", "las"],
  "History": ["ensayo histórico", "el"],
  "Books & Reading": ["libros sobre libros", "los"],
  "Humor": ["humor", "el"],
  "Dystopian": ["distopía", "la"],
  "Fantasy": ["fantasía", "la"],
  "Science Fiction": ["ciencia ficción", "la"],
  "Romance": ["novela romántica", "la"],
  "Mystery": ["misterio", "el"],
  "Thrillers": ["thriller", "el"],
  "Crime": ["novela negra", "la"],
  "Poetry": ["poesía", "la"],
  "Philosophy": ["filosofía", "la"],
  "Psychology": ["psicología", "la"],
  "Travel": ["libros de viajes", "los"],
  "Short Stories": ["relato", "el"],
  "Classics": ["clásicos", "los"],
  "Young Adult Fiction": ["juvenil", "lo"],
  "Literary Collections": ["antologías", "las"],
  "Family Life": ["novela familiar", "la"],
};
// "Fiction" a secas no dice nada: todas las novelas lo son.
const isGenericGenre = (g) => g === "Fiction";

function genreEs(g) {
  return GENRE_ES[g?.trim()]?.[0] || (g || "").toLowerCase();
}
function genreArticle(g) {
  return GENRE_ES[g?.trim()]?.[1] || "lo";
}
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function formatDecimal(n) {
  return n.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
// Elige una variante de frase según el libro: siempre la misma para el mismo
// libro, pero distinta entre libros, para que la lista no repita un molde.
function variantFor(id, options) {
  const hash = [...String(id)].reduce((h, c) => h + c.charCodeAt(0), 0);
  return options[hash % options.length];
}
// "A, B y C", con "e" delante de las palabras que empiezan por el sonido /i/ ("y Kazuo", "e Isabel")
function joinEs(items) {
  if (items.length < 2) return items;
  const last = items[items.length - 1];
  const lastText = typeof last === "string" ? last : last.props.children;
  const conjunction = /^h?i(?![aeiouáéó])/i.test(lastText) ? " e " : " y ";
  return items.slice(0, -1).flatMap((it, i) => (i === 0 ? [it] : [", ", it])).concat([conjunction, last]);
}

function ProfileSentence({ profile }) {
  const authors = profile.topAuthors.slice(0, 2);
  const genres = profile.topGenres.filter((g) => !isGenericGenre(g)).slice(0, 2).map(genreEs);
  const pages = profile.avgPages ? Math.round(profile.avgPages / 10) * 10 : null;
  return (
    <>
      Has leído <b className="rr-em">{profile.totalRead} libros</b>.{" "}
      {authors.length > 0 && <>Vuelves una y otra vez a {joinEs(authors.map((a) => <b key={a} className="rr-em">{a}</b>))}</>}
      {genres.length > 0 && <>, casi siempre en {joinEs(genres)}</>}
      {pages && (pages < 220
        ? <>, y te gustan cortos: tu media no llega a las {pages} páginas.</>
        : pages <= 420
        ? <>, y tus libros rondan las {pages} páginas: ni cuentos ni ladrillos.</>
        : <>, y no te asustan los tochos: tu media anda por las {pages} páginas.</>)}
      {!pages && "."}
    </>
  );
}

// Por qué recomendamos un libro, dicho como lo diría una librera. La versión
// larga (destacado y ficha) junta todas las razones; la corta se queda con la
// principal y varía la frase de un libro a otro.
function reasonFor(r, profile, { long = false } = {}) {
  const author = r.authors[0];
  const mainGenre = profile.topGenres.find((g) => !isGenericGenre(g));
  const genre = r.matchedGenres.find((g) => !isGenericGenre(g));
  const pick = (options) => (long ? options[0] : variantFor(r.id, options));
  const parts = [];
  if (r.authorMatch) {
    parts.push(pick([
      `Ya conoces a ${author} y este todavía no lo tienes.`,
      `Más ${author}: este aún no está en tu biblioteca.`,
      `De ${author}, a quien vuelves a menudo. Este te falta.`,
    ]));
  }
  if (genre && (long || !r.authorMatch)) {
    const name = genreEs(genre);
    const article = genreArticle(genre);
    parts.push(genre === mainGenre
      ? pick([`Es ${name}, lo que más lees.`, `${capitalize(name)}: tu terreno de siempre.`, `Encaja con tu gusto por ${article} ${name}.`])
      : pick([`Es ${name}, que también está entre lo tuyo.`, `${capitalize(name)}, que también lees a menudo.`, `Tira hacia ${article} ${name}, otra de tus debilidades.`]));
  }
  if (long && r.averageRating >= 4.2 && r.ratingsCount >= 1000) {
    parts.push(`Y quien lo ha leído le da un ${formatDecimal(r.averageRating)} de media.`);
  }
  if (!parts.length) {
    parts.push(r.averageRating >= 4
      ? `No se parece a lo que sueles leer, pero tiene un ${formatDecimal(r.averageRating)} de media: vale la pena el desvío.`
      : "Encaja con el tono general de tu biblioteca.");
  }
  return parts.join(" ");
}

// Google Books devuelve la sinopsis a veces con HTML (<br>, <p>, <b>…) o con
// saltos de línea crudos. Cada salto que ya trae el texto marca un párrafo;
// el resto de etiquetas se quitan y las entidades (&amp;, &quot;…) se
// decodifican. No se corta ni se reescribe nada del contenido.
function synopsisParagraphs(raw) {
  if (!raw) return [];
  const marked = raw.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n");
  const text = new DOMParser().parseFromString(marked, "text/html").body.textContent || "";
  return text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const SYNOPSIS_PREVIEW_CHARS = 450;

// Primeros párrafos hasta ~450 caracteres. Si el primero ya es más largo, se
// corta al final de una frase (o de una palabra) y se marca con "…".
function synopsisPreview(paragraphs) {
  const preview = [];
  let used = 0;
  for (const p of paragraphs) {
    if (used + p.length <= SYNOPSIS_PREVIEW_CHARS) {
      preview.push(p);
      used += p.length;
      continue;
    }
    if (!preview.length) {
      const slice = p.slice(0, SYNOPSIS_PREVIEW_CHARS);
      const sentenceEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "));
      preview.push(sentenceEnd > 200 ? slice.slice(0, sentenceEnd + 1) : `${slice.slice(0, slice.lastIndexOf(" "))}…`);
    }
    break;
  }
  return preview;
}

function Synopsis({ text }) {
  const [expanded, setExpanded] = useState(false);
  const paragraphs = useMemo(() => synopsisParagraphs(text), [text]);
  if (!paragraphs.length) return <p className="rr-prose">Google Books no tiene sinopsis para esta edición.</p>;

  const total = paragraphs.reduce((n, p) => n + p.length, 0);
  const preview = synopsisPreview(paragraphs);
  const previewLength = preview.reduce((n, p) => n + p.replace(/…$/, "").length, 0);
  // Si lo que quedaría oculto es poco, se enseña todo: un "leer más" para dos líneas no compensa.
  const collapsible = total > SYNOPSIS_PREVIEW_CHARS && total - previewLength > 120;
  const shown = collapsible && !expanded ? preview : paragraphs;

  return (
    <div className="rr-synopsis" id="rr-synopsis">
      {shown.map((p, i) => <p key={i} className="rr-prose">{p}</p>)}
      {collapsible && (
        <button className="rr-link" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} aria-controls="rr-synopsis">
          {expanded ? "leer menos" : "leer más"}
          <ChevronDown size={12} strokeWidth={1.6} style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }} />
        </button>
      )}
    </div>
  );
}

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento no disponible, seguimos sin persistir */
  }
}

export default function ReadingRoom() {
  const [stage, setStage] = useState("pick"); // pick | confirm | building | ready | error
  const [pendingFile, setPendingFile] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [profile, setProfile] = useState(null);
  const [allRecs, setAllRecs] = useState([]);
  const [identityKey, setIdentityKey] = useState(null);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [avoidedGenres, setAvoidedGenres] = useState(() => new Set());
  const [saved, setSaved] = useState(() => new Set());
  const [activeGenre, setActiveGenre] = useState("todos");
  const [sortBy, setSortBy] = useState("relevancia");
  const [selectedBook, setSelectedBook] = useState(null);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [libraryBooks, setLibraryBooks] = useState(null); // datos crudos, para poder "actualizar" sin volver a subir el csv
  const [showTrash, setShowTrash] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [previousRecs, setPreviousRecs] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("checking"); // checking | available | unavailable
  const [syncRows, setSyncRows] = useState(null);
  const [syncUserId, setSyncUserId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const fileInputRef = useRef(null);
  const headingRef = useRef(null);

  // Comprueba si esta cuenta de Goodreads ya se conectó antes (guardado en
  // este navegador), para ofrecer el acceso directo en la pantalla de inicio
  useEffect(() => {
    const savedUserId = localStorage.getItem(GOODREADS_USER_KEY);
    const cached = loadJSON(`next-read-lab:goodreads-cache:${savedUserId}`);
    if (savedUserId && cached?.length) {
      setSyncUserId(savedUserId);
      setSyncRows(cached);
      setSyncStatus("available");
    } else {
      setSyncStatus("unavailable");
    }
  }, []);

  const connectGoodreads = useCallback(async (userId) => {
    setConnecting(true);
    setConnectError("");
    try {
      const rows = await connectGoodreadsAccount(userId);
      const cleanId = userId.trim();
      localStorage.setItem(GOODREADS_USER_KEY, cleanId);
      saveJSON(`next-read-lab:goodreads-cache:${cleanId}`, rows);
      setSyncUserId(cleanId);
      setSyncRows(rows);
      setSyncStatus("available");
    } catch (e) {
      setConnectError(e.message || "No se ha podido conectar. Inténtalo de nuevo.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchGoodreadsUser = useCallback(() => {
    if (syncUserId) localStorage.removeItem(`next-read-lab:goodreads-cache:${syncUserId}`);
    localStorage.removeItem(GOODREADS_USER_KEY);
    setSyncUserId("");
    setSyncRows(null);
    setSyncStatus("unavailable");
    setConnectError("");
  }, [syncUserId]);

  // Al arrancar, si la última persona que usó la app en este navegador dejó
  // un análisis guardado, lo recuperamos — pero solo el suyo, identificado
  // por su cuenta de Goodreads o por el nombre del csv que subió.
  useEffect(() => {
    const lastIdentity = localStorage.getItem(LAST_IDENTITY_KEY);
    if (!lastIdentity) return;
    const stored = loadJSON(scopedKey(STORAGE_KEY, lastIdentity));
    if (stored?.profile && stored?.allRecs?.length) {
      setIdentityKey(lastIdentity);
      setProfile(stored.profile);
      setAllRecs(stored.allRecs);
      setDismissed(new Set(loadJSON(scopedKey(DISMISSED_KEY, lastIdentity)) || []));
      setSaved(new Set(loadJSON(scopedKey(SAVED_KEY, lastIdentity)) || []));
      setAvoidedGenres(new Set(loadJSON(scopedKey(AVOIDED_GENRES_KEY, lastIdentity)) || []));
      setLibraryBooks(loadJSON(scopedKey(LIBRARY_BOOKS_KEY, lastIdentity)) || null);
      setStage("ready");
    }
  }, []);

  // Mueve el foco al título de cada pantalla al cambiar, para quien navega sin ratón
  useEffect(() => {
    headingRef.current?.focus();
  }, [stage, selectedBook]);

  // Cada lista se guarda bajo la identidad activa, para no mezclarla con la
  // de otra persona que use la app en el mismo ordenador.
  useEffect(() => {
    if (!identityKey) return;
    saveJSON(scopedKey(DISMISSED_KEY, identityKey), Array.from(dismissed));
  }, [dismissed, identityKey]);
  useEffect(() => {
    if (!identityKey) return;
    saveJSON(scopedKey(SAVED_KEY, identityKey), Array.from(saved));
  }, [saved, identityKey]);
  useEffect(() => {
    if (!identityKey) return;
    saveJSON(scopedKey(AVOIDED_GENRES_KEY, identityKey), Array.from(avoidedGenres));
  }, [avoidedGenres, identityKey]);

  const selectFile = useCallback((file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Ese archivo no parece un CSV. Exporta tu biblioteca desde Goodreads (My Books → Tools → Import and export) y sube ese archivo.");
      setStage("error");
      return;
    }
    setPendingFile(file);
    setStage("confirm");
  }, []);

  const buildRecommendations = useCallback(async (rows, sourceLabel, newIdentityKey) => {
    setStage("building");
    setError("");
    try {
      setStatusMsg("Leyendo tu biblioteca…");
      const books = rows
        .map((r) => ({
          title: (r["Title"] || "").trim(),
          author: (r["Author"] || "").trim(),
          rating: parseFloat(r["My Rating"] || "0"),
          shelf: (r["Exclusive Shelf"] || "").trim(),
          pages: parseInt(r["Number of Pages"] || "0", 10) || null,
        }))
        .filter((b) => b.title);

      if (!books.length) throw new Error("El archivo se ha leído pero no contiene ningún libro. Comprueba que sea el CSV exportado directamente desde Goodreads.");

      const readBooks = books.filter((b) => b.shelf === "read");
      const rated = readBooks.filter((b) => b.rating >= 4);

      const authorCount = {};
      readBooks.forEach((b) => {
        authorCount[b.author] = (authorCount[b.author] || 0) + (b.rating >= 4 ? 2 : 1);
      });
      const topAuthors = Object.entries(authorCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n]) => n);

      const pagesKnown = readBooks.filter((b) => b.pages);
      const avgPages = pagesKnown.length
        ? Math.round(pagesKnown.reduce((s, b) => s + b.pages, 0) / pagesKnown.length)
        : null;

      setStatusMsg("Consultando Google Books para tus libros mejor valorados… (puede tardar un poco, vamos despacio a propósito para no saturar la API)");
      const seedSet = (rated.length ? rated : readBooks).slice(0, 6);
      const infos = await runSequentially(seedSet, (b) => fetchVolumeInfo(b.title, b.author));

      const genreCount = {};
      infos.forEach((info) => {
        (info?.categories || []).forEach((cat) => {
          cat.split(" / ").forEach((piece) => {
            const key = piece.trim();
            if (!key) return;
            genreCount[key] = (genreCount[key] || 0) + 1;
          });
        });
      });
      const topGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);

      setStatusMsg("Buscando libros afines a tus gustos en el catálogo…");
      const queries = [
        ...topAuthors.slice(0, 3).map((a) => `inauthor:"${a}"`),
        ...topGenres.slice(0, 3).map((g) => `subject:"${g}"`),
      ];
      const resultsNested = await runSequentially(queries, searchCandidates);
      const seenTitles = new Set(books.map((b) => normalizeTitle(b.title)));
      const seenIds = new Set();
      const candidates = [];
      resultsNested.flat().forEach((c) => {
        const norm = normalizeTitle(c.title);
        if (!norm || seenTitles.has(norm) || seenIds.has(c.id)) return;
        seenIds.add(c.id);
        candidates.push(c);
      });

      const topAuthorsLower = topAuthors.map((a) => a.toLowerCase());
      const scored = candidates.map((c) => {
        const matchedGenres = c.categories.filter((cat) => topGenres.some((g) => cat.includes(g) || g.includes(cat)));
        const authorMatch = c.authors.some((a) => topAuthorsLower.includes(a.toLowerCase()));
        const ratingScore = (c.averageRating || 0) / 5;
        const popularityScore = Math.min(Math.log10(c.ratingsCount + 1) / 4, 1);
        const score = (matchedGenres.length ? 1.4 : 0) + (authorMatch ? 1.6 : 0) + ratingScore * 1.2 + popularityScore * 0.8;
        return { ...c, score, matchedGenres, authorMatch };
      });
      scored.sort((a, b) => b.score - a.score);
      const finalRecs = scored.slice(0, 14);

      if (!finalRecs.length) {
        throw new Error("No he encontrado candidatos suficientes. Prueba con una biblioteca con más libros valorados con 4 o 5 estrellas, o comprueba tu conexión a internet.");
      }

      const newProfile = { totalRead: readBooks.length, topAuthors, topGenres, avgPages, fileName: sourceLabel };

      // Recupera las listas propias de esta identidad concreta (si ya las
      // tenía de una sesión anterior), en vez de arrancar siempre en blanco
      // o heredar las de otra persona que haya usado la app antes.
      setDismissed(new Set(loadJSON(scopedKey(DISMISSED_KEY, newIdentityKey)) || []));
      setSaved(new Set(loadJSON(scopedKey(SAVED_KEY, newIdentityKey)) || []));
      setAvoidedGenres(new Set(loadJSON(scopedKey(AVOIDED_GENRES_KEY, newIdentityKey)) || []));

      setIdentityKey(newIdentityKey);
      setProfile(newProfile);
      setAllRecs(finalRecs);
      setLibraryBooks(rows);
      setActiveGenre("todos");
      setStage("ready");
      setAnnouncement(`Listo. ${finalRecs.length} recomendaciones encontradas.`);
      saveJSON(scopedKey(STORAGE_KEY, newIdentityKey), { profile: newProfile, allRecs: finalRecs });
      saveJSON(scopedKey(LIBRARY_BOOKS_KEY, newIdentityKey), rows);
      localStorage.setItem(LAST_IDENTITY_KEY, newIdentityKey);
    } catch (e) {
      console.error(e);
      setError(e.message || "No he podido procesar el archivo. Comprueba que sea el CSV exportado directamente desde Goodreads.");
      setStage("error");
    }
  }, []);

  const runAnalysis = useCallback(async () => {
    if (!pendingFile) return;
    const rows = await parseGoodreadsCsv(pendingFile);
    await buildRecommendations(rows, pendingFile.name, `csv:${pendingFile.name}`);
  }, [pendingFile, buildRecommendations]);

  const accessSyncedLibrary = useCallback(() => {
    if (!syncRows || !syncUserId) return;
    buildRecommendations(syncRows, `Goodreads (usuario ${syncUserId})`, `goodreads:${syncUserId}`);
  }, [syncRows, syncUserId, buildRecommendations]);

  const reset = useCallback(() => {
    // Borra los datos de la identidad actual (el csv o la cuenta de
    // Goodreads con la que se hizo este análisis), no los de otras
    // identidades que puedan compartir este mismo ordenador.
    if (identityKey) {
      localStorage.removeItem(scopedKey(STORAGE_KEY, identityKey));
      localStorage.removeItem(scopedKey(DISMISSED_KEY, identityKey));
      localStorage.removeItem(scopedKey(SAVED_KEY, identityKey));
      localStorage.removeItem(scopedKey(AVOIDED_GENRES_KEY, identityKey));
      localStorage.removeItem(scopedKey(LIBRARY_BOOKS_KEY, identityKey));
      if (localStorage.getItem(LAST_IDENTITY_KEY) === identityKey) {
        localStorage.removeItem(LAST_IDENTITY_KEY);
      }
    }
    setStage("pick");
    setPendingFile(null);
    setProfile(null);
    setAllRecs([]);
    setIdentityKey(null);
    setDismissed(new Set());
    setAvoidedGenres(new Set());
    setSaved(new Set());
    setLibraryBooks(null);
    setSelectedBook(null);
    setShowTrash(false);
    setPreviousRecs(null);
    setConfirmingReset(false);
    setError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [identityKey]);

  const requestReset = useCallback(() => {
    if (saved.size > 0 || dismissed.size > 0) setConfirmingReset(true);
    else reset();
  }, [saved, dismissed, reset]);

  // Vuelve a consultar Google Books desde cero con tu perfil ya calculado,
  // sin necesidad de resubir el csv. Al ser una consulta en vivo (no un
  // catálogo fijo), puede tardar unos segundos igual que el primer análisis.
  const refreshResults = useCallback(async () => {
    if (!libraryBooks || !profile) return;
    setRefreshing(true);
    setAnnouncement("Actualizando recomendaciones…");
    try {
      const books = libraryBooks
        .map((r) => ({
          title: (r["Title"] || "").trim(),
          author: (r["Author"] || "").trim(),
        }))
        .filter((b) => b.title);
      const topAuthors = profile.topAuthors;
      const topGenres = profile.topGenres;
      const queries = [
        ...topAuthors.slice(0, 3).map((a) => `inauthor:"${a}"`),
        ...topGenres.slice(0, 3).map((g) => `subject:"${g}"`),
      ];
      const resultsNested = await runSequentially(queries, searchCandidates);
      const seenTitles = new Set(books.map((b) => normalizeTitle(b.title)));
      const seenIds = new Set();
      const candidates = [];
      resultsNested.flat().forEach((c) => {
        const norm = normalizeTitle(c.title);
        if (!norm || seenTitles.has(norm) || seenIds.has(c.id)) return;
        seenIds.add(c.id);
        candidates.push(c);
      });
      const topAuthorsLower = topAuthors.map((a) => a.toLowerCase());
      const scored = candidates.map((c) => {
        const matchedGenres = c.categories.filter((cat) => topGenres.some((g) => cat.includes(g) || g.includes(cat)));
        const authorMatch = c.authors.some((a) => topAuthorsLower.includes(a.toLowerCase()));
        const avoidedHit = matchedGenres.some((g) => avoidedGenres.has(g));
        const ratingScore = (c.averageRating || 0) / 5;
        const popularityScore = Math.min(Math.log10(c.ratingsCount + 1) / 4, 1);
        const score = (matchedGenres.length ? 1.4 : 0) + (authorMatch ? 1.6 : 0) + ratingScore * 1.2 + popularityScore * 0.8 - (avoidedHit ? 1.5 : 0);
        return { ...c, score, matchedGenres, authorMatch };
      });
      scored.sort((a, b) => b.score - a.score);
      const nextRecs = scored.slice(0, 14);
      setPreviousRecs(allRecs);
      setAllRecs(nextRecs);
      showRefreshToast();
      if (identityKey) {
        saveJSON(scopedKey(STORAGE_KEY, identityKey), { profile, allRecs: nextRecs });
      }
      setSelectedBook(null);
      setShowTrash(false);
      setAnnouncement("Recomendaciones actualizadas.");
    } catch (e) {
      console.error(e);
      setPreviousRecs(null);
    } finally {
      setRefreshing(false);
    }
  }, [libraryBooks, profile, avoidedGenres, allRecs, identityKey]);

  const undoRefresh = useCallback(() => {
    if (!previousRecs) return;
    setAllRecs(previousRecs);
    setPreviousRecs(null);
    setAnnouncement("Se ha restaurado la lista anterior.");
  }, [previousRecs]);

  const dismissRec = useCallback((id, reason, matchedGenres) => {
    setDismissed((prev) => new Set(prev).add(id));
    showDismissToast();
    if (reason === "genre" && matchedGenres?.length) {
      setAvoidedGenres((prev) => {
        const next = new Set(prev);
        matchedGenres.forEach((g) => next.add(g));
        return next;
      });
      setAnnouncement(`Recomendación descartada. Te enseñaré menos ${genreEs(matchedGenres.find((g) => !isGenericGenre(g)) || matchedGenres[0])}.`);
    } else if (reason === "read") {
      setAnnouncement("Recomendación descartada porque ya la habías leído.");
    } else {
      setAnnouncement("Recomendación descartada");
    }
  }, []);
  const undoDismiss = useCallback((id) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const restoreAllDismissed = useCallback(() => setDismissed(new Set()), []);
  const toggleSaved = useCallback((id) => {
    setSaved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const lastDismissedId = useMemo(() => {
    const arr = Array.from(dismissed);
    return arr.length ? arr[arr.length - 1] : null;
  }, [dismissed]);

  // Los avisos flotantes de "deshacer" se ocultan solos a los 10 segundos,
  // o antes si se cierran a mano con la X.
  const [dismissToastVisible, setDismissToastVisible] = useState(false);
  const [refreshToastVisible, setRefreshToastVisible] = useState(false);

  const dismissToastTimer = useRef(null);
  const refreshToastTimer = useRef(null);

  const showDismissToast = useCallback(() => {
    setDismissToastVisible(true);
    if (dismissToastTimer.current) clearTimeout(dismissToastTimer.current);
    dismissToastTimer.current = setTimeout(() => setDismissToastVisible(false), 10000);
  }, []);

  const closeDismissToast = useCallback(() => {
    if (dismissToastTimer.current) clearTimeout(dismissToastTimer.current);
    setDismissToastVisible(false);
  }, []);

  const showRefreshToast = useCallback(() => {
    setRefreshToastVisible(true);
    if (refreshToastTimer.current) clearTimeout(refreshToastTimer.current);
    refreshToastTimer.current = setTimeout(() => setRefreshToastVisible(false), 10000);
  }, []);

  const closeRefreshToast = useCallback(() => {
    if (refreshToastTimer.current) clearTimeout(refreshToastTimer.current);
    setRefreshToastVisible(false);
  }, []);
  const visibleRecs = useMemo(() => {
    let list = allRecs.filter((r) => !dismissed.has(r.id));
    if (activeGenre === "guardados") list = list.filter((r) => saved.has(r.id));
    else if (activeGenre !== "todos") {
      list = list.filter((r) => r.matchedGenres.includes(activeGenre) || (activeGenre === "autor afín" && r.authorMatch));
    }
    list = list.map((r) => {
      const avoidedHit = r.matchedGenres.some((g) => avoidedGenres.has(g));
      return avoidedHit ? { ...r, score: r.score - 1.5 } : r;
    });
    list = [...list];
    if (sortBy === "valoracion") list.sort((a, b) => b.averageRating - a.averageRating);
    else list.sort((a, b) => b.score - a.score);
    return list;
  }, [allRecs, dismissed, saved, activeGenre, sortBy, avoidedGenres]);

  const forgetAvoidedGenres = useCallback(() => setAvoidedGenres(new Set()), []);
  const avoidedLabels = Array.from(avoidedGenres).filter((g) => !isGenericGenre(g)).map(genreEs);

  const allDismissed = allRecs.length > 0 && dismissed.size === allRecs.length;

  return (
    <div style={{ background: PALETTE.bg, minHeight: "100vh", fontFamily: "'DM Sans', sans-serif", color: PALETTE.ink, position: "relative", overflowX: "clip" }}>
      <GlobalStyle />
      <div className="wash" />
      <div aria-live="polite" className="sr-only">{announcement}</div>

      {stage === "ready" && profile ? (
        <TopBar
          dismissedCount={dismissed.size}
          onHome={() => { setSelectedBook(null); setShowTrash(false); }}
          onReset={requestReset}
          onShowTrash={() => { setShowTrash(true); setSelectedBook(null); }}
          onRefresh={refreshResults}
          refreshing={refreshing}
        />
      ) : (
        <header className="rr-header" style={{ maxWidth: "720px", margin: "0 auto", textAlign: "center", position: "relative", zIndex: 1 }}>
          <BookMark size={72} animated={stage === "building"} />
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="rr-brand rr-h1"
            style={{ margin: 0, outline: "none" }}
          >
            Next Read <span style={{ color: PALETTE.terracottaDeep }}>Lab</span>
          </h1>
          <div className="rr-diamond" />
        </header>
      )}

      {confirmingReset && (
        <ConfirmModal
          title="¿Cambiar de biblioteca?"
          message={`Si empiezas con otra biblioteca, se borran ${[
            saved.size > 0 && (saved.size === 1 ? "el libro que te has apuntado" : `los ${saved.size} libros que te has apuntado`),
            dismissed.size > 0 && (dismissed.size === 1 ? "el que has descartado" : `los ${dismissed.size} que has descartado`),
          ].filter(Boolean).join(" y ")}. No hay forma de recuperarlos.`}
          confirmLabel="sí, empezar de nuevo"
          cancelLabel="cancelar"
          onConfirm={reset}
          onCancel={() => setConfirmingReset(false)}
        />
      )}

      <main className="rr-main" style={{ maxWidth: "720px", margin: "0 auto", position: "relative", zIndex: 1 }}>
        <div key={selectedBook ? `detail-${selectedBook.id}` : showTrash ? "trash" : stage} className="rr-screen">
        {selectedBook ? (
          <BookDetailScreen
            book={selectedBook}
            profile={profile}
            headingRef={headingRef}
            isSaved={saved.has(selectedBook.id)}
            onToggleSaved={() => toggleSaved(selectedBook.id)}
            onBack={() => setSelectedBook(null)}
          />
        ) : showTrash ? (
          <TrashView
            recs={allRecs.filter((r) => dismissed.has(r.id))}
            onRestore={undoDismiss}
            onRestoreAll={restoreAllDismissed}
            onBack={() => setShowTrash(false)}
          />
        ) : (
          <>
            {stage === "pick" && (
              <PickPane
                onSelect={selectFile}
                fileInputRef={fileInputRef}
                syncStatus={syncStatus}
                onAccessSynced={accessSyncedLibrary}
                onConnect={connectGoodreads}
                onSwitchUser={switchGoodreadsUser}
                connecting={connecting}
                connectError={connectError}
              />
            )}
            {stage === "confirm" && pendingFile && <ConfirmPane file={pendingFile} onConfirm={runAnalysis} onCancel={reset} />}
            {stage === "building" && <BuildingPane statusMsg={statusMsg} />}

            {stage === "error" && (
              <div className="rr-card" style={{ padding: "30px" }}>
                <p style={{ fontSize: "14px", margin: "0 0 18px 0" }}>{error}</p>
                <button className="rr-btn" onClick={reset}>volver a empezar</button>
              </div>
            )}

            {stage === "ready" && profile && (
              <>
                <ProfilePanel profile={profile} />
                <FilterBar
                  topGenres={profile.topGenres}
                  hasAuthorMatches={allRecs.some((r) => r.authorMatch)}
                  hasSaved={saved.size > 0}
                  activeGenre={activeGenre}
                  setActiveGenre={setActiveGenre}
                  sortBy={sortBy}
                  setSortBy={setSortBy}
                />
                {avoidedGenres.size > 0 && (
                  <p className="rr-avoided">
                    {avoidedLabels.length ? <>Te enseño menos {joinEs(avoidedLabels)}, como me pediste.</> : "Te enseño menos de los géneros que descartaste."}{" "}
                    <button className="rr-link" style={{ fontSize: "13px" }} onClick={forgetAvoidedGenres}>olvídalo</button>
                  </p>
                )}
                {allDismissed ? (
                  <div className="rr-card" style={{ padding: "26px", textAlign: "center" }}>
                    <p style={{ fontSize: "14px", marginBottom: "14px" }}>Has vaciado la estantería entera. ¿Le damos otra vuelta?</p>
                    <button className="rr-btn" onClick={restoreAllDismissed}>volver a mostrarlas todas</button>
                  </div>
                ) : (
                  <RecommendationsPanel
                    recs={visibleRecs}
                    profile={profile}
                    saved={saved}
                    onDismiss={dismissRec}
                    onToggleSaved={toggleSaved}
                    onSelect={setSelectedBook}
                  />
                )}
                {dismissToastVisible && lastDismissedId && !allDismissed && (
                  <UndoBar onUndo={() => undoDismiss(lastDismissedId)} onClose={closeDismissToast} />
                )}
                {refreshToastVisible && previousRecs && (
                  <UndoBar message="Recomendaciones actualizadas." actionLabel="deshacer actualización" onUndo={undoRefresh} onClose={closeRefreshToast} />
                )}
              </>
            )}
          </>
        )}
        </div>
      </main>
      <footer className="rr-footer">
        Next Read Lab es un proyecto de{" "}
        <a href="https://github.com/gdlaura01" target="_blank" rel="noreferrer">gdlaura01</a>, {new Date().getFullYear()}.
      </footer>
    </div>
  );
}

// Un primer vistazo al CSV antes de analizarlo, con los mismos criterios que
// buildRecommendations, para confirmar que es el archivo correcto y avisar
// antes de esperar si no sirve.
function summarizeLibrary(rows) {
  const books = rows.filter((r) => (r["Title"] || "").trim());
  const read = books.filter((r) => (r["Exclusive Shelf"] || "").trim() === "read");
  const rating = (r) => parseFloat(r["My Rating"] || "0");
  return {
    total: books.length,
    read: read.length,
    loved: read.filter((r) => rating(r) >= 4).length,
    // Goodreads exporta primero lo último que añadiste; quitamos la serie entre paréntesis del final
    fiveStars: read.filter((r) => rating(r) === 5).slice(0, 3).map((r) => r["Title"].trim().replace(/\s*\([^)]*\)$/, "")),
  };
}

function ConfirmPane({ file, onConfirm, onCancel }) {
  const [summary, setSummary] = useState(null); // null mientras lee; false si no ha podido leerlo

  useEffect(() => {
    let alive = true;
    setSummary(null);
    parseGoodreadsCsv(file)
      .then((rows) => { if (alive) setSummary(summarizeLibrary(rows)); })
      .catch(() => { if (alive) setSummary(false); });
    return () => { alive = false; };
  }, [file]);

  const unusable = summary === false || summary?.total === 0 || summary?.read === 0;

  return (
    <div className="rr-pick">
      <div className="rr-confirm" aria-live="polite">
        {summary === null ? (
          <p className="rr-confirm-lead rr-soft">Echando un vistazo a tu archivo…</p>
        ) : summary === false || summary.total === 0 ? (
          <>
            <p className="rr-confirm-lead">En este archivo no encuentro libros.</p>
            <p className="rr-confirm-sub">
              ¿Es la exportación de Goodreads? Suele llamarse goodreads_library_export.csv y la descargas desde My Books, en Import and export.
            </p>
          </>
        ) : summary.read === 0 ? (
          <>
            <p className="rr-confirm-lead">Veo {summary.total === 1 ? "un libro" : `${summary.total} libros`}, pero ninguno marcado como leído.</p>
            <p className="rr-confirm-sub">
              Sin saber qué has leído no puedo adivinar qué te gusta. Marca en Goodreads los que ya hayas terminado y vuelve a exportar la biblioteca.
            </p>
          </>
        ) : (
          <>
            <p className="rr-confirm-lead">
              {summary.read === summary.total
                ? `Tengo tu biblioteca: ${summary.read} ${summary.read === 1 ? "libro leído" : "libros leídos"}.`
                : `Tengo tu biblioteca: ${summary.total} libros, ${summary.read} ya ${summary.read === 1 ? "leído" : "leídos"}.`}
            </p>
            {summary.fiveStars.length > 0 && (
              <p className="rr-confirm-sub">
                Entre tus cinco estrellas más recientes {summary.fiveStars.length === 1 ? "está" : "están"}{" "}
                {joinEs(summary.fiveStars.map((title) => <cite key={title}>{title}</cite>))}.
              </p>
            )}
            <p className="rr-confirm-sub">
              {summary.loved >= 3
                ? `Con los ${summary.loved} que valoraste con cuatro o cinco estrellas tengo de sobra para empezar.`
                : "Has valorado pocos con cuatro o cinco estrellas, así que tiraré de todo lo que has leído. Las recomendaciones serán algo menos finas."}
            </p>
          </>
        )}
        <div className="rr-actions" style={{ justifyContent: "center" }}>
          {!unusable && (
            <button className="rr-btn rr-btn-filled" onClick={onConfirm} disabled={summary === null} style={{ opacity: summary === null ? 0.6 : 1 }}>
              <Check size={15} strokeWidth={1.7} /> buscar mi próxima lectura
            </button>
          )}
          <button className="rr-link" onClick={onCancel}>{unusable ? "elegir otro archivo" : "no es este archivo"}</button>
        </div>
      </div>
      <p className="rr-confirm-file">He leído {file.name} aquí mismo, sin que salga de tu navegador.</p>
    </div>
  );
}

function FilterBar({ topGenres, hasAuthorMatches, hasSaved, activeGenre, setActiveGenre, sortBy, setSortBy }) {
  const chips = [
    "todos",
    ...topGenres.filter((g) => !isGenericGenre(g)).slice(0, 4),
    ...(hasAuthorMatches ? ["autor afín"] : []),
    ...(hasSaved ? ["guardados"] : []),
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px", marginBottom: "22px" }}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {chips.map((g) => {
          const isActive = activeGenre === g;
          return (
            <button key={g} onClick={() => setActiveGenre(g)} aria-pressed={isActive} className="rr-chip" style={{ background: isActive ? PALETTE.terracottaDeep : PALETTE.white, color: isActive ? PALETTE.white : PALETTE.ink, borderColor: isActive ? PALETTE.terracottaDeep : PALETTE.sage }}>
              {g === "todos" || g === "autor afín" || g === "guardados" ? g : genreEs(g)}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: "12px", color: PALETTE.inkSoft, display: "flex", alignItems: "center", gap: "8px" }}>
        ordenar
        <SortDropdown
          value={sortBy}
          onChange={setSortBy}
          options={[
            { value: "relevancia", label: "relevancia" },
            { value: "valoracion", label: "valoración" },
          ]}
        />
      </div>
    </div>
  );
}
function SortDropdown({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function handleKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  const current = options.find((o) => o.value === value);

  return (
    <div className="rr-dropdown" ref={ref}>
      <button
        type="button"
        className="rr-select-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current?.label}
        <ChevronDown size={12} strokeWidth={1.8} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }} />
      </button>
      {open && (
        <ul className="rr-dropdown-list" role="listbox">
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                className="rr-dropdown-option"
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={o.value === value ? { color: PALETTE.terracottaDeep, fontWeight: 700 } : undefined}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PickPane({ onSelect, fileInputRef, syncStatus, onAccessSynced, onConnect, onSwitchUser, connecting, connectError }) {
  const [dragging, setDragging] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [userId, setUserId] = useState("");

  return (
    <div className="rr-pick">
      <p className="rr-pitch">Dime qué has leído y te digo qué leer después.</p>

      {syncStatus === "available" ? (
        <div className="rr-drop">
          <p className="rr-drop-title">Tu Goodreads ya está conectado en este navegador.</p>
          <div className="rr-actions" style={{ justifyContent: "center" }}>
            <button className="rr-btn rr-btn-filled" onClick={onAccessSynced}>
              <Check size={15} strokeWidth={1.7} /> ver mis recomendaciones
            </button>
            <button className="rr-link" onClick={onSwitchUser}>no soy yo</button>
          </div>
        </div>
      ) : (
        <>
          <label
            className="rr-drop"
            data-dragging={dragging || undefined}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); onSelect(e.dataTransfer.files?.[0]); }}
          >
            <p className="rr-drop-title">Suelta aquí la exportación de tu biblioteca</p>
            <p className="rr-drop-sub">El archivo CSV que te da Goodreads. Lo leo en tu navegador y no sale de aquí.</p>
            <span className="rr-btn rr-btn-filled"><Upload size={15} strokeWidth={1.6} /> elegir el archivo</span>
            <input ref={fileInputRef} type="file" accept=".csv" className="visually-hidden" onChange={(e) => onSelect(e.target.files?.[0])} />
          </label>

          <button className="rr-link rr-help-toggle" onClick={() => setShowHelp((s) => !s)} aria-expanded={showHelp}>
            ¿dónde está ese archivo?
            <ChevronDown size={12} strokeWidth={1.6} style={{ transform: showHelp ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }} />
          </button>
          {showHelp && (
            <p className="rr-help">
              En Goodreads, entra en <strong>My Books</strong>, busca <strong>Import and export</strong> en la columna de la izquierda
              y pulsa <strong>Export Library</strong>. Tarda un minuto en prepararse.
            </p>
          )}

          <div className="rr-alt">
            <p>
              ¿Prefieres no descargar nada? Escribe tu número de usuario de Goodreads (el que sale en la dirección de tu perfil,
              goodreads.com/user/show/<strong>12345678</strong>) y lo leo directamente. Tu perfil tiene que ser público.
            </p>
            <div className="rr-alt-row">
              <input
                type="text"
                inputMode="numeric"
                aria-label="Tu número de usuario de Goodreads"
                placeholder="por ejemplo, 12345678"
                value={userId}
                onChange={(e) => setUserId(e.target.value.replace(/[^0-9]/g, ""))}
                className="rr-select"
                disabled={connecting}
              />
              <button className="rr-btn" onClick={() => onConnect(userId)} disabled={connecting || !userId} style={{ opacity: connecting || !userId ? 0.6 : 1 }}>
                {connecting && <PulseDot />}
                {connecting ? "conectando…" : "conectar"}
              </button>
            </div>
            {connectError && <p className="rr-error">{connectError}</p>}
          </div>
        </>
      )}
    </div>
  );
}

// Los pasos siguen el orden de los mensajes de buildRecommendations.
const BUILD_STEPS = [
  ["Leyendo", "Leo tu biblioteca"],
  ["Consultando", "Miro de qué van tus favoritos"],
  ["Buscando", "Busco libros que se les parezcan"],
];

function BuildingPane({ statusMsg }) {
  const current = Math.max(0, BUILD_STEPS.findIndex(([prefix]) => statusMsg.startsWith(prefix)));
  return (
    <div className="rr-building">
      <ol className="rr-steps">
        {BUILD_STEPS.map(([, label], i) => (
          <li key={label} data-state={i < current ? "done" : i === current ? "now" : "next"} aria-current={i === current ? "step" : undefined}>
            <span className="rr-step-mark">{i < current && <Check size={13} strokeWidth={2.4} />}</span>
            {label}{i === current ? "…" : ""}
          </li>
        ))}
      </ol>
      <p className="rr-building-note">
        Voy despacio a propósito: Google Books se enfada si le pregunto demasiado rápido. Suele tardar menos de un minuto.
      </p>
    </div>
  );
}

// Los autores que más lees, como lomos sobre una balda. El alto y el ancho
// salen del nombre, para que cada biblioteca tenga su propia silueta.
const SPINE_COLORS = [PALETTE.terracottaDeep, PALETTE.sage, PALETTE.ink, PALETTE.terracotta, "#E9DFC6", PALETTE.inkSoft];
const LIGHT_SPINES = new Set([PALETTE.sage, "#E9DFC6"]);

function Shelf({ authors }) {
  return (
    <div className="rr-shelf" aria-hidden="true">
      <div className="rr-spines">
        {authors.slice(0, 6).map((author, i) => {
          const color = SPINE_COLORS[i];
          return (
            <div
              key={author}
              className="rr-spine"
              style={{
                background: color,
                color: LIGHT_SPINES.has(color) ? PALETTE.ink : PALETTE.bg,
                height: 128 + ((author.length * 7) % 48),
                width: 40 + ((author.length * 3) % 14),
                transform: i === 3 ? "rotate(-7deg) translateX(-3px)" : undefined,
              }}
            >
              <span>{author}</span>
            </div>
          );
        })}
      </div>
      <div className="rr-board" />
    </div>
  );
}

function ProfilePanel({ profile }) {
  return (
    <section className="rr-profile">
      {profile.topAuthors.length > 0 && <Shelf authors={profile.topAuthors} />}
      <p className="rr-note">
        He mirado tu biblioteca con calma. <ProfileSentence profile={profile} /> Con eso, esto es lo que te pondría en las manos.
      </p>
    </section>
  );
}

function BookCover({ book, width, height, className = "" }) {
  return (
    <div className={`rr-book-cover ${className}`} style={{ width, height }}>
      {book.thumbnail ? <img src={book.thumbnail} alt="" /> : <BookOpen size={Math.round(width / 4)} strokeWidth={1.2} color={PALETTE.ink} />}
    </div>
  );
}

function DiscardReasons({ book, onDismiss, onCancel }) {
  return (
    <div className="rr-ask" onClick={(e) => e.stopPropagation()}>
      <span>¿Qué no te convence?</span>
      <button className="rr-chip" onClick={() => onDismiss(book.id, "genre", book.matchedGenres)}>el género</button>
      <button className="rr-chip" onClick={() => onDismiss(book.id, "read")}>ya lo he leído</button>
      <button className="rr-link" style={{ fontSize: "12px" }} onClick={onCancel}>da igual</button>
    </div>
  );
}

function BookIconActions({ book, isSaved, onToggleSaved, onAskDiscard }) {
  return (
    <span className="rr-icon-actions">
      <button
        className="rr-icon-btn"
        onClick={(e) => { e.stopPropagation(); onToggleSaved(book.id); }}
        aria-label={isSaved ? `Quitar ${book.title} de tu lista` : `Apuntar ${book.title} para más tarde`}
        title={isSaved ? "En tu lista" : "Me lo apunto"}
      >
        {isSaved ? <BookmarkCheck size={16} strokeWidth={1.7} color={PALETTE.terracotta} /> : <Bookmark size={16} strokeWidth={1.7} />}
      </button>
      <button
        className="rr-icon-btn"
        onClick={(e) => { e.stopPropagation(); onAskDiscard(); }}
        aria-label={`Descartar ${book.title}`}
        title="No me interesa"
      >
        <X size={16} strokeWidth={1.7} />
      </button>
    </span>
  );
}

// Tres niveles: un libro para empezar, tres por si te quedas con ganas y el
// resto, en lista, para más adelante.
function RecommendationsPanel({ recs, profile, saved, onDismiss, onToggleSaved, onSelect }) {
  const [askingId, setAskingId] = useState(null);
  if (!recs.length) {
    return <p className="rr-empty">Con este filtro no queda nada. Prueba con «todos» para ver el resto.</p>;
  }
  const [top, ...rest] = recs;
  const nextUp = rest.slice(0, 3);
  const later = rest.slice(3);
  const dismiss = (...args) => { onDismiss(...args); setAskingId(null); };
  const reasons = (book) => <DiscardReasons book={book} onDismiss={dismiss} onCancel={() => setAskingId(null)} />;
  const topSaved = saved.has(top.id);

  return (
    <div>
      <article className="rr-hero">
        <div className="rr-hero-stand">
          <BookCover book={top} width={176} height={264} />
          <div className="rr-board" />
        </div>
        <div className="rr-hero-text">
          <div className="rr-hero-head">
            <p className="rr-kicker">Empieza por este</p>
            <h2 className="rr-hero-title">{top.title}</h2>
            <p className="rr-byline">{top.authors.join(", ")}</p>
          </div>
          <div className="rr-hero-body">
            <p className="rr-hero-why">{reasonFor(top, profile, { long: true })}</p>
            {askingId === top.id ? reasons(top) : (
              <div className="rr-actions">
                <button className="rr-btn rr-btn-filled" onClick={() => onToggleSaved(top.id)} aria-pressed={topSaved}>
                  {topSaved ? <BookmarkCheck size={15} strokeWidth={1.7} /> : <Bookmark size={15} strokeWidth={1.7} />}
                  {topSaved ? "en tu lista" : "me lo apunto"}
                </button>
                <button className="rr-link" onClick={() => onSelect(top)}>ver la ficha</button>
                <button className="rr-link rr-link-quiet" onClick={() => setAskingId(top.id)}>no me convence</button>
              </div>
            )}
          </div>
        </div>
      </article>

      {nextUp.length > 0 && <h3 className="rr-section-title">Si te quedas con ganas</h3>}
      <div className="rr-next-up">
        {nextUp.map((book) => (
          <div key={book.id} className="rr-next" onClick={() => askingId !== book.id && onSelect(book)}>
            <BookCover book={book} width={92} height={138} />
            <div>
              <button className="rr-book-title" onClick={(e) => { e.stopPropagation(); onSelect(book); }}>{book.title}</button>
              <div className="rr-byline-small">{book.authors[0]}</div>
              {askingId === book.id ? reasons(book) : (
                <>
                  <p className="rr-next-why">{reasonFor(book, profile)}</p>
                  <BookIconActions book={book} isSaved={saved.has(book.id)} onToggleSaved={onToggleSaved} onAskDiscard={() => setAskingId(book.id)} />
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {later.length > 0 && <h3 className="rr-section-title">Para más adelante</h3>}
      <ul className="rr-later">
        {later.map((book) => (
          <li key={book.id} onClick={() => askingId !== book.id && onSelect(book)}>
            {askingId === book.id ? reasons(book) : (
              <>
                <span className="rr-later-text">
                  {/* Enlace y no botón: un botón no parte línea junto al texto que le sigue */}
                  <a className="rr-book-title" href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(book); }}>{book.title}</a>, de {book.authors[0] || "autor desconocido"}
                  <span className="rr-later-why">{reasonFor(book, profile)}</span>
                </span>
                <BookIconActions book={book} isSaved={saved.has(book.id)} onToggleSaved={onToggleSaved} onAskDiscard={() => setAskingId(book.id)} />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BookDetailScreen({ book, profile, onBack, isSaved, onToggleSaved, headingRef }) {
  const [edition, setEdition] = useState(null);
  const [editionLoading, setEditionLoading] = useState(true);
  const [translator, setTranslator] = useState(null);
  const [translatorLoading, setTranslatorLoading] = useState(false);
  const needsTranslation = book.language && book.language !== "es";

  useEffect(() => {
    let alive = true;
    setEditionLoading(true);
    setTranslator(null);
    fetchSpanishEdition(book.title, book.authors?.[0] || "").then(async (res) => {
      if (!alive) return;
      setEdition(res);
      setEditionLoading(false);
      if (needsTranslation && res?.isbn) {
        setTranslatorLoading(true);
        const name = await fetchTranslatorFromOpenLibrary(res.isbn);
        if (alive) {
          setTranslator(name);
          setTranslatorLoading(false);
        }
      }
    });
    return () => { alive = false; };
  }, [book.id, book.title]);

  const publisherNote = edition?.publisher ? getPublisherNote(book.language, edition.publisher) : null;
  const genres = (book.matchedGenres || []).filter((g) => !isGenericGenre(g)).map(genreEs);
  const facts = [
    book.averageRating > 0 ? `${formatDecimal(book.averageRating)} de media en Google Books` : null,
    genres.length ? capitalize(genres.join(", ")) : null,
  ].filter(Boolean);
  const year = edition?.publishedDate ? edition.publishedDate.slice(0, 4) : null;

  return (
    <div className="rr-detail">
      <button className="rr-link rr-back" onClick={onBack}>← todas las recomendaciones</button>

      <div className="rr-detail-head">
        <BookCover book={book} width={132} height={198} />
        <div>
          <h2 ref={headingRef} tabIndex={-1} className="rr-hero-title" style={{ outline: "none" }}>{book.title}</h2>
          <p className="rr-byline">{book.authors?.join(", ")}</p>
          {facts.length > 0 && <p className="rr-facts">{facts.join(". ")}.</p>}
          <div className="rr-actions">
            <button className="rr-btn rr-btn-filled" onClick={onToggleSaved} aria-pressed={isSaved}>
              {isSaved ? <BookmarkCheck size={15} strokeWidth={1.7} /> : <Bookmark size={15} strokeWidth={1.7} />}
              {isSaved ? "en tu lista" : "me lo apunto"}
            </button>
            {book.infoLink && (
              <a className="rr-link" href={book.infoLink} target="_blank" rel="noreferrer">
                en Google Books <ExternalLink size={12} strokeWidth={1.6} />
              </a>
            )}
          </div>
        </div>
      </div>

      <blockquote className="rr-why">{reasonFor(book, profile, { long: true })}</blockquote>

      <h3 className="rr-detail-title">De qué va</h3>
      <Synopsis text={book.description} />

      <aside className="rr-buy">
        <h3 className="rr-detail-title" style={{ marginTop: 0 }}>Si vas a comprarlo</h3>
        {editionLoading ? (
          <p className="rr-prose rr-soft">Buscando la edición en español…</p>
        ) : edition?.publisher ? (
          <p className="rr-prose">
            Yo buscaría la de <strong>{edition.publisher}</strong>{year ? `, de ${year}` : ""}.{" "}
            {publisherNote || (edition.candidateCount > 1
              ? "Es la que tiene los datos más completos entre las ediciones en español que he encontrado."
              : "Es la única edición en español con editorial identificada que he encontrado.")}
            {edition.infoLink && <> <a className="rr-link" href={edition.infoLink} target="_blank" rel="noreferrer">verla en Google Books</a></>}
          </p>
        ) : (
          <p className="rr-prose">No he encontrado una edición en español fiable en Google Books. Pregunta en tu librería: sabrán cuál tienen.</p>
        )}
        {needsTranslation && (translatorLoading ? (
          <p className="rr-prose rr-soft">Buscando quién lo tradujo…</p>
        ) : translator ? (
          <p className="rr-prose">
            La traducción es de <strong>{translator}</strong>{edition?.publisher ? ` para ${edition.publisher}` : ""}, según la ficha de
            Open Library{edition?.isbn ? ` (ISBN ${edition.isbn})` : ""}. Es un dato de catálogo: compruébalo en el colofón antes de comprar.
          </p>
        ) : (
          <p className="rr-prose">
            Está escrito originalmente en otro idioma y no he encontrado quién lo tradujo. No quiero inventarme un nombre: mira el
            colofón antes de comprarlo, sobre todo si es un clásico con varias traducciones en circulación.
          </p>
        ))}
      </aside>
    </div>
  );
}

// Cabecera compacta: la marca grande solo tiene sentido en la portada.
function TopBar({ dismissedCount, onHome, onReset, onShowTrash, onRefresh, refreshing }) {
  return (
    <header className="rr-bar">
      <div className="rr-bar-inner">
        <button className="rr-bar-brand" onClick={onHome} aria-label="Volver a tus recomendaciones">
          <BookMark size={34} />
          <span className="rr-brand">Next Read <span style={{ color: PALETTE.terracottaDeep }}>Lab</span></span>
        </button>
        <nav className="rr-bar-nav">
          <button className="rr-topbar-btn" onClick={onRefresh} disabled={refreshing} title="Buscar otras recomendaciones">
            {refreshing ? <PulseDot /> : <RefreshCw size={14} strokeWidth={1.6} />}
            <span className="rr-topbar-label">{refreshing ? "buscando…" : "buscar otros"}</span>
          </button>
          <button className="rr-topbar-btn" onClick={onShowTrash} title="Ver descartados">
            <Trash2 size={14} strokeWidth={1.6} />
            <span className="rr-topbar-label">descartados</span>
            {dismissedCount > 0 && <span className="rr-count">{dismissedCount}</span>}
          </button>
          <button className="rr-topbar-btn" onClick={onReset} title="Cambiar de biblioteca">
            <RotateCcw size={14} strokeWidth={1.6} />
            <span className="rr-topbar-label">otra biblioteca</span>
          </button>
        </nav>
      </div>
    </header>
  );
}

function ConfirmModal({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  return (
    <div className="rr-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="rr-modal-title" onClick={onCancel}>
      <div className="rr-card rr-modal" onClick={(e) => e.stopPropagation()}>
        <h3 id="rr-modal-title" className="rr-title" style={{ fontSize: "18px", margin: "0 0 10px" }}>{title}</h3>
        <p style={{ fontSize: "14px", color: PALETTE.inkSoft, lineHeight: 1.6, margin: "0 0 22px" }}>{message}</p>
        <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button className="rr-link" onClick={onCancel}>{cancelLabel}</button>
          <button className="rr-btn rr-btn-filled" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function TrashView({ recs, onRestore, onRestoreAll, onBack }) {
  return (
    <div className="rr-detail">
      <button className="rr-link rr-back" onClick={onBack}>← todas las recomendaciones</button>
      <h2 className="rr-hero-title" style={{ fontSize: "30px" }}>Lo que has apartado</h2>
      <p className="rr-prose rr-soft" style={{ marginBottom: "22px" }}>
        {recs.length === 0
          ? "Aquí no hay nada todavía. Cuando descartes algo, lo guardo aquí por si cambias de idea."
          : recs.length === 1
          ? "Un libro que descartaste. Si cambias de idea, devuélvelo a la lista."
          : `${recs.length} libros que descartaste. Si cambias de idea, devuélvelos a la lista.`}
        {recs.length > 1 && <> <button className="rr-link" onClick={onRestoreAll}>devolverlos todos</button></>}
      </p>
      {recs.length > 0 && (
        <ul className="rr-later">
          {recs.map((r) => (
            <li key={r.id} style={{ cursor: "default" }}>
              <span className="rr-later-text"><strong className="rr-ink">{r.title}</strong>, de {r.authors?.[0] || "autor desconocido"}</span>
              <button className="rr-link" style={{ fontSize: "13px", flexShrink: 0 }} onClick={() => onRestore(r.id)}>devolver a la lista</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
function BookMark({ size = 72, animated = false }) {
  const h = Math.round(size * (123 / 192));
  return (
    <svg viewBox="24 35 192 123" width={size} height={h} style={{ display: "block", margin: "0 auto 10px" }} aria-hidden="true">
      <g transform="rotate(-2 120 100)">
        <line x1="120" y1="58" x2="120" y2="148" stroke={PALETTE.ink} strokeWidth="5" strokeLinecap="round" />
        <path d="M 120 62 C 95 56, 55 58, 34 68 C 32 100, 32 118, 36 142 C 58 150, 96 150, 120 144 Z"
              fill="none" stroke={PALETTE.ink} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M 120 62 C 145 56, 185 58, 206 68 C 208 100, 208 118, 204 142 C 182 150, 144 150, 120 144 Z"
              fill="none" stroke={PALETTE.ink} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path className={animated ? "rr-arc rr-arc-1" : undefined} d="M 52 96 Q 76 78, 100 96" fill="none" stroke={PALETTE.terracottaDeep} strokeWidth="4.5" strokeLinecap="round" />
        <path className={animated ? "rr-arc rr-arc-2" : undefined} d="M 46 108 Q 76 84, 106 108" fill="none" stroke={PALETTE.terracotta} strokeWidth="4.5" strokeLinecap="round" />
        <path className={animated ? "rr-arc rr-arc-3" : undefined} d="M 40 120 Q 76 90, 112 120" fill="none" stroke={PALETTE.sage} strokeWidth="4.5" strokeLinecap="round" />
        <path className={animated ? "rr-arc rr-arc-1" : undefined} d="M 188 96 Q 164 78, 140 96" fill="none" stroke={PALETTE.terracottaDeep} strokeWidth="4.5" strokeLinecap="round" />
        <path className={animated ? "rr-arc rr-arc-2" : undefined} d="M 194 108 Q 164 84, 134 108" fill="none" stroke={PALETTE.terracotta} strokeWidth="4.5" strokeLinecap="round" />
        <path className={animated ? "rr-arc rr-arc-3" : undefined} d="M 200 120 Q 164 90, 128 120" fill="none" stroke={PALETTE.sage} strokeWidth="4.5" strokeLinecap="round" />
        <circle cx="132" cy="46" r="4.5" fill={PALETTE.terracottaDeep} />
      </g>
    </svg>
  );
}

function PulseDot({ size = 14 }) {
  return <span className="rr-pulse-dot" style={{ width: size * 0.4, height: size * 0.4 }} aria-hidden="true" />;
}

function UndoBar({ onUndo, onClose, message = "Recomendación descartada.", actionLabel = "deshacer" }) {
  return (
    <div className="rr-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "14px 18px", marginTop: "14px", position: "sticky", bottom: "16px", background: PALETTE.white }}>
      <span style={{ fontSize: "13px" }}>{message}</span>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
        <button className="rr-link" onClick={onUndo}>{actionLabel}</button>
        <button className="rr-icon-btn" onClick={onClose} aria-label="Cerrar aviso" title="Cerrar">
          <X size={15} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      html, body { margin: 0; background: ${PALETTE.bg}; }
      .rr-title { font-family: 'DM Sans', sans-serif; font-weight: 700; color: ${PALETTE.ink}; margin: 0; }
      .rr-brand { font-family: 'Fraunces', serif; font-weight: 900; text-transform: uppercase; letter-spacing: 0.02em; color: ${PALETTE.ink}; margin: 0; }
      .rr-diamond {
        width: 6px; height: 6px; background: ${PALETTE.sage}; transform: rotate(45deg); margin: 14px auto 0;
        animation: rr-diamond-breathe 4s ease-in-out infinite;
      }
      @keyframes rr-diamond-breathe {
        0%, 100% { transform: rotate(45deg) scale(1); }
        50% { transform: rotate(45deg) scale(1.25); }
      }
      .rr-card { background: ${PALETTE.white}; border: 1px solid #EDE6D0; border-radius: 18px; box-shadow: 0 4px 16px rgba(78,34,15,0.06); }
      .rr-chip {
        font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 500; color: ${PALETTE.ink};
        border: 1.5px solid ${PALETTE.sage}; border-radius: 999px; padding: 7px 16px; cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
      }
      .rr-chip:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(78,34,15,0.12); }
      .rr-chip:active { transform: translateY(0); box-shadow: inset 0 1px 3px rgba(78,34,15,0.18); }
      .rr-select {
        font-family: 'DM Sans', sans-serif; font-weight: 400; font-size: 12px; border: 1.5px solid ${PALETTE.sage};
        border-radius: 999px; padding: 5px 26px 5px 12px; background: ${PALETTE.white}; color: ${PALETTE.ink}; cursor: pointer;
        appearance: none; -webkit-appearance: none; -moz-appearance: none;
      }
      .rr-dropdown { position: relative; display: inline-flex; }
      .rr-select-btn {
        font-family: 'DM Sans', sans-serif; font-weight: 500; font-size: 12px; border: 1.5px solid ${PALETTE.sage};
        border-radius: 999px; padding: 5px 12px; background: ${PALETTE.white}; color: ${PALETTE.ink};
        cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      }
      .rr-select-btn:hover { outline: 2px solid ${PALETTE.terracotta}; outline-offset: 2px; }
      .rr-dropdown-list {
        position: absolute; top: calc(100% + 6px); right: 0; min-width: 150px; z-index: 10;
        background: ${PALETTE.white}; border: 1px solid #EDE6D0; border-radius: 14px;
        box-shadow: 0 8px 24px rgba(78,34,15,0.14); padding: 6px; margin: 0; list-style: none;
      }
      .rr-dropdown-option {
        width: 100%; text-align: left; background: none; border: none; padding: 8px 12px; border-radius: 8px;
        font-family: 'DM Sans', sans-serif; font-weight: 500; font-size: 13px; color: ${PALETTE.ink}; cursor: pointer;
      }
      .rr-dropdown-option:hover { background: ${PALETTE.sageWash}; }
      .rr-btn {
        display: inline-flex; align-items: center; gap: 8px;
        font-family: 'DM Sans', sans-serif; font-weight: 500; font-size: 13px;
        border: none; border-radius: 999px; padding: 12px 26px;
        cursor: pointer; background: ${PALETTE.sageWash}; color: ${PALETTE.ink};
        transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .rr-btn:hover { transform: translateY(-1px); }
      .rr-btn:active { transform: scale(0.97); }
      .rr-btn-filled { background: ${PALETTE.terracottaDeep}; color: ${PALETTE.white}; }
      .rr-btn-filled:hover { background: #7a3e20; }
      .rr-link {
        display: inline-flex; align-items: center; gap: 6px;
        background: none; border: none; padding: 0; cursor: pointer;
        font-family: 'DM Sans', sans-serif; font-weight: 500; font-size: 13px; color: ${PALETTE.ink};
        text-decoration: underline; text-underline-offset: 3px; text-decoration-color: ${PALETTE.terracotta};
        transition: text-underline-offset 0.15s ease;
      }
      .rr-link:hover { text-underline-offset: 5px; }
      .rr-icon-btn {
        width: 26px; height: 26px; border: none; background: transparent; border-radius: 50%;
        color: ${PALETTE.inkSoft}; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        transition: background 0.15s ease, color 0.15s ease, transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .rr-icon-btn:hover { background: ${PALETTE.sageWash}; color: ${PALETTE.ink}; transform: scale(1.14); }
      .rr-icon-btn:active { transform: scale(0.88); }
      .wash { position: absolute; top: -160px; right: -140px; width: 380px; height: 380px; border-radius: 50%; background: ${PALETTE.sage}; opacity: 0.14; filter: blur(70px); pointer-events: none; z-index: 0; }
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
        outline: 2px solid ${PALETTE.terracotta}; outline-offset: 2px;
      }
      ::selection {
        background: ${PALETTE.terracotta};
        color: ${PALETTE.bg};
      }
      html {
        scrollbar-width: thin;
        scrollbar-color: ${PALETTE.terracotta} ${PALETTE.sageWash};
      }
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: ${PALETTE.sageWash}; }
      ::-webkit-scrollbar-thumb { background: ${PALETTE.terracotta}; border-radius: 999px; }
      ::-webkit-scrollbar-thumb:hover { background: ${PALETTE.terracottaDeep}; }
      .visually-hidden, .sr-only {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
      }
      .rr-arc { animation: rr-pulse-arc 1.6s ease-in-out infinite; }
      .rr-arc-2 { animation-delay: 0.18s; }
      .rr-arc-3 { animation-delay: 0.36s; }
      @keyframes rr-pulse-arc {
        0%, 100% { opacity: 0.22; }
        50% { opacity: 1; }
      }
      .rr-pulse-dot {
        display: inline-block; background: currentColor; transform: rotate(45deg);
        animation: rr-pulse-dot 1s ease-in-out infinite;
      }
      @keyframes rr-pulse-dot {
        0%, 100% { transform: rotate(45deg) scale(0.7); opacity: 0.5; }
        50% { transform: rotate(45deg) scale(1.15); opacity: 1; }
      }      
      .rr-topbar-btn {
        display: inline-flex; align-items: center; gap: 6px;
        font-family: 'DM Sans', sans-serif; font-weight: 500; font-size: 12px; color: ${PALETTE.ink};
        background: none; border: none; padding: 8px 12px; cursor: pointer; border-radius: 999px;
        transition: background 0.15s ease;
      }
      .rr-topbar-btn:hover { background: ${PALETTE.sageWash}; }
      .rr-topbar-btn:disabled { opacity: 0.6; cursor: default; }
      .rr-topbar-btn:disabled:hover { background: none; }
      @media (max-width: 480px) {
        .rr-topbar-label { display: none; }
        .rr-topbar-btn { padding: 8px; }
      }
      .rr-modal-overlay {
        position: fixed; inset: 0; background: rgba(78,34,15,0.35);
        display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 20;
      }
      .rr-modal { max-width: 380px; width: 100%; padding: 26px 28px; }
      @keyframes rr-fade-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .rr-screen { animation: rr-fade-in 0.22s ease both; }
      @media (prefers-reduced-motion: reduce) {
        .rr-diamond, .rr-screen, .rr-arc, .rr-pulse-dot { animation: none; }
      }

      /* ---- Cabecera compacta y pie ---- */
      .rr-bar { position: sticky; top: 0; z-index: 5; background: ${PALETTE.bg}; border-bottom: 1px solid #EDE6D0; padding-top: env(safe-area-inset-top); }
      .rr-bar-inner { max-width: 760px; margin: 0 auto; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .rr-bar-brand { display: flex; align-items: center; gap: 10px; background: none; border: none; padding: 0; cursor: pointer; }
      .rr-bar-brand svg { margin: 0 !important; }
      .rr-bar-brand .rr-brand { font-size: 19px; white-space: nowrap; }
      .rr-bar-nav { display: flex; gap: 2px; }
      .rr-count { background: ${PALETTE.terracottaDeep}; color: ${PALETTE.white}; font-size: 11px; font-weight: 700; border-radius: 999px; padding: 1px 7px; }
      .rr-footer { text-align: center; font-size: 13px; color: ${PALETTE.inkSoft}; padding: 40px 20px calc(40px + env(safe-area-inset-bottom)); }
      .rr-footer a { color: ${PALETTE.ink}; text-decoration-color: ${PALETTE.terracotta}; text-underline-offset: 3px; }

      /* ---- Portada y construcción ---- */
      .rr-pick { max-width: 560px; margin: 0 auto; }
      .rr-pitch { text-align: center; font-size: 22px; line-height: 1.35; margin: 0 0 30px; }
      .rr-drop { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; padding: 38px 28px; border-radius: 28px; background: ${PALETTE.sageWash}; cursor: pointer; transition: background 0.15s ease, transform 0.15s ease; }
      .rr-drop[data-dragging] { background: #D6DCC6; transform: scale(1.01); }
      .rr-drop:focus-within { outline: 2px solid ${PALETTE.terracotta}; outline-offset: 3px; }
      .rr-drop-title { font-size: 19px; font-weight: 700; margin: 0; }
      .rr-drop-sub { font-size: 14px; color: ${PALETTE.inkSoft}; margin: 4px 0 20px; line-height: 1.5; max-width: 30em; }
      .rr-help-toggle { margin: 14px auto 0; display: flex; }
      .rr-help { font-size: 14px; line-height: 1.6; color: ${PALETTE.inkSoft}; text-align: center; margin: 10px auto 0; max-width: 32em; }
      .rr-alt { margin-top: 40px; padding-top: 26px; border-top: 1px solid #E5DCC4; }
      .rr-alt p { font-size: 14px; line-height: 1.6; color: ${PALETTE.inkSoft}; margin: 0 0 14px; overflow-wrap: anywhere; }
      .rr-alt-row { display: flex; gap: 10px; }
      .rr-alt-row .rr-select { flex: 1; min-width: 0; padding: 10px 16px; }
      .rr-error { color: ${PALETTE.terracottaDeep} !important; margin-top: 10px !important; }
      .rr-confirm { text-align: center; padding: 36px 30px 32px; border-radius: 28px; background: ${PALETTE.sageWash}; }
      .rr-confirm-lead { font-size: 21px; font-weight: 700; line-height: 1.35; margin: 0 0 10px; }
      .rr-confirm-sub { font-size: 15px; line-height: 1.6; color: ${PALETTE.inkSoft}; margin: 0 auto 8px; max-width: 30em; }
      .rr-confirm-sub cite { font-style: normal; font-weight: 700; color: ${PALETTE.ink}; }
      .rr-confirm .rr-actions { margin-top: 22px; }
      .rr-confirm-file { font-size: 13px; color: ${PALETTE.inkSoft}; text-align: center; margin: 16px 0 0; overflow-wrap: anywhere; }
      .rr-building { text-align: center; padding-bottom: 20px; }
      .rr-steps { list-style: none; padding: 0; margin: 10px auto 0; display: inline-flex; flex-direction: column; gap: 12px; text-align: left; font-size: 16px; }
      .rr-steps li { display: flex; align-items: center; gap: 12px; }
      .rr-steps li[data-state="next"] { color: ${PALETTE.inkSoft}; opacity: 0.6; }
      .rr-steps li[data-state="now"] { font-weight: 700; }
      .rr-step-mark { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid ${PALETTE.sage}; display: inline-flex; align-items: center; justify-content: center; color: ${PALETTE.white}; flex-shrink: 0; }
      .rr-steps li[data-state="done"] .rr-step-mark { background: ${PALETTE.sage}; }
      .rr-steps li[data-state="now"] .rr-step-mark { border: 2px solid ${PALETTE.terracottaDeep}; }
      .rr-building-note { font-size: 13px; color: ${PALETTE.inkSoft}; max-width: 26em; margin: 30px auto 0; line-height: 1.6; }

      /* ---- Perfil: la balda con tus autores y la nota ---- */
      .rr-em { font-weight: 700; color: ${PALETTE.terracottaDeep}; }
      .rr-profile { display: grid; grid-template-columns: auto 1fr; gap: 36px; align-items: end; margin: 34px 0 30px; }
      .rr-shelf { display: inline-block; }
      .rr-spines { display: flex; align-items: flex-end; gap: 3px; padding: 0 14px; }
      .rr-spine { border-radius: 3px 3px 1px 1px; display: flex; align-items: center; justify-content: center; transform-origin: bottom left;
        box-shadow: inset -4px 0 0 rgba(0,0,0,0.08), inset 0 10px 0 rgba(255,255,255,0.06); }
      .rr-spine span { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-height: 88%; }
      .rr-board { height: 10px; border-radius: 3px; background: ${PALETTE.terracotta}; box-shadow: 0 6px 12px -6px rgba(78,34,15,0.5); }
      .rr-note { font-size: 17px; line-height: 1.6; margin: 0; padding-left: 20px; border-left: 3px solid ${PALETTE.sage}; }
      .rr-avoided { font-size: 13px; color: ${PALETTE.inkSoft}; margin: -8px 0 18px; }

      /* ---- Recomendaciones en tres niveles ---- */
      .rr-book-cover { flex-shrink: 0; border-radius: 3px 8px 8px 3px; background: ${PALETTE.sageWash}; overflow: hidden; display: flex; align-items: center; justify-content: center;
        box-shadow: inset 3px 0 0 rgba(0,0,0,0.12), 0 1px 2px rgba(78,34,15,0.18), 0 8px 18px -8px rgba(78,34,15,0.35); }
      .rr-book-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .rr-hero { display: grid; grid-template-columns: auto 1fr; gap: 32px; align-items: end; background: ${PALETTE.sageWash}; border-radius: 32px; padding: 36px 34px 40px; margin: 6px 0 46px; }
      .rr-hero-stand { display: flex; flex-direction: column; align-items: center; }
      .rr-hero-stand .rr-board { width: calc(100% + 36px); }
      .rr-hero-text { display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; padding-bottom: 10px; }
      .rr-kicker { font-size: 14px; font-weight: 700; color: ${PALETTE.terracottaDeep}; margin: 0 0 8px; }
      .rr-hero-title { font-size: 36px; line-height: 1.08; font-weight: 700; margin: 0; letter-spacing: -0.01em; color: ${PALETTE.ink}; }
      .rr-byline { font-size: 17px; color: ${PALETTE.inkSoft}; margin: 8px 0 0; }
      .rr-hero-why { font-size: 17px; line-height: 1.6; margin: 16px 0 0; max-width: 30em; }
      .rr-actions { display: flex; align-items: center; gap: 8px 18px; flex-wrap: wrap; margin-top: 20px; }
      .rr-link-quiet { text-decoration-color: transparent; color: ${PALETTE.inkSoft}; }
      .rr-link-quiet:hover { text-decoration-color: ${PALETTE.terracotta}; }
      .rr-ask { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; margin-top: 12px; }
      .rr-ask > span { margin-right: 4px; }
      .rr-ask .rr-chip { background: ${PALETTE.white}; }
      .rr-section-title { font-size: 20px; font-weight: 700; margin: 0 0 14px; }
      .rr-next-up { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-bottom: 46px; }
      .rr-next { display: flex; flex-direction: column; gap: 14px; cursor: pointer; }
      .rr-book-title { font: inherit; font-weight: 700; color: ${PALETTE.ink}; background: none; border: none; padding: 0; margin: 0; text-align: left; cursor: pointer;
        text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; transition: text-decoration-color 0.15s ease; }
      .rr-next:hover .rr-book-title, .rr-later li:hover .rr-book-title, .rr-book-title:focus-visible { text-decoration-color: ${PALETTE.terracotta}; }
      .rr-next .rr-book-title { font-size: 17px; line-height: 1.25; }
      .rr-byline-small { font-size: 15px; color: ${PALETTE.inkSoft}; }
      .rr-next-why { font-size: 14px; color: ${PALETTE.inkSoft}; line-height: 1.5; margin: 6px 0 4px; }
      .rr-icon-actions { display: flex; gap: 2px; flex-shrink: 0; margin-left: -6px; }
      .rr-later { list-style: none; margin: 0; padding: 0; border-top: 1px solid #EDE6D0; }
      .rr-later li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #EDE6D0; cursor: pointer; font-size: 16px; }
      .rr-later .rr-icon-actions { margin-left: 0; }
      .rr-later-text { color: ${PALETTE.inkSoft}; min-width: 0; }
      .rr-later-why { display: block; font-size: 14px; line-height: 1.45; margin-top: 2px; }
      .rr-ink { color: ${PALETTE.ink}; }
      .rr-empty { font-size: 15px; color: ${PALETTE.inkSoft}; padding: 24px 0; }

      /* ---- Ficha y descartados ---- */
      .rr-detail { padding: 28px 0 60px; }
      .rr-back { margin-bottom: 26px; }
      .rr-detail-head { display: flex; gap: 28px; align-items: center; }
      .rr-facts { font-size: 14px; color: ${PALETTE.inkSoft}; margin: 6px 0 0; }
      .rr-why { margin: 34px 0 6px; padding: 4px 0 4px 22px; border-left: 3px solid ${PALETTE.terracotta}; font-size: 20px; line-height: 1.55; max-width: 32em; }
      .rr-detail-title { font-size: 17px; font-weight: 700; margin: 34px 0 8px; }
      .rr-prose { font-size: 16px; line-height: 1.7; margin: 0 0 12px; max-width: 38em; }
      .rr-soft { color: ${PALETTE.inkSoft}; }
      .rr-synopsis > .rr-link { margin-top: 2px; }
      .rr-buy { background: ${PALETTE.sageWash}; border-radius: 22px; padding: 22px 26px 12px; margin-top: 34px; }

      /* ---- Responsive / iPhone como app instalada ---- */
      .rr-header {
        padding: max(50px, env(safe-area-inset-top)) 40px 22px;
      }
      .rr-h1 { font-size: 38px; }
      .rr-main {
        padding: 8px 40px calc(90px + env(safe-area-inset-bottom));
      }
      @media (max-width: 600px) {
        .rr-header { padding: max(32px, env(safe-area-inset-top)) 20px 18px; }
        .rr-h1 { font-size: 28px; }
        .rr-main { padding: 8px 16px calc(70px + env(safe-area-inset-bottom)); }
        /* Zonas táctiles de al menos 44px, el mínimo recomendado en iOS */
        .rr-icon-btn { width: 40px; height: 40px; }
        .rr-btn { padding: 13px 22px; }
        .rr-chip { padding: 9px 14px; }
        .rr-bar-inner { padding: 8px 12px; }
        .rr-bar-brand .rr-brand { font-size: 16px; }
        .rr-bar-brand svg { width: 28px; }
        .rr-pitch { font-size: 20px; }
        .rr-profile { grid-template-columns: 1fr; gap: 24px; margin-top: 22px; }
        .rr-profile .rr-shelf { order: 2; justify-self: start; }
        .rr-note { font-size: 16px; }
        /* En móvil, la portada va junto al título y la razón ocupa todo el ancho */
        .rr-hero { padding: 24px 20px 26px; gap: 0 20px; align-items: end; }
        .rr-hero .rr-book-cover { width: 96px !important; height: 144px !important; }
        .rr-hero-stand .rr-board { width: calc(100% + 16px); height: 7px; }
        .rr-hero-text { display: contents; }
        .rr-hero-head { align-self: end; }
        .rr-hero-body { grid-column: 1 / -1; }
        .rr-hero-title { font-size: 24px; }
        .rr-next-up { grid-template-columns: 1fr; gap: 20px; }
        .rr-next { flex-direction: row; }
        .rr-next .rr-book-cover { width: 72px !important; height: 108px !important; }
        .rr-detail-head { flex-direction: column; align-items: flex-start; gap: 20px; }
        .rr-why { font-size: 18px; }
      }
      /* Evita el zoom automático de iOS al enfocar un <select> (exige 16px mínimo) */
      .rr-select { font-size: 16px; }
      @media (min-width: 601px) {
        .rr-select { font-size: 12px; }
      }
    `}</style>
  );
}
