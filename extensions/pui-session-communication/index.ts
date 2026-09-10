import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPuiSessionCommunication } from "./core.ts";

export default function puiSessionCommunication(pi: ExtensionAPI): void {
  registerPuiSessionCommunication(pi, { Type });
}
