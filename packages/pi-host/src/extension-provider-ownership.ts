/**
 * Workspace-scoped ownership for extension-registered model providers.
 *
 * The 0.82.1 runtime keeps extension providers in one process-wide pair of
 * maps (`extensionProviders` / `nativeExtensionProviders`) keyed by bare
 * provider id, and nothing in the SDK or PiAbyss ever unregisters them.
 * Upstream that is sound — one Pi CLI process serves one workspace for its
 * whole lifetime. The PiAbyss Host serves many workspaces in sequence, so a
 * provider registered by a workspace extension (config, baseUrl, apiKey and
 * all) would otherwise stay visible and selectable in every workspace the
 * user visits afterwards. `extension-provider-isolation.test.ts` demonstrates
 * that leak against the unwrapped runtime; this module is the ownership layer
 * the handoff document requires once the leak is proven.
 *
 * Model:
 * - Every registration is attributed to an owner: the explicit owner bound via
 *   `runAsOwner` (workspace build / bind windows), else the fallback owner
 *   (the active workspace graph), else the permanent host owner.
 * - Host maintenance passes (`applyKnownThinkingProfiles`) run inside
 *   `runNeutral` — they merge into existing registrations without gaining
 *   ownership, so a maintenance re-registration can never pin another
 *   workspace's provider alive.
 * - Retaining a workspace suspends its owner: providers it alone owns are
 *   unregistered and their effective configs saved; providers co-owned by a
 *   live workspace stay registered. Reactivation resumes from the saved
 *   configs. Disposal releases without saving.
 *
 * Attribution uses AsyncLocalStorage so a build window keeps its owner even
 * when an unrelated agent turn interleaves on the event loop.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";

export type ProviderOwnerToken = { readonly label: string };

type ExtensionProviderConfig = Record<string, unknown>;
type NativeProvider = { id: string };

export type SuspendedProviders = {
  classic: Array<{ providerId: string; config: ExtensionProviderConfig }>;
  native: Array<{ providerId: string; provider: NativeProvider }>;
};

/** The runtime surface this module wraps; matches ModelRuntime's public API. */
type RegistrationSurface = {
  registerProvider(providerId: string, config: ExtensionProviderConfig): void;
  registerNativeProvider(provider: NativeProvider): void;
  unregisterProvider(providerId: string): void;
  getRegisteredProviderConfig(providerId: string): ExtensionProviderConfig | undefined;
};

const NEUTRAL = Symbol("neutral registration context");

export class ExtensionProviderOwnership {
  /** Startup and otherwise unattributable registrations; never cleaned up. */
  readonly hostOwner: ProviderOwnerToken = { label: "host" };

  private readonly runtime: RegistrationSurface;
  private readonly context = new AsyncLocalStorage<ProviderOwnerToken | typeof NEUTRAL>();
  private fallbackOwner: () => ProviderOwnerToken | null = () => null;

  private readonly owners = new Map<string, Set<ProviderOwnerToken>>();
  private readonly byOwner = new Map<ProviderOwnerToken, Set<string>>();
  private readonly kinds = new Map<string, "classic" | "native">();
  /** Native providers are opaque objects; keep the last one seen for resume. */
  private readonly lastNative = new Map<string, NativeProvider>();

  private readonly originals: RegistrationSurface;

  constructor(modelRuntime: ModelRuntime) {
    const runtime = modelRuntime as unknown as RegistrationSurface;
    this.runtime = runtime;
    this.originals = {
      registerProvider: runtime.registerProvider.bind(runtime),
      registerNativeProvider: runtime.registerNativeProvider.bind(runtime),
      unregisterProvider: runtime.unregisterProvider.bind(runtime),
      getRegisteredProviderConfig: runtime.getRegisteredProviderConfig.bind(runtime),
    };

    // Instance-level shadowing intercepts every path: PiAbyss's ModelRegistry
    // facade, the ExtensionRunner's fallback facade, and AgentSession's
    // providerActions all call methods on this same runtime instance.
    runtime.registerProvider = (providerId, config) => {
      this.originals.registerProvider(providerId, config);
      this.recordRegistration(providerId, "classic");
    };
    runtime.registerNativeProvider = (provider) => {
      this.originals.registerNativeProvider(provider);
      this.recordRegistration(provider.id, "native");
      this.lastNative.set(provider.id, provider);
    };
    runtime.unregisterProvider = (providerId) => {
      this.originals.unregisterProvider(providerId);
      this.forget(providerId);
    };
  }

  /** The owner used when no build/bind window is active (the active graph). */
  setFallbackOwnerSource(source: () => ProviderOwnerToken | null): void {
    this.fallbackOwner = source;
  }

  createOwner(label: string): ProviderOwnerToken {
    return { label };
  }

