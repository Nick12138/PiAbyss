import { usePluginEnabled } from "../plugin-library/plugin-gate";

/** The plugin-library entry that backs the Schedule page. */
const SCHEDULE_PLUGIN_ID = "pi-schedule";

/**
 * True while the pi-schedule plugin is installed and enabled; the sidebar
 * hides the Schedule entry otherwise.
 */
export function useSchedulePluginEnabled(): boolean {
  return usePluginEnabled(SCHEDULE_PLUGIN_ID);
}
