import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { PromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import { MentionPlugin } from "@/mentions/MentionPlugin.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import {
  bindRemoteWorkspaceIdentity,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import type { IServiceAccessor } from "@zcode/services";
import type {
  ZCodePluginReferenceCatalogEntry,
  ZCodeSkillReferenceCatalogEntry,
} from "@zcode/shared";

const WORKSPACE_PATH = "/workspace";
const WORKSPACE_IDENTITY = "remote:ssh:picker-fixture";
const INITIAL_ATTACHMENT = "picker-attachment-a";

type CatalogKind = "skills" | "plugins";
type NextBehavior = "resolve" | "defer" | "reject";

interface CatalogRequest<T> {
  resolve: (value: T) => void;
  result: () => T;
}

interface RequestRecord {
  kind: CatalogKind;
  requestNumber: number;
  params: unknown;
}

interface Controller {
  attachmentId: string;
  skillCatalog: ZCodeSkillReferenceCatalogEntry[];
  pluginCatalog: ZCodePluginReferenceCatalogEntry[];
  requests: RequestRecord[];
  pending: Map<string, CatalogRequest<unknown>>;
  nextBehavior: Record<CatalogKind, NextBehavior>;
  capabilityListeners: Set<(event: unknown) => void>;
  services: IServiceAccessor;
}

interface PickerBrowserControl {
  requestCount: (label: string, kind: CatalogKind) => number;
  requestParams: (label: string, kind: CatalogKind, requestNumber: number) => unknown;
  setNextBehavior: (label: string, kind: CatalogKind, behavior: NextBehavior) => void;
  setCatalog: (
    label: string,
    kind: CatalogKind,
    catalog: ZCodeSkillReferenceCatalogEntry[] | ZCodePluginReferenceCatalogEntry[],
  ) => void;
  resolveRequest: (label: string, kind: CatalogKind, requestNumber: number) => void;
  publishCapabilityRevision: (label: string, sessionId: string, revision: string) => void;
  setSessionId: (sessionId: string) => void;
  setPluginProbeEnabled: (enabled: boolean) => void;
  switchAttachment: (attachmentId: string) => void;
  reconnectAttachment: (attachmentId: string) => string;
}

declare global {
  interface Window {
    __pickerBrowser?: PickerBrowserControl;
  }
}

function makeSkill(id: string): ZCodeSkillReferenceCatalogEntry {
  return {
    id,
    name: id,
    description: `Description for ${id}`,
    path: `/workspace/.zcode/skills/${id}/SKILL.md`,
    scope: "workspace",
    enabled: true,
  };
}

function makePlugin(id: string): ZCodePluginReferenceCatalogEntry {
  return {
    pluginId: `fixture/${id}`,
    name: id,
    marketplace: "fixture-marketplace",
    enabled: true,
    conflictingPluginIds: [],
    skillQualifiedNames: [],
    mcpServerNames: [],
    subagentNames: [],
  };
}

function resultFor(controller: Controller, kind: CatalogKind) {
  return kind === "skills"
    ? { authority: "session" as const, skills: controller.skillCatalog }
    : { authority: "session" as const, plugins: controller.pluginCatalog };
}

function createController(label: string, attachmentId: string): Controller {
  const controller: Controller = {
    attachmentId,
    skillCatalog: [makeSkill(`${label}-skill`)],
    pluginCatalog: [makePlugin(`${label}-plugin`)],
    requests: [],
    pending: new Map(),
    nextBehavior: { skills: "resolve", plugins: "resolve" },
    capabilityListeners: new Set(),
    services: null as unknown as IServiceAccessor,
  };

  const loadCatalog = (kind: CatalogKind, params: unknown): Promise<unknown> => {
    const requestNumber = controller.requests.filter((request) => request.kind === kind).length + 1;
    controller.requests.push({ kind, requestNumber, params });
    const behavior = controller.nextBehavior[kind];
    controller.nextBehavior[kind] = "resolve";
    if (behavior === "reject") {
      return Promise.reject(new Error(`controlled ${kind} refresh failure`));
    }
    if (behavior === "defer") {
      return new Promise((resolve) => {
        controller.pending.set(`${kind}:${requestNumber}`, {
          resolve,
          result: () => resultFor(controller, kind),
        });
      });
    }
    return Promise.resolve(resultFor(controller, kind));
  };

  const zcodeAgentService = {
    getSkillReferenceCatalog: (params: unknown) => loadCatalog("skills", params),
    onAgentRuntimeRestarted: () => ({ dispose() {} }),
    onDynamicCapabilitiesChanged: () => (listener: (event: unknown) => void) => {
      controller.capabilityListeners.add(listener);
      return { dispose: () => controller.capabilityListeners.delete(listener) };
    },
  };
  const pluginManagementService = {
    getPluginReferenceCatalog: (params: unknown) => loadCatalog("plugins", params),
  };
  const fileService = { searchWorkspaceFiles: async () => [] };
  const clientConfigService = { getSnapshot: async () => ({ pluginStoreOrder: null }) };

  controller.services = {
    zcodeAgentService,
    pluginManagementService,
    fileService,
    clientConfigService,
  } as unknown as IServiceAccessor;
  return controller;
}

const controllers = new Map<string, Controller>();
let reconnectSequence = 0;

function getController(label: string): Controller {
  const controller = controllers.get(label);
  if (!controller) throw new Error(`Unknown catalog service: ${label}`);
  return controller;
}

function registerAttachment(attachmentId: string, services: IServiceAccessor): void {
  registerRemoteWorkspaceSession({ sessionId: attachmentId, services });
  bindRemoteWorkspaceIdentity(WORKSPACE_IDENTITY, attachmentId);
}

function PluginCatalogProbe({ enabled, sessionId }: { enabled: boolean; sessionId: string }) {
  const state = usePluginReferenceCatalog(WORKSPACE_PATH, WORKSPACE_IDENTITY, sessionId, enabled, {
    suppressErrorLog: true,
  });
  return (
    <section
      data-testid="plugin-catalog-probe"
      data-loading={state.loading ? "true" : "false"}
      data-error={state.error ?? ""}
    >
      {state.entries.map((entry) => (
        <span key={entry.pluginId} data-testid={`plugin-probe-entry-${entry.name}`}>
          {entry.name}
        </span>
      ))}
    </section>
  );
}

function PickerFixture() {
  const [sessionId, setSessionId] = useState("session-a");
  const [pluginProbeEnabled, setPluginProbeEnabled] = useState(false);

  useEffect(() => {
    const control: PickerBrowserControl = {
      requestCount: (label, kind) =>
        getController(label).requests.filter((request) => request.kind === kind).length,
      requestParams: (label, kind, requestNumber) =>
        getController(label).requests.find(
          (request) => request.kind === kind && request.requestNumber === requestNumber,
        )?.params,
      setNextBehavior: (label, kind, behavior) => {
        getController(label).nextBehavior[kind] = behavior;
      },
      setCatalog: (label, kind, catalog) => {
        const controller = getController(label);
        if (kind === "skills") {
          controller.skillCatalog = catalog as ZCodeSkillReferenceCatalogEntry[];
        } else {
          controller.pluginCatalog = catalog as ZCodePluginReferenceCatalogEntry[];
        }
      },
      resolveRequest: (label, kind, requestNumber) => {
        const controller = getController(label);
        const key = `${kind}:${requestNumber}`;
        const pending = controller.pending.get(key);
        if (!pending) throw new Error(`No pending catalog request: ${label} ${key}`);
        controller.pending.delete(key);
        pending.resolve(pending.result());
      },
      publishCapabilityRevision: (label, nextSessionId, revision) => {
        const controller = getController(label);
        const event = {
          workspacePath: WORKSPACE_PATH,
          workspaceIdentity: WORKSPACE_IDENTITY,
          remoteSessionId: controller.attachmentId,
          sessionId: nextSessionId,
          status: { status: "ready", revision },
        };
        for (const listener of controller.capabilityListeners) listener(event);
      },
      setSessionId,
      setPluginProbeEnabled,
      switchAttachment: (attachmentId) => {
        let controller = controllers.get(attachmentId);
        if (!controller) {
          controller = createController(attachmentId, attachmentId);
          controllers.set(attachmentId, controller);
        }
        registerAttachment(attachmentId, controller.services);
      },
      reconnectAttachment: (attachmentId) => {
        const label = `${attachmentId}-reconnect-${++reconnectSequence}`;
        const controller = createController(label, attachmentId);
        controllers.set(label, controller);
        registerAttachment(attachmentId, controller.services);
        return label;
      },
    };
    window.__pickerBrowser = control;
    return () => {
      delete window.__pickerBrowser;
    };
  }, []);

  return (
    <>
      <LexicalComposer
        initialConfig={{
          namespace: "picker-browser-fixture",
          nodes: [PromptMentionNode],
          onError: (error) => {
            throw error;
          },
          theme: {},
        }}
      >
        <PlainTextPlugin
          contentEditable={<ContentEditable data-testid="composer-editor" aria-label="Composer" />}
          placeholder={null}
          ErrorBoundary={({ children }) => <>{children}</>}
        />
        <MentionPlugin
          workspacePath={WORKSPACE_PATH}
          workspaceIdentity={WORKSPACE_IDENTITY}
          sessionId={sessionId}
          provider="claude"
          container={document.getElementById("mention-panel-root")}
        />
      </LexicalComposer>
      <PluginCatalogProbe enabled={pluginProbeEnabled} sessionId={sessionId} />
    </>
  );
}

function initializePickerFixture(): void {
  const store = useRemoteWorkspaceSessionStore.getState();
  useRemoteWorkspaceSessionStore.setState({
    ...store,
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspacePath: {},
    sessionIdByWorkspaceIdentity: {},
  });

  const base = createController("base", "base");
  const initial = createController(INITIAL_ATTACHMENT, INITIAL_ATTACHMENT);
  controllers.clear();
  controllers.set("base", base);
  controllers.set(INITIAL_ATTACHMENT, initial);
  registerBaseWorkspaceServices(base.services);
  registerAttachment(INITIAL_ATTACHMENT, initial.services);

  const root = createRoot(document.getElementById("app")!);
  root.render(
    <ServiceProvider services={base.services}>
      <ZCodeIntlProvider initialLocale="en-US">
        <TabStoreProvider>
          <PickerFixture />
        </TabStoreProvider>
      </ZCodeIntlProvider>
    </ServiceProvider>,
  );
}

initializePickerFixture();
