import { apiClientConfig } from '../config.js';

export function getBackendUrl(): string {
  const url = apiClientConfig().httpUrl || 'https://api.ziggsai.com';
  return url.startsWith('http') ? url : `https://${url}`;
}
