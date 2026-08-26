import fs from "node:fs";

interface CommandContext {
  ui: { notify(message: string, level: "info"): void };
}

interface ExtensionApi {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, context: CommandContext): Promise<void>;
  }): void;
}

function installedVersion(value: unknown): string {
  if (typeof value !== "object" || value === null || !("puiVersion" in value) || typeof value.puiVersion !== "string") {
    throw new Error("Installed PUI manifest is invalid");
  }
  return value.puiVersion;
}

export default function puiUpdateExtension(pi: ExtensionApi) {
  pi.registerCommand("pui-version", {
    description: "Show the installed PUI release and managed composition",
    handler: async (_args, context) => {
      const manifest: unknown = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
      context.ui.notify(`PUI ${installedVersion(manifest)}`, "info");
    },
  });
}
