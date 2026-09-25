"""Termina los iconos a partir de los dibujos de generate-icons.mjs y los verifica.

Uso (lo llama generate-icons.mjs): python build_icons.py <carpeta_de_dibujos> <public>

Todos los archivos quedan en RGBA: nunca se pasa por RGB ni se aplana sobre un
fondo, porque eso rellenaría de color las esquinas que tienen que ser
transparentes. Al final se comprueba cada archivo (y cada tamaño de los .ico):
modo RGBA, alpha 0 en las cuatro esquinas y alpha 255 en el centro. Si alguno
no pasa, el script termina con error.
"""

import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
SPEC = json.loads((HERE / "icons.json").read_text(encoding="utf-8"))


def final(renders, size):
    raw = Image.open(renders / f"raw-{size}.png")
    if raw.mode != "RGBA":
        raise SystemExit(f"raw-{size}.png ha llegado en {raw.mode}, no en RGBA")
    # Reducimos en alpha premultiplicado ("RGBa") para que el borde antialiasado
    # del círculo no coja un halo oscuro; al volver a "RGBA" el alpha se conserva.
    return raw.convert("RGBa").resize((size, size), Image.LANCZOS).convert("RGBA")


def check(label, img):
    w, h = img.size
    alpha = img.getchannel("A") if img.mode == "RGBA" else None
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    corner_alpha = [alpha.getpixel(xy) if alpha else None for xy in corners]
    center = (w // 2, h // 2)
    center_alpha = alpha.getpixel(center) if alpha else None
    ok = img.mode == "RGBA" and all(a == 0 for a in corner_alpha) and center_alpha == 255
    print(
        f"{'OK   ' if ok else 'FALLA'} {label:28} modo={img.mode}  "
        + "  ".join(f"alpha{xy}={a}" for xy, a in zip(corners, corner_alpha))
        + f"  alpha centro{center}={center_alpha}"
    )
    return ok


def main(renders, public):
    for name, size in SPEC["png"].items():
        final(renders, size).save(public / name, format="PNG", optimize=True)

    for name, sizes in SPEC["ico"].items():
        sizes = sorted(sizes, reverse=True)
        frames = [final(renders, s) for s in sizes]
        # Pasamos cada tamaño ya hecho (append_images) para que Pillow no
        # redimensione por su cuenta; los guarda como PNG RGBA dentro del .ico.
        frames[0].save(public / name, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])

    print("\nComprobación (abriendo cada archivo desde disco):")
    results = [check(name, Image.open(public / name)) for name in SPEC["png"]]
    for name in SPEC["ico"]:
        ico = Image.open(public / name)
        for size in sorted(ico.ico.sizes()):
            results.append(check(f"{name} [{size[0]}x{size[1]}]", ico.ico.getimage(size)))

    if not all(results):
        raise SystemExit("\nHay iconos que no pasan la comprobación.")
    print(f"\nTodos pasan: {len(results)} comprobaciones en {len(SPEC['png']) + len(SPEC['ico'])} archivos.")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
