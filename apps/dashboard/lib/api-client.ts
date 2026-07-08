export interface ApiClientConfig {
  readonly baseUrl: string;
}

export function createApiClient(config: ApiClientConfig): ApiClientConfig {
  return config;
}
