export const API_BASE = "/canvas-api";

export function apiPath(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${suffix}`;
}

export function getApiAssetId(pathname: string): string | undefined {
  const apiBasePath = new URL(apiPath("/"), window.location.origin).pathname.replace(/\/+$/u, "");
  const prefix = `${apiBasePath}/assets/`;
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }

  const encodedId = pathname.slice(prefix.length).split("/")[0];
  if (!encodedId) {
    return undefined;
  }

  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}
