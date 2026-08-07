import { getRequestListener } from "@hono/node-server";
import type { Pool } from "pg";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { configureProductDatabasePool } from "./db.js";

/**
 * Builds the dashboard and review handler mounted by the Jina API server. This
 * module deliberately does not open a port: apps/api owns the only listener.
 */
export function createProductApiRequestHandler(options: { readonly databasePool?: Pool } = {}) {
  if (options.databasePool) configureProductDatabasePool(options.databasePool);
  const config = loadConfig();
  const app = createApp(config);
  return getRequestListener(app.fetch);
}
