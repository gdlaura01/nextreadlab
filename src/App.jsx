import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import {
  BookOpen, Upload, Loader2, Star, X, ChevronDown, Check, RotateCcw,
  FileText, Bookmark, BookmarkCheck, ExternalLink, Home, Trash2, RefreshCw,
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

async function fetchGoodreadsShelf(userId, shelf) {
  const goodreadsUrl = `https://www.goodreads.com/review/list_rss/${userId}?shelf=${shelf}`;
  let lastError = new Error("No se pudo leer esa estantería.");
  for (const buildProxyUrl of CORS_PROXIES) {
    try {
      const r = await fetch(buildProxyUrl(goodreadsUrl));
      if (!r.ok) {
        lastError = new Error(`El servicio intermediario respondió con un error (${r.status}).`);
        continue;
      }
      const xmlText = await r.text();
      const rows = parseGoodreadsRssXml(xmlText, shelf);
      if (rows === null) {
        lastError = new Error("La respuesta no tenía el formato esperado.");
        continue;
      }
      return rows;
    } catch (e) {
      lastError = e;
      // seguimos con el siguiente proxy de la lista
    }
  }
  throw lastError;
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
  let anySucceeded = false;
  for (const shelf of GOODREADS_SHELVES) {
    try {
      const rows = await fetchGoodreadsShelf(cleanId, shelf);
      results.push(...rows);
      anySucceeded = true;
    } catch {
      // seguimos con las demás estanterías aunque una falle
    }
    await sleep(300);
  }
  if (!anySucceeded) {
    throw new Error("No he podido conectar con esa cuenta. Comprueba que el ID es correcto y que tu perfil de Goodreads es público (Configuración → Perfil).");
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
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(withKey(url));
    if (r.status !== 429) return r;
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
  const [profileCollapsed, setProfileCollapsed] = useState(false);
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
    setPreviousRecs(allRecs);
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
      setAllRecs(nextRecs);
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
    if (reason === "genre" && matchedGenres?.length) {
      setAvoidedGenres((prev) => {
        const next = new Set(prev);
        matchedGenres.forEach((g) => next.add(g));
        return next;
      });
      setAnnouncement(`Recomendación descartada. Bajaremos el peso de "${matchedGenres[0]}" en el resto de sugerencias.`);
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

  const allDismissed = allRecs.length > 0 && dismissed.size === allRecs.length;

  return (
    <div style={{ background: PALETTE.bg, minHeight: "100vh", fontFamily: "'Karla', sans-serif", color: PALETTE.ink, position: "relative" }}>
      <GlobalStyle />
      <div className="wash" />
      <div aria-live="polite" className="sr-only">{announcement}</div>

      <header className="rr-header" style={{ maxWidth: "720px", margin: "0 auto", textAlign: "center", position: "relative", zIndex: 1 }}>
        <div style={{ fontSize: "12px", color: PALETTE.inkSoft, marginBottom: "8px" }}>a partir de tu Goodreads</div>
        <h1
          ref={!selectedBook ? headingRef : null}
          tabIndex={-1}
          className="rr-title rr-h1"
          style={{ margin: 0, outline: "none" }}
        >
          Next Read Lab
        </h1>
        <div className="rr-diamond" />
      </header>

      {stage === "ready" && profile && (
        <TopBar
          dismissedCount={dismissed.size}
          onHome={() => { setSelectedBook(null); setShowTrash(false); }}
          onReset={requestReset}
          onShowTrash={() => { setShowTrash(true); setSelectedBook(null); }}
          onRefresh={refreshResults}
          refreshing={refreshing}
        />
      )}

      {confirmingReset && (
        <ConfirmModal
          title="¿Analizar otro CSV?"
          message={`Vas a perder ${saved.size > 0 ? `${saved.size} libro(s) guardado(s)` : ""}${saved.size > 0 && dismissed.size > 0 ? " y " : ""}${dismissed.size > 0 ? `${dismissed.size} descarte(s)` : ""} de esta sesión. Esta acción no se puede deshacer.`}
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
                <ProfilePanel profile={profile} collapsed={profileCollapsed} onToggleCollapsed={() => setProfileCollapsed((c) => !c)} />
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
                  <div style={{ fontSize: "12px", color: PALETTE.inkSoft, marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span>Bajando el peso de: {Array.from(avoidedGenres).join(", ")}</span>
                    <button className="rr-link" style={{ fontSize: "12px" }} onClick={forgetAvoidedGenres}>olvidar</button>
                  </div>
                )}
                {allDismissed ? (
                  <div className="rr-card" style={{ padding: "26px", textAlign: "center" }}>
                    <p style={{ fontSize: "14px", marginBottom: "14px" }}>Has descartado todas las recomendaciones.</p>
                    <button className="rr-btn" onClick={restoreAllDismissed}>volver a mostrarlas todas</button>
                  </div>
                ) : (
                  <RecommendationsPanel
                    recs={visibleRecs}
                    saved={saved}
                    onDismiss={dismissRec}
                    onToggleSaved={toggleSaved}
                    onSelect={setSelectedBook}
                  />
                )}
                {lastDismissedId && !allDismissed && <UndoBar onUndo={() => undoDismiss(lastDismissedId)} />}
                {previousRecs && <UndoBar message="Recomendaciones actualizadas." actionLabel="deshacer actualización" onUndo={undoRefresh} />}
              </>
            )}
          </>
        )}
        </div>
      </main>
    </div>
  );
}

function PickPane({ onSelect, fileInputRef, syncStatus, onAccessSynced, onConnect, onSwitchUser, connecting, connectError }) {
  const [dragging, setDragging] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [userId, setUserId] = useState("");

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px", marginBottom: "22px" }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); onSelect(e.dataTransfer.files?.[0]); }}
          className="rr-card"
          style={{ padding: "30px 26px", textAlign: "center", background: dragging ? PALETTE.sageWash : PALETTE.white }}
        >
          <Upload size={22} color={PALETTE.terracotta} strokeWidth={1.4} style={{ marginBottom: "14px" }} />
          <p className="rr-title" style={{ fontSize: "17px", marginBottom: "8px" }}>Sube tu CSV</p>
          <p style={{ fontSize: "13px", color: PALETTE.inkSoft, marginBottom: "20px", lineHeight: 1.5 }}>
            Exporta tu biblioteca desde Goodreads y súbela aquí. Puedes arrastrar el archivo sobre esta tarjeta.
          </p>
          <label className="rr-btn" style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
            <Upload size={14} strokeWidth={1.4} />
            elegir archivo
            <input ref={fileInputRef} type="file" accept=".csv" className="visually-hidden" onChange={(e) => onSelect(e.target.files?.[0])} />
          </label>
        </div>

        <div className="rr-card" style={{ padding: "30px 26px", textAlign: "center" }}>
          <RefreshCw size={22} color={PALETTE.ink} strokeWidth={1.4} style={{ marginBottom: "14px" }} />
          <p className="rr-title" style={{ fontSize: "17px", marginBottom: "8px" }}>Accede a tu Next Read Lab</p>

          {syncStatus === "checking" && (
            <p style={{ fontSize: "13px", color: PALETTE.inkSoft }}>Comprobando…</p>
          )}

          {syncStatus === "available" && (
            <>
              <p style={{ fontSize: "13px", color: PALETTE.inkSoft, marginBottom: "20px", lineHeight: 1.5 }}>
                Tu cuenta de Goodreads ya está conectada en este navegador. Entra directamente, sin subir ningún archivo.
              </p>
              <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
                <button className="rr-btn rr-btn-filled" onClick={onAccessSynced}>
                  <Check size={14} strokeWidth={1.6} /> entrar
                </button>
                <button className="rr-link" onClick={onSwitchUser} style={{ fontSize: "12px" }}>
                  cambiar de usuario
                </button>
              </div>
            </>
          )}

          {syncStatus === "unavailable" && (
            <>
              <p style={{ fontSize: "13px", color: PALETTE.inkSoft, marginBottom: "16px", lineHeight: 1.5 }}>
                Escribe tu ID de Goodreads y te conectamos directamente, sin instalar ni ejecutar nada.
              </p>
              <input
                type="text"
                inputMode="numeric"
                placeholder="tu ID de Goodreads, ej. 12345678"
                value={userId}
                onChange={(e) => setUserId(e.target.value.replace(/[^0-9]/g, ""))}
                className="rr-select"
                style={{ width: "100%", marginBottom: "12px", textAlign: "center" }}
                disabled={connecting}
              />
              <button
                className="rr-btn rr-btn-filled"
                onClick={() => onConnect(userId)}
                disabled={connecting || !userId}
                style={{ display: "inline-flex", alignItems: "center", gap: "8px", opacity: connecting || !userId ? 0.6 : 1 }}
              >
                {connecting ? <Loader2 size={14} strokeWidth={1.8} style={{ animation: "spin 0.8s linear infinite" }} /> : <RefreshCw size={14} strokeWidth={1.4} />}
                {connecting ? "conectando…" : "conectar con Goodreads"}
              </button>
              {connectError && (
                <p style={{ fontSize: "12px", color: PALETTE.terracottaDeep, marginTop: "10px", lineHeight: 1.5 }}>{connectError}</p>
              )}
              <p style={{ fontSize: "12px", color: PALETTE.inkSoft, marginTop: "14px", lineHeight: 1.6 }}>
                Tu ID aparece en la URL de tu perfil de Goodreads
                (goodreads.com/user/show/<strong>12345678</strong>-tu-nombre).
                Tu perfil debe ser público (Settings → Profile) para que esto funcione.
              </p>
            </>
          )}
        </div>
      </div>

      <button className="rr-link" onClick={() => setShowHelp((s) => !s)} aria-expanded={showHelp}>
        <ChevronDown size={12} strokeWidth={1.4} style={{ transform: showHelp ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }} />
        ¿no sabes cómo conseguir el CSV?
      </button>
      {showHelp && (
        <div className="rr-card" style={{ marginTop: "12px", padding: "20px 24px" }}>
          <ol style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", lineHeight: 1.9, color: PALETTE.inkSoft }}>
            <li>Entra en Goodreads desde el navegador e inicia sesión.</li>
            <li>Ve a <strong style={{ color: PALETTE.ink }}>My Books</strong>.</li>
            <li>En el menú lateral, <strong style={{ color: PALETTE.ink }}>Tools → Import and export</strong>.</li>
            <li>Pulsa <strong style={{ color: PALETTE.ink }}>Export Library</strong> y descarga el archivo.</li>
          </ol>
        </div>
      )}

      <p style={{ fontSize: "12px", color: PALETTE.inkSoft, marginTop: "26px" }}>
        Tu archivo se procesa solo en este navegador: no se envía a ningún servidor.
      </p>
    </div>
  );
}

