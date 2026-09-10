/** Explain the operational layer of a known inventory admission failure. */
export function inventoryRetryReason(code) {
  if (typeof code !== 'string') throw new TypeError('failure code must be a string');
  const categories = {
    insufficient_credits: 'funding',
    tenant_wiki_quota: 'quota',
    wiki_retry_provider_unavailable: 'provider',
    wiki_retry_incompatible: 'saved-work',
  };
  return Object.hasOwn(categories, code) ? categories[code] : 'unknown';
}
