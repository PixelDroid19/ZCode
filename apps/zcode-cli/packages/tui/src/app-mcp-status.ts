import { useEffect, useState } from "react";
import type { ZCodeCapabilitiesStatus } from "@zcode/shared";
import type { McpSidebarState } from "./app-model.js";
import type { TuiListMcpServers, TuiReadCapabilitiesStatus } from "./types.js";

const MCP_STATUS_REFRESH_INTERVAL_MS = 5_000;
const MCP_STATUS_RETRY_INTERVAL_MS = 10_000;

export function useMcpSidebarStatus(
  listMcpServers: TuiListMcpServers | undefined,
  readCapabilitiesStatus?: TuiReadCapabilitiesStatus,
): McpSidebarState {
  const [state, setState] = useState<McpSidebarState>(() => ({
    loading: listMcpServers !== undefined,
    servers: {},
  }));

  useEffect(() => {
    if (!listMcpServers && !readCapabilitiesStatus) {
      setState({ loading: false, servers: {} });
      return;
    }
    const loadMcpServers = listMcpServers;
    const readCapabilities = readCapabilitiesStatus;

    if (!loadMcpServers) {
      setState((current) => ({ ...current, error: undefined, loading: false, servers: {} }));
    }
    if (!readCapabilities) {
      setState((current) => ({ ...current, capabilityReloadError: undefined }));
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRefresh(delayMs: number) {
      timer = setTimeout(() => {
        void refresh();
      }, delayMs);
    }

    async function refresh() {
      const [mcpFailed, capabilitiesFailed] = await Promise.all([
        refreshMcpServers(),
        refreshCapabilities(),
      ]);
      if (disposed) return;
      scheduleRefresh(
        mcpFailed || capabilitiesFailed
          ? MCP_STATUS_RETRY_INTERVAL_MS
          : MCP_STATUS_REFRESH_INTERVAL_MS,
      );
    }

    async function refreshMcpServers(): Promise<boolean> {
      if (!loadMcpServers) return false;
      setState((current) => ({
        ...current,
        loading: Object.keys(current.servers).length === 0,
      }));

      try {
        const servers = await loadMcpServers();
        if (disposed) return false;
        setState((current) => ({ ...current, error: undefined, loading: false, servers }));
        return false;
      } catch (error) {
        if (disposed) return false;
        const message = error instanceof Error ? error.message : String(error);
        // Preserve the last valid rows while the refresh is retried.
        setState((current) => ({ ...current, error: message, loading: false }));
        return true;
      }
    }

    async function refreshCapabilities(): Promise<boolean> {
      if (!readCapabilities) return false;
      try {
        const status = await readCapabilities();
        if (disposed) return false;
        if (status?.status === "error") {
          setState((current) => ({
            ...current,
            capabilityReloadError: capabilityReloadError(status),
          }));
          return true;
        }
        if (status?.status === "ready") {
          setState((current) => ({ ...current, capabilityReloadError: undefined }));
        }
        return false;
      } catch (error) {
        if (disposed) return false;
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({ ...current, capabilityReloadError: message }));
        return true;
      }
    }

    void refresh();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [listMcpServers]);

  return state;
}

/** A loading transition is not an error; the sidebar keeps the prior reload notice until ready. */
export function capabilityReloadError(status: ZCodeCapabilitiesStatus): string | undefined {
  return status.status === "error" ? (status.error ?? "") : undefined;
}
