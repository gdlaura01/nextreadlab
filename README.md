# Next Read Lab

App local que analiza tu biblioteca de Goodreads y genera recomendaciones
consultando en tiempo real la API pública de Google Books.

## Requisitos

- Node.js 18 o superior (https://nodejs.org).

## Puesta en marcha

1. Descomprime esta carpeta en tu ordenador.
2. Abre una terminal dentro de la carpeta `nextreadlab`.
3. Instala las dependencias:

   ```
   npm install
   ```

4. Arranca el servidor de desarrollo:

   ```
   npm run dev
   ```

5. Abre en el navegador la URL que te indique la terminal (normalmente
   `http://localhost:5173`).

## Cargar tu biblioteca

Tienes dos formas, no excluyentes entre sí:

### A) Subida manual del CSV

Exporta tu biblioteca desde Goodreads (My Books → Tools → Import and export →
Export Library) y sube el CSV resultante en la aplicación.

### B) Conectar tu cuenta de Goodreads (sin terminal)

Goodreads no tiene API pública, pero sí publica un feed RSS por estantería si
tu perfil es público. La app lo lee directamente desde el navegador (a
través de un proxy público que añade los permisos necesarios, ya que
Goodreads no permite leer ese feed desde JavaScript directamente):

1. Averigua tu ID de usuario de Goodreads: aparece en la URL de tu perfil,
   `https://www.goodreads.com/user/show/12345678-tu-nombre` → tu ID es `12345678`.
2. Asegúrate de que tu perfil sea público (Settings → Profile → visibilidad).
3. En la pantalla de inicio de la app, escribe ese ID en la tarjeta "Accede
   a tu Next Read Lab" y pulsa "conectar con Goodreads". No hace falta
   ninguna terminal ni instalar nada más.
4. La cuenta queda conectada en este navegador. La próxima vez que abras la
   app, verás directamente el botón "entrar" en esa misma tarjeta, sin tener
   que volver a escribir el ID.
5. Si quieres traer los libros que hayas añadido o valorado desde la última
   vez, vuelve a pulsar "conectar con Goodreads" (o usa "actualizar
   resultados" dentro de la app, una vez conectado).
6. Si quieres conectar una cuenta distinta, pulsa "cambiar de usuario" junto
   al botón "entrar".

**Importante:** este método depende de dos cosas que Goodreads y el proxy
público no garantizan mantener: el formato del feed RSS (nunca documentado
oficialmente) y la disponibilidad del servicio proxy usado para poder leerlo
desde el navegador. Si algún día deja de funcionar, la subida manual del CSV
seguirá estando disponible siempre como alternativa.

### Alternativa avanzada: script de Node (`npm run sync`)

Si prefieres no depender de ningún proxy público, o quieres automatizar la
sincronización con el Programador de tareas de Windows, `cron` o `pm2`,
sigue existiendo el script de Node original en `scripts/sync-goodreads.js`,
que genera `public/library.json` desde la terminal:

```
GOODREADS_USER_ID=12345678 npm run sync
```

(En Windows, usa `set GOODREADS_USER_ID=12345678 && npm run sync` en cmd, o
`$env:GOODREADS_USER_ID="12345678"; npm run sync` en PowerShell.)

Este método es opcional: la conexión desde la propia app (opción B de
arriba) cubre el mismo caso de uso sin necesitar la terminal.


## Evitar el error 429 ("demasiadas peticiones")

Google Books permite hacer consultas sin ninguna clave, pero con un límite
muy bajo de peticiones por minuto — se agota enseguida si haces varias
pruebas seguidas, y verás un error de "no he encontrado candidatos
suficientes" aunque tu conexión esté perfecta. La solución es una clave de
API gratuita (no pide tarjeta de pago para este uso):

1. Ve a [console.cloud.google.com](https://console.cloud.google.com/) e
   inicia sesión con una cuenta de Google.
2. Crea un proyecto nuevo (arriba a la izquierda, selector de proyectos →
   "Proyecto nuevo"). Ponle el nombre que quieras, por ejemplo
   "next-read-lab".
3. Con ese proyecto seleccionado, ve a **APIs y servicios → Biblioteca**,
   busca "Books API" y pulsa **Habilitar**.
4. Ve a **APIs y servicios → Credenciales → Crear credenciales → Clave de
   API**. Se generará una clave (una cadena de letras y números).
5. Opcional pero recomendable: pulsa en la clave recién creada y, en
   "Restricciones de API", limítala a "Books API" únicamente — así, aunque
   alguien la viera, no podría usarla para otra cosa.
6. En la carpeta del proyecto, copia el archivo `.env.example` y renombra la
   copia a `.env` (sin ".example"). Ábrelo y pega tu clave así:

   ```
   VITE_GOOGLE_BOOKS_API_KEY=tu_clave_aquí
   ```

7. Para y vuelve a arrancar el servidor (`Ctrl+C` y `npm run dev` de
   nuevo) — Vite solo lee el `.env` al arrancar.

El `.env` no se sube a ningún sitio ni se comparte si envías la carpeta a
otra persona (siempre que no incluyas ese archivo al compartirla).

## Cómo funciona el motor de recomendación

- Todo el procesamiento ocurre en tu navegador u ordenador, nunca se envían
  tus datos a ningún servidor propio.
- Para tus libros mejor valorados, la app consulta Google Books y extrae sus
  categorías temáticas, construyendo tu perfil de géneros favoritos.
- A partir de ese perfil y de tus autores más repetidos, busca candidatos
  nuevos en el catálogo de Google Books, descarta los que ya tienes
  registrados y ordena el resto combinando afinidad de género, afinidad de
  autor, valoración media y número de valoraciones.
- En la ficha de cada libro, para la mejor edición y el traductor, consulta
  además Open Library (cuando el libro tiene ISBN identificado) y cruza la
  editorial con una lista propia de editoriales de referencia por idioma de
  origen (ver "Sobre las recomendaciones de edición y traducción" abajo).

## Si varias personas usan la app en el mismo ordenador

Cada análisis queda identificado por su origen: la cuenta de Goodreads
conectada (por su ID de usuario), o el nombre exacto del archivo CSV subido.
Los libros guardados, descartados y los géneros con el peso bajado se
guardan por separado para cada identidad, así que dos personas que usen el
mismo ordenador y el mismo navegador no verán las listas de la otra
mezcladas con las suyas.

Ten en cuenta dos límites de este sistema:

- Si dos personas exportan su CSV con el mismo nombre de archivo exacto
  (por ejemplo, ambas descargan `goodreads_library_export.csv` sin
  renombrarlo), la app las tratará como la misma identidad y sus listas se
  mezclarán. Conectar la cuenta de Goodreads directamente (opción B más
  arriba) no tiene este problema, porque usa el ID de usuario, que es único.
- Todo esto vive en el navegador de ese ordenador (`localStorage`). Si lo
  abres desde otro navegador o dispositivo, no encontrará ninguna lista
  previa, aunque sea la misma cuenta de Goodreads.

## Sobre las recomendaciones de edición y traducción

Ninguna API pública sabe qué traducción es "mejor" — eso es un juicio
crítico, no un dato de catálogo. Lo que la app sí hace, y siempre indicando
el motivo:

- Si Open Library tiene catalogado el nombre del traductor para el ISBN
  concreto de esa edición, lo muestra como dato verificable, con su fuente.
- Si la editorial de la edición encontrada coincide con una lista propia de
  editoriales que, en el mercado español, son la referencia habitual para
  literatura traducida de ese idioma (por ejemplo, Acantilado para alemán,
  Alba para clásicos anglosajones), lo explica como tal — un criterio
  editorial general nuestro, no una garantía sobre esa traducción en
  concreto.
- Si no encuentra ninguno de los dos datos, lo dice explícitamente en vez de
  inventar un nombre o una editorial.

Esta lista de editoriales de referencia está en `src/App.jsx`, en la
constante `PUBLISHER_REPUTATION` — es deliberadamente pequeña y ampliable;
añade ahí las editoriales que tú consideres de referencia para otros
idiomas o géneros si quieres afinarla.

## Generar una versión para producción

```
npm run build
```

Esto genera una carpeta `dist/` con los archivos estáticos.

## Publicar en GitHub Pages (enlace en vivo)

El repositorio incluye un flujo de GitHub Actions (`.github/workflows/deploy.yml`)
que compila y publica la app automáticamente cada vez que subes cambios a
`main`. Para activarlo:

1. En tu repositorio de GitHub, ve a **Settings → Pages**.
2. En "Build and deployment" → "Source", elige **GitHub Actions** (no
   "Deploy from a branch").
3. Si quieres que la versión publicada use una clave de Google Books (ver
   "Evitar el error 429" más abajo) en vez del límite sin clave, ve a
   **Settings → Secrets and variables → Actions → New repository secret**,
   y crea uno llamado `VITE_GOOGLE_BOOKS_API_KEY` con tu clave. Es opcional:
   sin él, la app funciona igual, solo con menos margen de peticiones.
4. Haz un `git push` a `main` (o entra en la pestaña **Actions** de tu
   repositorio y ejecuta el flujo manualmente con "Run workflow").
5. Cuando el flujo termine (un par de minutos), tu app estará visible en
   `https://tu-usuario.github.io/nextreadlab/`.

**Importante sobre la clave de API en un sitio público:** cualquier clave
que uses aquí queda incluida en el código JavaScript que se descarga en el
navegador de quien visite la página — es inherente a cualquier app que solo
tenga frontend, sin servidor propio. Para una clave de Google Books gratuita
esto no supone un riesgo grave, pero por precaución, en Google Cloud Console
puedes restringirla a "Books API" únicamente y añadir una restricción de
referente HTTP a `https://tu-usuario.github.io/*`, así solo funcionará
llamada desde tu propia página.

## Usarla desde el iPhone como un acceso directo

La app ya está adaptada a pantallas pequeñas y preparada para que Safari la
trate como una app instalada (icono propio, sin barra de navegador, colores
de la interfaz a juego). Para ponerla en tu iPhone:

1. En tu ordenador, arranca el servidor con `npm run dev` como siempre.
   Verás en la terminal dos direcciones: una `Local` (`localhost:5173`) y
   otra `Network` (algo como `http://192.168.1.XX:5173`) — esta segunda es
   la que necesitas.
2. Comprueba que tu iPhone está conectado a la **misma red Wi-Fi** que tu
   ordenador (no funciona por datos móviles, ni si el ordenador está en una
   red distinta).
3. En el iPhone, abre **Safari** (tiene que ser Safari, no Chrome ni otro
   navegador — solo Safari permite instalar accesos directos con estas
   capacidades en iOS) y escribe esa dirección `Network` en la barra de
   direcciones.
4. Una vez cargada la app, pulsa el icono de **compartir** (el cuadrado con
   la flecha hacia arriba, abajo en el centro).
5. Baja hasta **"Añadir a pantalla de inicio"** y confirma.
6. Verás un nuevo icono en tu pantalla de inicio, con el nombre "Sala
   lectura". Al abrirlo, se abre a pantalla completa, sin la barra de
   Safari, como una app nativa.

**Importante:** esto solo funciona mientras tu ordenador tenga el servidor
encendido (`npm run dev` corriendo) y ambos dispositivos estén en la misma
red — no es una app publicada de forma independiente en internet. Si cierras
la terminal o apagas el ordenador, el acceso directo del iPhone dejará de
cargar hasta que vuelvas a arrancar el servidor.

