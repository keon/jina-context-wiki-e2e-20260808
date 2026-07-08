import { dashboardRoutes } from "./routes/dashboard.js";

export function createApiServer() {
  return {
    name: "jina-api",
    routes: dashboardRoutes()
  } as const;
}
