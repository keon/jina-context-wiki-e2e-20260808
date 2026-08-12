export function isTrustedRedirect(target, allowedHost) {
  if (typeof target !== "string" || typeof allowedHost !== "string") {
    return false;
  }

  return target.startsWith(`https://${allowedHost}`);
}
