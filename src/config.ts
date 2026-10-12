export interface Config {
  adminToken: string;
  publicOrigin: string;
  databasePath: string;
  port?: number;
  devHttp?: boolean;
}
export function validateConfig(config: Config): Config {
  if (!config.adminToken || Buffer.byteLength(config.adminToken) < 32)
    throw new Error(
      "AMB_ADMIN_TOKEN must contain at least 32 bytes of high-entropy secret.",
    );
  const url = new URL(config.publicOrigin);
  if (url.origin !== config.publicOrigin || url.username || url.password)
    throw new Error(
      "AMB_PUBLIC_ORIGIN must be an origin without path or credentials.",
    );
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((config.devHttp && !localHttp) || (url.protocol !== "https:" && !(config.devHttp && localHttp)))
    throw new Error("HTTPS required; AMB_DEV_HTTP allows localhost only.");
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
  )
    throw new Error("PORT invalid.");
  return config;
}
export function loadConfig(env = process.env): Config {
  return validateConfig({
    adminToken: env.AMB_ADMIN_TOKEN ?? "",
    publicOrigin: env.AMB_PUBLIC_ORIGIN ?? "",
    databasePath: env.AMB_DATABASE_PATH ?? "/data/board.sqlite",
    port: Number(env.PORT ?? 3000),
    devHttp: env.AMB_DEV_HTTP === "true",
  });
}
