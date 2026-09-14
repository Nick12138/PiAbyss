import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";

/** Renames the telegram workspace entry via a display-name mapping (local). */
export function TelegramRenameDialog({
  currentName,
  onCancel,
  onConfirm,
}: {
  currentName: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(currentName);

  return (
    <Dialog
      title={t("tgRenameTitle")}
      confirmLabel={t("commonSave")}
      onCancel={onCancel}
      onConfirm={() => onConfirm(value)}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">{t("tgRenameLabel")}</span>
        <input
          type="text"
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("tgRenamePlaceholder")}
          className="h-9 rounded-md border border-border bg-surface px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
      </label>
      <p className="mt-2 text-xs text-muted">{t("tgRenameHint")}</p>
    </Dialog>
  );
}
