import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { safewPlugin } from "./src/channel.js";
import { setSafewRuntime } from "./src/runtime.js";

const plugin = {
  id: "safew",
  name: "Safew",
  description: "Safew channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setSafewRuntime(api.runtime);
    api.registerChannel({ plugin: safewPlugin });
  },
};

export default plugin;
