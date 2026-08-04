import { getRequestListener } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

/**
 * Builds the product API request handler mounted by the V2 API server. This
 * module deliberately does not open a port: apps/api owns the only listener.
 */
export function createProductApiRequestHandler() {
  const config = loadConfig();
  const app = createApp(config);
  return getRequestListener(app.fetch);
}
