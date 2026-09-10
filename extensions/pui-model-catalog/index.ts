import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPuiModelCatalog } from "./core.ts";

export default function puiModelCatalog(pi: ExtensionAPI): void {
  registerPuiModelCatalog(pi, { Type });
}
