// Regenera los iconos de public/ (favicon.ico, app-icon.ico, apple-touch-icon.png,
// icon-192.png e icon-512.png): el logo del libro dentro de un círculo del color de
// fondo de la marca, con transparencia completa fuera del círculo.
//
// Uso: npm run icons
//
// Necesita:
// - Chrome o Edge instalados (o la ruta a otro Chromium en CHROMIUM_PATH).
// - Python 3 con Pillow (pip install pillow), que hace el resto en build_icons.py.
//
// El logo se lee de BookMark en src/App.jsx, con los colores de PALETTE, para que
// los iconos salgan siempre del mismo dibujo que se ve en la web.

import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const spec = JSON.parse(readFileSync(join(here, "icons.json"), "utf8"));

// Cada tamaño se dibuja a 4x y build_icons.py lo reduce, para que las líneas finas
// y el borde del círculo queden suaves.
const SUPERSAMPLE = 4;
// El libro ocupa el 90% de un lienzo de 240 unidades (unas 173 de ancho, ~72% del
// diámetro): así sus esquinas quedan dentro del círculo con margen.
const CANVAS = 240;
const LOGO_SCALE = 0.9;

function readLogo() {
  const app = readFileSync(join(root, "src", "App.jsx"), "utf8");

  const paletteBlock = app.match(/const PALETTE = \{([\s\S]*?)\};/);
  if (!paletteBlock) throw new Error("No encuentro PALETTE en src/App.jsx");
  const palette = Object.fromEntries([...paletteBlock[1].matchAll(/(\w+):\s*"(#[0-9A-Fa-f]{3,8})"/g)].map((m) => [m[1], m[2]]));

  const bookmark = app.match(/function BookMark\([\s\S]*?viewBox="([\d.\s-]+)"[\s\S]*?(<g [\s\S]*?<\/g>)/);
  if (!bookmark) throw new Error("No encuentro el SVG de BookMark en src/App.jsx");
  const [x, y, w, h] = bookmark[1].trim().split(/\s+/).map(Number);

  // De JSX a SVG: colores de PALETTE en su sitio, fuera las clases de la animación
  // y atributos en kebab-case (strokeWidth → stroke-width).
  const svg = bookmark[2]
    .replace(/\{PALETTE\.(\w+)\}/g, (_, key) => {
      if (!palette[key]) throw new Error(`PALETTE.${key} no existe`);
      return `"${palette[key]}"`;
    })
    .replace(/\s+className=\{[^}]*\}/g, "")
    .replace(/\s([a-z]+[A-Z][A-Za-z]*)=/g, (_, attr) => ` ${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=`);
  if (/[{}]/.test(svg)) throw new Error("Queda JSX sin traducir en el SVG del logo");

  return { svg, bg: palette.bg, center: [Math.round(x + w / 2), Math.round(y + h / 2)] };
}

function iconSvg({ svg, bg, center: [cx, cy] }, px) {
  const r = CANVAS / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${cx - r} ${cy - r} ${CANVAS} ${CANVAS}">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}"/>
  <g transform="translate(${cx} ${cy}) scale(${LOGO_SCALE}) translate(${-cx} ${-cy})">${svg}</g>
</svg>`;
}

async function launchBrowser() {
  if (process.env.CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // probamos el siguiente navegador
    }
  }
  throw new Error("No encuentro Chrome ni Edge. Instala uno de los dos o indica la ruta de un Chromium en CHROMIUM_PATH.");
}

function findPython() {
  for (const cmd of ["python3", "python", "py"]) {
    const probe = spawnSync(cmd, ["-c", "import PIL"], { stdio: "ignore" });
    if (probe.status === 0) return cmd;
  }
  throw new Error("Necesito Python 3 con Pillow para terminar los iconos: pip install pillow");
}

const sizes = [...new Set([...Object.values(spec.png), ...Object.values(spec.ico).flat()])].sort((a, b) => a - b);
const logo = readLogo();
const python = findPython();
const renders = mkdtempSync(join(tmpdir(), "next-read-lab-icons-"));

try {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 2048, height: 2048 } });
  for (const size of sizes) {
    await page.setContent(`<html><body style="margin:0;background:transparent">${iconSvg(logo, size * SUPERSAMPLE)}</body></html>`);
    // omitBackground deja el lienzo transparente: el PNG sale en RGBA
    await page.locator("svg").screenshot({ path: join(renders, `raw-${size}.png`), omitBackground: true });
  }
  await browser.close();
  console.log(`Logo dibujado a ${sizes.join(", ")} px (x${SUPERSAMPLE}).`);

  const build = spawnSync(python, [join(here, "build_icons.py"), renders, join(root, "public")], { stdio: "inherit" });
  process.exitCode = build.status ?? 1;
} finally {
  rmSync(renders, { recursive: true, force: true });
}
