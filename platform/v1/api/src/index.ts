import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: "0.0.0.0",
  },
  (info) => {
    console.info("api_listening", {
      address: info.address,
      port: info.port,
      runtime: "typescript",
    });
  },
);
