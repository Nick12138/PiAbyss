import { openSystemUrl } from "../../lib/open-system-url";
import { isSafeExternalUrl } from "./markdown-utils";

export type ChatLinkActivation = {
  button?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

/** Open a safe chat link in the system browser. */
export function openChatLink(url: string, _activation: ChatLinkActivation = {}): boolean {
  if (!isSafeExternalUrl(url)) return false;
  void openSystemUrl(url);
  return true;
}
