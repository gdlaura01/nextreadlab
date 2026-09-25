"""Termina los iconos a partir de los dibujos de generate-icons.mjs y los verifica.

Uso (lo llama generate-icons.mjs):
    python build_icons.py <carpeta_de_dibujos> <public> <color_de_fondo>

Todos los archivos quedan en RGBA y nunca se aplanan sobre un fondo. Al final se
comprueba cada archivo (y cada tamaño de los .ico) según su forma:
- round: alpha 0 en las cuatro esquinas y alpha 255 en el centro.
- full: opaco entero (alpha 255 en todos los píxeles) y esquinas del color de fondo.
- maskable: como full y, además, todo el logo dentro de la zona segura (el
  círculo central del 80%, radio 0,4 del lado), que es lo que Android garantiza
  que no recorta.
Si alguno no pasa, el script termina con error.
"""

import json
import math
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
SPEC = json.loads((HERE / "icons.json").read_text(encoding="utf-8"))
SAFE_ZONE_RADIUS = 0.4  # radio de la zona segura de los maskable, en fracción del lado


def final(renders, shape, size):
    raw = Image.open(renders / f"raw-{shape}-{size}.png")
    if raw.mode == "RGB" and shape != "round":
        # Un dibujo opaco sale de Chromium en RGB; pasarlo a RGBA solo añade
        # alpha 255, sin perder nada.
        raw = raw.convert("RGBA")
    if raw.mode != "RGBA":
        raise SystemExit(f"raw-{shape}-{size}.png ha llegado en {raw.mode}, no en RGBA")
    # Reducimos en alpha premultiplicado ("RGBa") para que el borde antialiasado
    # del círculo no coja un halo oscuro; al volver a "RGBA" el alpha se conserva.
    return raw.convert("RGBa").resize((size, size), Image.LANCZOS).convert("RGBA")


def corners_of(w, h):
    return [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]


def check_round(img):
    w, h = img.size
    a = img.getchannel("A")
    corner_alpha = [a.getpixel(xy) for xy in corners_of(w, h)]
    center = (w // 2, h // 2)
    ok = all(v == 0 for v in corner_alpha) and a.getpixel(center) == 255
    detail = "  ".join(f"alpha{xy}={v}" for xy, v in zip(corners_of(w, h), corner_alpha))
    return ok, f"{detail}  alpha centro{center}={a.getpixel(center)}"


def check_opaque(img, bg):
    w, h = img.size
    alpha_range = img.getchannel("A").getextrema()
    corner_rgb = [img.getpixel(xy)[:3] for xy in corners_of(w, h)]
    corners_are_bg = all(max(abs(c - b) for c, b in zip(rgb, bg)) <= 2 for rgb in corner_rgb)
    ok = alpha_range == (255, 255) and corners_are_bg
    return ok, f"alpha mín/máx={alpha_range[0]}/{alpha_range[1]}  esquinas={'color de fondo' if corners_are_bg else corner_rgb}"


def check_safe_zone(img, bg):
    # Píxeles del logo: los que se apartan del color de fondo. Todos tienen que
    # quedar dentro del círculo seguro.
    w, h = img.size
    cx, cy = (w - 1) / 2, (h - 1) / 2
    farthest = 0.0
    # get_flattened_data sustituye a getdata desde Pillow 12; usamos la que haya
    pixels = img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()
    for i, (r, g, b, _) in enumerate(pixels):
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 24:
            x, y = i % w, i // w
            farthest = max(farthest, math.hypot(x - cx, y - cy))
    limit = SAFE_ZONE_RADIUS * w
    return farthest <= limit, f"logo hasta {farthest / w:.3f} del lado desde el centro (límite {SAFE_ZONE_RADIUS})"


def check(label, img, shape, bg):
    if img.mode != "RGBA":
        print(f"FALLA {label:30} modo={img.mode}")
        return False
    if shape == "round":
        ok, detail = check_round(img)
    else:
        ok, detail = check_opaque(img, bg)
        if shape == "maskable":
            safe_ok, safe_detail = check_safe_zone(img, bg)
            ok, detail = ok and safe_ok, f"{detail}  {safe_detail}"
    print(f"{'OK   ' if ok else 'FALLA'} {label:30} [{shape}] modo={img.mode}  {detail}")
    return ok


def main(renders, public, bg_hex):
    bg = tuple(int(bg_hex.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))

    for icon in SPEC["png"]:
        final(renders, icon["shape"], icon["size"]).save(public / icon["file"], format="PNG", optimize=True)

    for name, sizes in SPEC["ico"].items():
        sizes = sorted(sizes, reverse=True)
        frames = [final(renders, "round", s) for s in sizes]
        # Pasamos cada tamaño ya hecho (append_images) para que Pillow no
        # redimensione por su cuenta; los guarda como PNG RGBA dentro del .ico.
        frames[0].save(public / name, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])

    print("\nComprobación (abriendo cada archivo desde disco):")
    results = [check(icon["file"], Image.open(public / icon["file"]), icon["shape"], bg) for icon in SPEC["png"]]
    for name in SPEC["ico"]:
        ico = Image.open(public / name)
        for size in sorted(ico.ico.sizes()):
            results.append(check(f"{name} [{size[0]}x{size[1]}]", ico.ico.getimage(size), "round", bg))

    if not all(results):
        raise SystemExit("\nHay iconos que no pasan la comprobación.")
    print(f"\nTodos pasan: {len(results)} comprobaciones en {len(SPEC['png']) + len(SPEC['ico'])} archivos.")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
