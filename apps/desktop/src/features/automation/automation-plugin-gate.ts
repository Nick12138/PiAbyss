import { usePluginEnabled } from "../plugin-library/plugin-gate";

/** The plugin-library entry that backs the Automation page. */
const AUTOMATION_PLUGIN_ID = "pi-automation";

/**
 * True while the pi-automation plugin is installed and enabled; the sidebar
 * hides the Automation entry otherwise.
 */
export function useAutomationPluginEnabled(): boolean {
  return usePluginEnabled(AUTOMATION_PLUGIN_ID);
}