  /** Attribute every registration inside `fn` to `owner`. */
  runAsOwner<T>(owner: ProviderOwnerToken, fn: () => T): T {
    return this.context.run(owner, fn);
  }

  /**
   * Maintenance window: registrations neither gain nor transfer ownership.
   * New ids registered here fall to the host owner so they are never leaked
   * ownerless.
   */
  runNeutral<T>(fn: () => T): T {
    return this.context.run(NEUTRAL, fn);
  }

  /**
   * Park an owner: unregister the providers only it owns, keep co-owned ones,
   * and return what a later `resumeOwner` needs to restore its registrations.
   */
  suspendOwner(owner: ProviderOwnerToken): SuspendedProviders {
    if (owner === this.hostOwner) {
      throw new Error("The host owner cannot be suspended");
    }
    const suspended: SuspendedProviders = { classic: [], native: [] };
    for (const providerId of [...(this.byOwner.get(owner) ?? [])]) {
      if (this.kinds.get(providerId) === "native") {
        const provider = this.lastNative.get(providerId);
        if (provider) suspended.native.push({ providerId, provider });
      } else {
        // The effective config, not the owner's last registration: merges from
        // maintenance passes (thinking profiles) must survive suspend/resume.
        const config =
          this.originals.getRegisteredProviderConfig(providerId) ??
          undefined;
        if (config) suspended.classic.push({ providerId, config });
      }
      this.removeOwner(providerId, owner);
    }
    return suspended;
  }

  /** Restore a suspended owner's registrations and re-take ownership. */
  resumeOwner(owner: ProviderOwnerToken, suspended: SuspendedProviders): void {
    for (const { providerId, config } of suspended.classic) {
      try {
        this.originals.registerProvider(providerId, config);
        this.addOwner(providerId, "classic", owner);
      } catch (err) {
        // A provider that no longer validates must not fail the workspace
        // switch. Never log the config: it can carry credentials.
        logger.warn("Suspended extension provider failed to re-register", {
          providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const { providerId, provider } of suspended.native) {
      try {
        this.originals.registerNativeProvider(provider);
        this.addOwner(providerId, "native", owner);
        this.lastNative.set(providerId, provider);
      } catch (err) {
        logger.warn("Suspended native extension provider failed to re-register", {
          providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Drop an owner permanently, unregistering providers only it owned. */
  releaseOwner(owner: ProviderOwnerToken): void {
    if (owner === this.hostOwner) {
      throw new Error("The host owner cannot be released");
    }
    for (const providerId of [...(this.byOwner.get(owner) ?? [])]) {
      this.removeOwner(providerId, owner);
    }
  }

  /** Current owners of a provider id; exposed for tests and diagnostics. */
  ownersOf(providerId: string): readonly string[] {
    return [...(this.owners.get(providerId) ?? [])].map((owner) => owner.label);
  }

  private recordRegistration(providerId: string, kind: "classic" | "native"): void {
    const ambient = this.context.getStore();
    if (ambient === NEUTRAL) {
      // Maintenance merge of an existing registration stays ownership-neutral;
      // a genuinely new id must still get a keeper.
      if (this.owners.get(providerId)?.size) {
        this.kinds.set(providerId, kind);
        return;
      }
      this.addOwner(providerId, kind, this.hostOwner);
      return;
    }
    const owner = ambient ?? this.fallbackOwner() ?? this.hostOwner;
    this.addOwner(providerId, kind, owner);
  }

  private addOwner(
    providerId: string,
    kind: "classic" | "native",
    owner: ProviderOwnerToken,
  ): void {
    let holders = this.owners.get(providerId);
    if (!holders) {
      holders = new Set();
      this.owners.set(providerId, holders);
    }
    holders.add(owner);
    let held = this.byOwner.get(owner);
    if (!held) {
      held = new Set();
      this.byOwner.set(owner, held);
    }
    held.add(providerId);
    this.kinds.set(providerId, kind);
  }

  private removeOwner(providerId: string, owner: ProviderOwnerToken): void {
    const holders = this.owners.get(providerId);
    holders?.delete(owner);
    this.byOwner.get(owner)?.delete(providerId);
    if (this.byOwner.get(owner)?.size === 0) this.byOwner.delete(owner);
    if (holders && holders.size === 0) {
      this.originals.unregisterProvider(providerId);
      this.forget(providerId);
    }
  }

  private forget(providerId: string): void {
    const holders = this.owners.get(providerId);
    if (holders) {
      for (const owner of holders) {
        this.byOwner.get(owner)?.delete(providerId);
        if (this.byOwner.get(owner)?.size === 0) this.byOwner.delete(owner);
      }
    }
    this.owners.delete(providerId);
    this.kinds.delete(providerId);
    this.lastNative.delete(providerId);
  }
}
