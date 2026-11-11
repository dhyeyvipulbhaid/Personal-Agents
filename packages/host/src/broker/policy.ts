/** Shipped allow-list. A policy deny wins over a user allow. */
export type Policy = {
  models: { allowed: string[] };
  connectors: { allowed: string[] };
};

export const defaultPolicy: Policy = {
  models: { allowed: ["ollama:*"] },
  connectors: { allowed: ["files", "mail-local"] },
};
