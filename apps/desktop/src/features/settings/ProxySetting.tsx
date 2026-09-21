import { useEffect, useState } from "react";
import type { PiSettingsPatch } from "@piabyss/protocol";
import { useT } from "../../lib/i18n/use-t";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { notifyOperationFailure } from "../../lib/notify-operation-error";

/**
 * Network proxy (Pi global settings `httpProxy`). The Host applies this value
 * at startup only (network-bootstrap mirrors it to HTTP_PROXY/HTTPS_PROXY and
 * rebuilds the undici dispatcher), so a saved change needs a Host restart to
 * take effect — the surrounding "More settings" group already carries that hint.
 */
export function ProxySetting() {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const [value, setValue] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!host) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void hostClient
      .request("piSettings.get", hostContext(host), null)
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(response.error.message);
        const stored = response.result.httpProxy ?? "";
        setValue(stored);
        setDraft(stored);
      })
      .catch((error) => {
        if (!cancelled) notifyOperationFailure(error, String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  async function save(next: string) {
    if (!host || saving) return;
    const trimmed = next.trim();
    if (trimmed === value) return;
    setSaving(true);
    try {
      const patch: PiSettingsPatch = { httpProxy: trimmed };
      const response = await hostClient.request("piSettings.patch", hostContext(host), patch);
      if (!response.ok) throw new Error(response.error.message);
      const stored = response.result.httpProxy ?? "";
      setValue(stored);
      setDraft(stored);
    } catch (error) {
      // Roll the input back to the persisted value so it never claims a saved
      // state after a rejected patch (e.g. invalid proxy URL).
      setDraft(value);
      notifyOperationFailure(error, String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 @min-[40rem]:flex-row @min-[40rem]:items-center @min-[40rem]:justify-between">
      <label htmlFor="proxy-url" className="min-w-0">
        <span className="block text-sm">{t("generalProxy")}</span>
        <span className="block text-xs text-muted">{t("generalProxyDesc")}</span>
      </label>
      <input
        id="proxy-url"
        type="text"
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-64 max-w-full rounded-md border border-border bg-surface px-2 font-mono text-xs text-foreground outline-none focus:border-focus disabled:opacity-60"
        placeholder="http://127.0.0.1:7890"
        aria-label={t("generalProxy")}
        value={draft}
        disabled={loading || saving || !host}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => void save(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}
