import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPuiReasoningSummary } from "./core.ts";

export default function puiReasoningSummaryExtension(pi: ExtensionAPI): void {
  registerPuiReasoningSummary(pi);
}
