import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Necesario para que funcione en GitHub Pages, que sirve el sitio bajo
  // tu-usuario.github.io/nextreadlab/ en vez de en la raíz del dominio.
  base: "/nextreadlab/",
  server: {
    // Permite conectarse desde otros dispositivos de tu misma red (como el móvil)
    host: true,
  },
});
