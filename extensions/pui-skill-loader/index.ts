import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerPuiSkillLoader } from "./core.ts";

export default function puiSkillLoader(pi: ExtensionAPI) {
  registerPuiSkillLoader(pi, Type);
}
