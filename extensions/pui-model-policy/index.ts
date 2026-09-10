import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPuiModelPolicy } from "./core.ts";

export default function puiModelPolicy(pi: ExtensionAPI): void {
  registerPuiModelPolicy(pi);
}
