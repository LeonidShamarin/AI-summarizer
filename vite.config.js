import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * У продакшені /api/summarize обслуговує Vercel. Vite про це нічого не знає,
 * тож у режимі розробки монтуємо той самий обробник як middleware — щоб
 * `npm run dev` працював без окремого `vercel dev` і без другої гілки коду.
 */
function apiDevServer(env) {
  return {
    name: "api-dev-server",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/summarize", async (req, res) => {
        // Обробник читає ключ з process.env; у dev він приходить з .env,
        // який Vite сам у process.env не кладе.
        process.env.GROQ_API_KEY ??= env.GROQ_API_KEY;

        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");

        try {
          req.body = raw ? JSON.parse(raw) : {};
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ error: "Body must be JSON." }));
        }

        // Мінімальний шим під сигнатуру Vercel-функції.
        res.status = (code) => {
          res.statusCode = code;
          return res;
        };
        res.json = (payload) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
          return res;
        };

        const { default: handler } = await server.ssrLoadModule(
          "/api/summarize.js"
        );
        await handler(req, res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return { plugins: [react(), apiDevServer(env)] };
});
