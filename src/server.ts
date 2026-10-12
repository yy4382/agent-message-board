import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
try {
  const config = loadConfig();
  const app = createApp(config);
  await app.listen({
    host: config.devHttp ? "127.0.0.1" : "0.0.0.0",
    port: config.port ?? 3000,
  });
  console.log(JSON.stringify({ event: "started", port: config.port ?? 3000 }));
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
} catch {
  console.error(
    "Startup failed: verify configuration, database permissions, and supported schema.",
  );
  process.exitCode = 1;
}
