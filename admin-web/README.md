# Quality Monitoring — Admin Panel

React + Vite + TypeScript + Tailwind CSS. All data comes from the backend in `../backend`.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

The API address defaults to port 4000 on the same host; override with `VITE_API_URL`.

Design tokens (colors) are defined once in `src/index.css` under `@theme` and shared with the worker app's `tailwind.config.js`.