function ConfirmPane({ file, onConfirm, onCancel }) {
  const sizeKb = Math.round(file.size / 1024);
  return (
    <div className="rr-card" style={{ padding: "30px 32px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "20px" }}>
        <div style={{ width: "42px", height: "42px", flexShrink: 0, borderRadius: "50%", background: PALETTE.sageWash, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <FileText size={19} color={PALETTE.ink} strokeWidth={1.3} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
          <div style={{ fontSize: "12px", color: PALETTE.inkSoft }}>{sizeKb} KB</div>
        </div>
      </div>
      <p style={{ fontSize: "13px", color: PALETTE.inkSoft, marginBottom: "24px", lineHeight: 1.6 }}>
        Voy a leer este archivo y generar recomendaciones a partir de tus valoraciones. Todo ocurre aquí mismo, en tu navegador.
      </p>
      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
        <button className="rr-btn rr-btn-filled" onClick={onConfirm}>
          <Check size={14} strokeWidth={1.6} /> analizar mi biblioteca
        </button>
        <button className="rr-link" onClick={onCancel}>elegir otro archivo</button>
      </div>
    </div>
  );
}

function BuildingPane({ statusMsg }) {
  return (
    <div className="rr-card" style={{ padding: "60px 30px", textAlign: "center" }}>
      <Loader2 size={26} style={{ animation: "spin 0.9s linear infinite", color: PALETTE.terracotta }} />
      <p style={{ marginTop: "18px", fontSize: "14px", color: PALETTE.inkSoft }}>{statusMsg}</p>
    </div>
  );
}

function ProfilePanel({ profile, collapsed, onToggleCollapsed }) {
  return (
    <section style={{ marginBottom: "32px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: collapsed ? 0 : "16px" }}>
        <div style={{ fontSize: "12px", color: PALETTE.inkSoft }}>
          {profile.fileName ? `${profile.fileName} · ` : ""}{profile.totalRead} libros leídos
        </div>
        <button className="rr-link" onClick={onToggleCollapsed} aria-expanded={!collapsed} style={{ fontSize: "12px" }}>
          {collapsed ? "mostrar ficha de lectora" : "ocultar"}
          <ChevronDown size={12} strokeWidth={1.6} style={{ transform: collapsed ? "none" : "rotate(180deg)", transition: "transform 0.15s ease" }} />
        </button>
      </div>
      {!collapsed && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "16px" }}>
          <div className="rr-card" style={{ padding: "18px 20px", background: PALETTE.sageWash }}>
            <div className="rr-label">autores que más repites</div>
            <div style={{ fontSize: "14px", lineHeight: 1.5, marginTop: "8px" }}>{profile.topAuthors.length ? profile.topAuthors.slice(0, 4).join(", ") : "sin datos suficientes"}</div>
          </div>
          <div className="rr-card" style={{ padding: "18px 20px", background: PALETTE.white }}>
            <div className="rr-label">géneros dominantes</div>
            <div style={{ fontSize: "14px", lineHeight: 1.5, marginTop: "8px" }}>{profile.topGenres.length ? profile.topGenres.slice(0, 4).join(", ") : "sin datos suficientes"}</div>
          </div>
          <div className="rr-card" style={{ padding: "18px 20px", background: "#F4EFDE" }}>
            <div className="rr-label">extensión media</div>
            <div style={{ fontSize: "14px", lineHeight: 1.5, marginTop: "8px" }}>{profile.avgPages ? `${profile.avgPages} páginas` : "sin datos"}</div>
          </div>
        </div>
      )}
    </section>
  );
}

function FilterBar({ topGenres, hasAuthorMatches, hasSaved, activeGenre, setActiveGenre, sortBy, setSortBy }) {
  const chips = [
    "todos",
    ...topGenres.slice(0, 4),
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
              {g}
            </button>
          );
        })}
      </div>
      <label style={{ fontSize: "12px", color: PALETTE.inkSoft, display: "flex", alignItems: "center", gap: "8px" }}>
        ordenar
        <select className="rr-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="relevancia">relevancia</option>
          <option value="valoracion">valoración</option>
        </select>
      </label>
    </div>
  );
}

