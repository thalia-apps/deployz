/** How long a freshly issued invitation stays valid. */
const INSTALL_LINK_TTL_DAYS = 30;

/** The expiry a newly issued (or re-issued) invitation gets. */
export function installLinkExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INSTALL_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}
