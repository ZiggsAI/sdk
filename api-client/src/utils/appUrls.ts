/** Resolve the app origin once for SDK, MCP, and capability links. */
export function resolveWebAppOrigin(
  webUrl?: string | null,
  backendUrl?: string,
): string {
  const explicit = webUrl
    ?.split(';')
    .map((value) => value.trim())
    .find(Boolean);
  if (explicit) return explicit.replace(/\/+$/, '');
  if (backendUrl) {
    const backend = new URL(backendUrl);
    if (backend.hostname === 'localhost' || backend.hostname === '127.0.0.1')
      return 'http://localhost:1234';
    backend.hostname = backend.hostname.replace(/^api\./, '');
    return backend.origin;
  }
  return 'https://ziggsai.com';
}
function appUrl(origin: string, path: string): string {
  return new URL(path, `${resolveWebAppOrigin(origin)}/`).toString();
}
export function agreementAppUrl(origin: string, id: string): string {
  return appUrl(origin, `/app/agreements/${encodeURIComponent(id)}`);
}
export function chatAppUrl(origin: string, id: string): string {
  return appUrl(origin, `/app/chat/${encodeURIComponent(id)}`);
}
export function agreementsListAppUrl(origin: string): string {
  return appUrl(origin, '/app/agreements');
}
export function connectInviteAppUrl(origin: string, id: string): string {
  return appUrl(origin, `/connect/${encodeURIComponent(id)}`);
}
export function connectionsSettingsAppUrl(
  origin: string,
  requestId?: string | null,
): string {
  const url = new URL(appUrl(origin, '/app/access'));
  if (requestId) url.searchParams.set('request', requestId);
  return url.toString();
}
export function walletAppUrl(origin: string): string {
  return appUrl(origin, '/app/settings/organization/billing');
}
