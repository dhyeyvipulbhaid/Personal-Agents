import { doctorText, probeCapabilities } from "./capabilities/probe.ts";

const checks = probeCapabilities({
  folders: [{ path: ".", readable: true }],
  browsers: [],
  policies: [],
  ollamaPortOpen: false,
  models: [],
});

console.log(doctorText(checks));