function RecommendationsPanel({ recs, saved, onDismiss, onToggleSaved, onSelect }) {
  const [askingId, setAskingId] = useState(null);
  if (!recs.length) {
    return <p style={{ fontSize: "14px", color: PALETTE.inkSoft }}>No queda ninguna recomendación con este filtro. Prueba con "todos".</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {recs.map((r) => {
        const isSaved = saved.has(r.id);
        const isAsking = askingId === r.id;
        return (
          <div
            key={r.id}
            className="rr-card rr-card-clickable"
            role="button"
            tabIndex={0}
            onClick={() => !isAsking && onSelect(r)}
            onKeyDown={(e) => { if (!isAsking && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(r); } }}
            style={{ padding: "18px 20px", display: "flex", gap: "16px", background: PALETTE.white, cursor: isAsking ? "default" : "pointer" }}
          >
            <div style={{ width: "60px", height: "86px", flexShrink: 0, borderRadius: "10px", background: PALETTE.sageWash, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
              {r.thumbnail ? (
                <img src={r.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <BookOpen size={18} strokeWidth={1.3} color={PALETTE.ink} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                <div className="rr-title" style={{ fontSize: "16px" }}>{r.title}</div>
                {!isAsking && (
                  <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
                    <button
                      className="rr-icon-btn"
                      onClick={(e) => { e.stopPropagation(); onToggleSaved(r.id); }}
                      aria-label={isSaved ? `Quitar ${r.title} de guardados` : `Guardar ${r.title} para más tarde`}
                      title={isSaved ? "Guardado" : "Guardar para más tarde"}
                    >
                      {isSaved ? <BookmarkCheck size={15} strokeWidth={1.6} color={PALETTE.terracotta} /> : <Bookmark size={15} strokeWidth={1.6} />}
                    </button>
                    <button
                      className="rr-icon-btn"
                      onClick={(e) => { e.stopPropagation(); setAskingId(r.id); }}
                      aria-label={`Descartar ${r.title}`}
                      title="No me interesa"
                    >
                      <X size={15} strokeWidth={1.6} />
                    </button>
                  </div>
                )}
              </div>

              {isAsking ? (
                <div onClick={(e) => e.stopPropagation()} style={{ marginTop: "6px" }}>
                  <p style={{ fontSize: "12px", color: PALETTE.inkSoft, margin: "0 0 8px 0" }}>¿Por qué descartas esta recomendación?</p>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <button
                      className="rr-chip"
                      style={{ borderColor: PALETTE.sage }}
                      onClick={() => { onDismiss(r.id, "genre", r.matchedGenres); setAskingId(null); }}
                    >
                      no me interesa este género
                    </button>
                    <button
                      className="rr-chip"
                      style={{ borderColor: PALETTE.sage }}
                      onClick={() => { onDismiss(r.id, "read"); setAskingId(null); }}
                    >
                      ya lo he leído
                    </button>
                    <button className="rr-link" style={{ fontSize: "12px" }} onClick={() => setAskingId(null)}>cancelar</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: "12px", color: PALETTE.inkSoft, marginBottom: "8px" }}>{r.authors.join(", ") || "Autor desconocido"}</div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    {r.averageRating > 0 && (
                      <span style={{ fontSize: "12px", color: PALETTE.inkSoft, display: "flex", alignItems: "center", gap: "3px" }}>
                        <Star size={11} strokeWidth={1.3} color={PALETTE.terracotta} fill={PALETTE.terracotta} /> {r.averageRating.toFixed(1)}
                      </span>
                    )}
                    {r.authorMatch && <span className="rr-pill">autor afín</span>}
                    {r.matchedGenres.slice(0, 2).map((g) => <span key={g} className="rr-pill">{g}</span>)}
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BookDetailScreen({ book, onBack, isSaved, onToggleSaved, headingRef }) {
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

  return (
    <div style={{ padding: "24px 0 60px" }}>
      <button className="rr-link" onClick={onBack} style={{ marginBottom: "22px" }}>
        ← volver a las recomendaciones
      </button>

      <div style={{ display: "flex", gap: "22px", marginBottom: "28px", flexWrap: "wrap" }}>
        <div style={{ width: "104px", height: "150px", flexShrink: 0, borderRadius: "10px", background: PALETTE.sageWash, border: "1px solid #EDE6D0", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {book.thumbnail ? (
            <img src={book.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <BookOpen size={34} strokeWidth={1.1} color={PALETTE.ink} />
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 ref={headingRef} tabIndex={-1} className="rr-title" style={{ fontSize: "24px", margin: "0 0 4px", outline: "none" }}>
            {book.title}
          </h2>
          <div style={{ fontSize: "14px", color: PALETTE.inkSoft, marginBottom: "10px" }}>{book.authors?.join(", ")}</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "14px" }}>
            {book.averageRating > 0 && (
              <span style={{ fontSize: "12px", color: PALETTE.inkSoft, display: "flex", alignItems: "center", gap: "3px" }}>
                <Star size={12} strokeWidth={1.3} color={PALETTE.terracotta} fill={PALETTE.terracotta} /> {book.averageRating.toFixed(1)}
              </span>
            )}
            {book.authorMatch && <span className="rr-pill">autor afín</span>}
            {book.matchedGenres?.slice(0, 3).map((g) => <span key={g} className="rr-pill">{g}</span>)}
          </div>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <button className="rr-btn" onClick={onToggleSaved} style={{ background: isSaved ? PALETTE.sageWash : PALETTE.sageWash }}>
              {isSaved ? <BookmarkCheck size={14} strokeWidth={1.6} /> : <Bookmark size={14} strokeWidth={1.6} />}
              {isSaved ? "guardado" : "guardar para más tarde"}
            </button>
            {book.infoLink && (
              <a className="rr-link" href={book.infoLink} target="_blank" rel="noreferrer">
                ver en Google Books <ExternalLink size={12} strokeWidth={1.6} />
              </a>
            )}
          </div>
        </div>
      </div>

      <DetailSection title="Sinopsis">
        <p style={{ fontSize: "14px", lineHeight: 1.7, margin: 0 }}>
          {book.description || "No hay sinopsis disponible para esta edición en Google Books."}
        </p>
      </DetailSection>

      <DetailSection title="Por qué te lo recomendamos">
        <p style={{ fontSize: "14px", lineHeight: 1.7, margin: 0 }}>
          {[
            book.authorMatch && "Ya sigues a este autor en tu biblioteca.",
            book.matchedGenres?.length ? `Coincide con géneros que lees a menudo: ${book.matchedGenres.slice(0, 3).join(", ")}.` : null,
            book.averageRating >= 4 ? "Además, tiene muy buena valoración media entre otros lectores." : null,
          ].filter(Boolean).join(" ") || "Encaja con el perfil general de tu biblioteca."}
        </p>
      </DetailSection>

      <DetailSection title="Mejor edición para comprar">
        {editionLoading ? (
          <p style={{ fontSize: "13px", color: PALETTE.inkSoft, margin: 0 }}>Buscando la edición en español…</p>
        ) : edition?.publisher ? (
          <>
            <p style={{ fontSize: "14px", lineHeight: 1.7, margin: 0 }}>
              {edition.publisher}{edition.publishedDate ? ` (${edition.publishedDate.slice(0, 4)})` : ""}.
              {edition.infoLink && (
                <>
                  {" "}
                  <a href={edition.infoLink} target="_blank" rel="noreferrer" className="rr-link" style={{ fontSize: "13px" }}>
                    ver ficha
                  </a>
                </>
              )}
            </p>
            <p style={{ fontSize: "12px", color: PALETTE.inkSoft, marginTop: "8px", lineHeight: 1.6 }}>
              {publisherNote
                ? `Por qué esta: ${publisherNote}`
                : edition.candidateCount > 1
                ? "Por qué esta: es la edición en español con más datos confirmados (editorial y fecha) entre varias encontradas en Google Books."
                : "Por qué esta: es la única edición en español que Google Books tiene catalogada con editorial identificada para este título."}
            </p>
          </>
        ) : (
          <p style={{ fontSize: "13px", color: PALETTE.inkSoft, margin: 0 }}>
            No he encontrado una edición en español confirmada en Google Books; compruébalo en tu librería habitual.
          </p>
        )}
      </DetailSection>

      {needsTranslation && (
        <DetailSection title="Sobre la traducción">
          {translatorLoading ? (
            <p style={{ fontSize: "13px", color: PALETTE.inkSoft, margin: 0 }}>Buscando el traductor…</p>
          ) : translator ? (
            <>
              <p style={{ fontSize: "14px", lineHeight: 1.7, margin: 0 }}>
                Traducción de <strong>{translator}</strong>{edition?.publisher ? ` para ${edition.publisher}` : ""}.
              </p>
              <p style={{ fontSize: "12px", color: PALETTE.inkSoft, marginTop: "8px", lineHeight: 1.6 }}>
                Por qué esta: es el nombre que figura como traductor en la ficha bibliográfica de Open Library
                para esta edición (ISBN {edition?.isbn}). Es un dato de catálogo, no una valoración de calidad —
                verifícalo igualmente en el propio libro antes de comprar.
              </p>
            </>
          ) : (
            <p style={{ fontSize: "13px", color: PALETTE.inkSoft, lineHeight: 1.7, margin: 0 }}>
              Este libro se escribió originalmente en otro idioma, pero no he encontrado el nombre del traductor
              en las fuentes que consulto (Google Books y Open Library no lo tienen catalogado para esta edición,
              o no he podido acceder a esos datos). No quiero inventarte un nombre, así que
              {publisherNote ? " revisa el colofón del libro: " : " revisa el colofón del libro antes de comprar, especialmente si es un clásico con varias traducciones en circulación. "}
              {publisherNote}
            </p>
          )}
        </DetailSection>
      )}
    </div>
  );
}

function DetailSection({ title, children }) {
  return (
    <div className="rr-card" style={{ padding: "18px 20px", marginBottom: "14px" }}>
      <div className="rr-label" style={{ marginBottom: "8px" }}>{title}</div>
      {children}
    </div>
  );
}

function TopBar({ dismissedCount, onHome, onReset, onShowTrash, onRefresh, refreshing }) {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 5, background: PALETTE.bg, borderBottom: "1px solid #EDE6D0" }}>
      <div style={{ maxWidth: "700px", margin: "0 auto", padding: "10px 40px", display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" }}>
        <button className="rr-topbar-btn" onClick={onHome} title="Inicio">
          <Home size={13} strokeWidth={1.6} /> <span className="rr-topbar-label">inicio</span>
        </button>
        <button className="rr-topbar-btn" onClick={onReset} title="Analizar otro CSV">
          <RotateCcw size={13} strokeWidth={1.6} /> <span className="rr-topbar-label">analizar otro csv</span>
        </button>
        <button className="rr-topbar-btn" onClick={onShowTrash} title="Ver descartados">
          <Trash2 size={13} strokeWidth={1.6} /> <span className="rr-topbar-label">descartados{dismissedCount > 0 ? ` (${dismissedCount})` : ""}</span>
        </button>
        <button className="rr-topbar-btn" onClick={onRefresh} disabled={refreshing} title="Actualizar resultados">
          {refreshing ? <Loader2 size={13} strokeWidth={1.8} style={{ animation: "spin 0.8s linear infinite" }} /> : <RefreshCw size={13} strokeWidth={1.6} />}
          <span className="rr-topbar-label">{refreshing ? "actualizando…" : "actualizar resultados"}</span>
        </button>
      </div>
    </div>
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
    <div style={{ padding: "24px 0 60px" }}>
      <button className="rr-link" onClick={onBack} style={{ marginBottom: "22px" }}>
        ← volver a las recomendaciones
      </button>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "18px", flexWrap: "wrap", gap: "10px" }}>
        <h2 className="rr-title" style={{ fontSize: "20px", margin: 0 }}>Descartados</h2>
        {recs.length > 0 && <button className="rr-link" onClick={onRestoreAll}>restaurar todos</button>}
      </div>
      {recs.length === 0 ? (
        <p style={{ fontSize: "14px", color: PALETTE.inkSoft }}>No has descartado ninguna recomendación todavía.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {recs.map((r) => (
            <div key={r.id} className="rr-card" style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: "14px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="rr-title" style={{ fontSize: "15px" }}>{r.title}</div>
                <div style={{ fontSize: "12px", color: PALETTE.inkSoft }}>{r.authors?.join(", ")}</div>
              </div>
              <button className="rr-btn" onClick={() => onRestore(r.id)} style={{ padding: "8px 16px", fontSize: "12px" }}>
                restaurar
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UndoBar({ onUndo, message = "Recomendación descartada.", actionLabel = "deshacer" }) {
  return (
    <div className="rr-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", marginTop: "14px", position: "sticky", bottom: "16px", background: PALETTE.white }}>
      <span style={{ fontSize: "13px" }}>{message}</span>
      <button className="rr-link" onClick={onUndo}>{actionLabel}</button>
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Karla:wght@400;500;600&display=swap');
      * { box-sizing: border-box; }
      .rr-title { font-family: 'Fraunces', serif; font-weight: 500; color: ${PALETTE.ink}; margin: 0; }
      .rr-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: ${PALETTE.inkSoft}; }
      .rr-diamond { width: 6px; height: 6px; background: ${PALETTE.sage}; transform: rotate(45deg); margin: 14px auto 0; }
      .rr-card { background: ${PALETTE.white}; border: 1px solid #EDE6D0; border-radius: 18px; box-shadow: 0 4px 16px rgba(78,34,15,0.06); }
      .rr-card-clickable { transition: transform 0.12s ease, box-shadow 0.12s ease; }
      .rr-card-clickable:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(78,34,15,0.09); }
      .rr-pill { font-size: 11px; color: ${PALETTE.ink}; background: ${PALETTE.sageWash}; border-radius: 999px; padding: 3px 11px; }
      .rr-chip {
        font-family: 'Karla', sans-serif; font-size: 12px; font-weight: 500; color: ${PALETTE.ink};
        border: 1.5px solid ${PALETTE.sage}; border-radius: 999px; padding: 7px 16px; cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      .rr-select {
        font-family: 'Karla', sans-serif; font-size: 12px; border: 1.5px solid ${PALETTE.sage};
        border-radius: 999px; padding: 5px 12px; background: ${PALETTE.white}; color: ${PALETTE.ink}; cursor: pointer;
      }
      .rr-btn {
        display: inline-flex; align-items: center; gap: 8px;
        font-family: 'Karla', sans-serif; font-weight: 600; font-size: 13px;
        border: none; border-radius: 999px; padding: 12px 26px;
        cursor: pointer; background: ${PALETTE.sageWash}; color: ${PALETTE.ink};
        transition: transform 0.12s ease;
      }
      .rr-btn:hover { transform: translateY(-1px); }
      .rr-btn-filled { background: ${PALETTE.terracottaDeep}; color: ${PALETTE.white}; }
      .rr-btn-filled:hover { background: #7a3e20; }
      .rr-link {
        display: inline-flex; align-items: center; gap: 6px;
        background: none; border: none; padding: 0; cursor: pointer;
        font-family: 'Karla', sans-serif; font-weight: 600; font-size: 13px; color: ${PALETTE.ink};
        text-decoration: underline; text-underline-offset: 3px; text-decoration-color: ${PALETTE.terracotta};
      }
      .rr-icon-btn {
        width: 26px; height: 26px; border: none; background: transparent; border-radius: 50%;
        color: ${PALETTE.inkSoft}; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      .rr-icon-btn:hover { background: ${PALETTE.sageWash}; color: ${PALETTE.ink}; }
      .wash { position: absolute; top: -160px; right: -140px; width: 380px; height: 380px; border-radius: 50%; background: ${PALETTE.sage}; opacity: 0.14; filter: blur(70px); pointer-events: none; z-index: 0; }
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
        outline: 2px solid ${PALETTE.terracotta}; outline-offset: 2px;
      }
      .visually-hidden, .sr-only {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .rr-topbar-btn {
        display: inline-flex; align-items: center; gap: 6px;
        font-family: 'Karla', sans-serif; font-size: 12px; font-weight: 500; color: ${PALETTE.ink};
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
        .rr-screen { animation: none; }
      }

      /* ---- Responsive / iPhone como app instalada ---- */
      .rr-header {
        padding: max(50px, env(safe-area-inset-top)) 40px 22px;
      }
      .rr-h1 { font-size: 32px; }
      .rr-main {
        padding: 8px 40px calc(90px + env(safe-area-inset-bottom));
      }
      @media (max-width: 600px) {
        .rr-header { padding: max(32px, env(safe-area-inset-top)) 20px 18px; }
        .rr-h1 { font-size: 26px; }
        .rr-main { padding: 8px 16px calc(70px + env(safe-area-inset-bottom)); }
        /* Zonas táctiles de al menos 44px, el mínimo recomendado en iOS */
        .rr-icon-btn { width: 40px; height: 40px; }
        .rr-btn { padding: 13px 22px; }
        .rr-chip { padding: 9px 14px; }
      }
      /* Evita el zoom automático de iOS al enfocar un <select> (exige 16px mínimo) */
      .rr-select { font-size: 16px; }
      @media (min-width: 601px) {
        .rr-select { font-size: 12px; }
      }
    `}</style>
  );
}
