export interface DashboardRoute {
  readonly path: string;
  readonly requiresAuth: boolean;
}

export function dashboardRoutes(): readonly DashboardRoute[] {
  return [{ path: "/tasks", requiresAuth: true }];
}
