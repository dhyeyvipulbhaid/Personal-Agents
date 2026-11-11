import { PluginKernel } from "./kernel.ts";

/** Process-wide kernel. The stdio server reads tiles from it. */
export const kernel = new PluginKernel();
