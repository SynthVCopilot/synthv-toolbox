import { definePlugin } from "../../src/index.js";

export default definePlugin({
  schemaVersion: 1,
  id: "com.example.auto-tune",
  name: "Auto Tune",
  version: "0.1.0",
  hostApi: { min: "1.0", max: "1.0" },
  backend: { entry: "backend/index.js" },
  pages: [{ id: "workbench", title: "Tune Workbench", entry: "ui/index.html", icon: "waveform" }],
  actions: [{ id: "run", location: "project.toolbar", title: "Auto tune", icon: "sparkles" }],
  permissions: ["agent.tools", "project.read", "project.write"],
});
