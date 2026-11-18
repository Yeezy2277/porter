import exportJson from "../../samples/northbound-export.json";
import modelJson from "../../samples/contentful-model.json";
import { parseExport } from "@/core/source";
import { parseModel } from "@/core/model";

/** The demo's fixed inputs. Parsed once; identical on every instance and cold start. */
export const SITE_ORIGIN = "https://northbound.example";
export const source = parseExport(exportJson);
export const model = parseModel(modelJson);
