import { readFileSync } from "node:fs";

const descriptor = JSON.parse(readFileSync(new URL("../capabilities/s01-exhibition-catalog-search.v1.json", import.meta.url), "utf8"));
export const s01CatalogSearchCapability = Object.freeze(descriptor);
