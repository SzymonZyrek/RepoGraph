import { readFileSync } from "node:fs";
export const VERSION = readFileSync(new URL("../../VERSION.txt", import.meta.url), "utf8").trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(VERSION)) throw new Error("Invalid VERSION.txt");
