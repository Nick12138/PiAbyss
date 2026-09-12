import { useEffect } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { SessionStatsPills } from "./StatsPills";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";
import { workspaceDisplayName } from "../workspaces/WorkspacePicker";
import { useT } from "../../lib/i18n/use-t";
import { conversationContentWidthStyle } from "./conversation-layout";
import { TelegramHistoryView } from "../telegram/TelegramHistoryView";
import { useTelegramWorkspaceActive } from "../telegram/telegram-view-store";
import { useSessionTreeSync } from "../tree/tree-data";

export function ChatPage() {
  const t = useT();
  // Keep the shared session tree warm: the inline branch navigators in the
  // transcript and the tree overlay both read from it.
  useSessionTreeSync();
  const workspace = useAppStore((s) => s.workspace);
  const session = useAppStore((s) => s.session);
  const host = useAppStore((s) => s.host);
  const packages = useAppStore((s) => s.packages);
  const authBlocked = useAppStore((s) => s.authBlocked);
  const providerConfigRevision = useAppStore((s) => s.providerConfigRevision);
  const openSettingsSection = useAppStore((s) => s.openSettingsSection);
  const setAuthBlocked = useAppStore((s) => s.setAuthBlocked);
  const conversationMinWidth = useAppStore((s) => s.desktopSettings?.conversationMinWidth);
  const conversationMaxWidth = useAppStore((s) => s.desktopSettings?.conversationMaxWidth);
  const telegramViewActive = useTelegramWorkspaceActive();

  // A login/logout/config save bumps the revision: the blockage the banner
  // describes may be resolved, so re-check by sending again.
  useEffect(() => {
    setAuthBlocked(null);
  }, [providerConfigRevision, setAuthBlocked]);

  const resourceReloadBlocked = packages?.resourceReloadRequired === true;
  const reconcileBlocked = packages?.mutation?.reconcileRequired === true;
  const packageBlocked = resourceReloadBlocked || reconcileBlocked;
  const sessionTreeNavigated = useAppStore((s) => s.sessionTreeNavigated);
  const isNewConversation = Boolean(
    session && session.messages.length === 0 && session.isIdle && !sessionTreeNavigated,
  );

  // The telegram workspace renders its own read-only history surface instead
  // of the normal chat, keeping the bridge session PC-side untouched.
  if (telegramViewActive) {
    return <TelegramHistoryView />;
  }

  if (!workspace) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
        <p className="text-base text-foreground">{t("chatSelectWorkspaceTitle")}</p>
        <p className="text-sm">{t("chatSelectWorkspaceHint")}</p>
      </div>
    );
  }

  if (!workspace.servicesReady) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted">
        {t("chatWorkspaceServicesNotReady")}
        {host?.lastError?.message ? (
          <span className="ml-2 text-danger">{host.lastError.message}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-chat-page
      style={conversationContentWidthStyle(conversationMinWidth, conversationMaxWidth)}
    >
      <div data-chat-content className="flex min-h-0 flex-1 flex-col">
        {authBlocked && (
          <div
            role="status"
            className="flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning"
          >
            <span className="min-w-0 flex-1">
              {authBlocked.providerId
                ? t("chatAuthRequiredProvider", { provider: authBlocked.providerId })
                : t("chatAuthRequired")}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md border border-warning/50 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-warning/15"
              onClick={() => openSettingsSection("providers")}
            >
              {t("chatAuthOpenProviders")}
            </button>
            <button
              type="button"
              aria-label={t("chatAuthDismiss")}
              className="shrink-0 rounded-md p-1 transition-colors hover:bg-warning/15"
              onClick={() => setAuthBlocked(null)}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {packageBlocked && (
          <div className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
            {reconcileBlocked ? t("chatPackageReconcileRequired") : t("chatPackageReloadRequired")}
          </div>
        )}
        <div aria-hidden="true" data-chat-header-fade />
        {session ? (
          isNewConversation ? (
            <>
              <InlineExtensionUiRequest />
              <Composer
                disabled={packageBlocked}
                welcomeWorkspaceName={workspaceDisplayName(workspace.cwd)}
              />
              <SessionStatsPills />
            </>
          ) : (
            <>
              <Transcript />
              <InlineExtensionUiRequest />
              <Composer disabled={packageBlocked} />
              <SessionStatsPills />
            </>
          )
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">
            {t("chatNoSession")}
          </div>
        )}
      </div>
    </div>
  );
}
