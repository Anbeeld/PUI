import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPuiSessionTitle } from "./core.ts";

export default function puiSessionTitleExtension(pi: ExtensionAPI): void {
  registerPuiSessionTitle(pi);
}
