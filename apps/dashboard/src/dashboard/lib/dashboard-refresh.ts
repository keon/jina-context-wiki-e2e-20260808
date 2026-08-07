export interface DashboardReloadOptions { background?: boolean }

export function shouldShowDashboardLoading(options: DashboardReloadOptions): boolean {
  return options.background !== true;
}

export function shouldDiscardDashboardData(status: number): boolean {
  return status === 401 || status === 403;
}
