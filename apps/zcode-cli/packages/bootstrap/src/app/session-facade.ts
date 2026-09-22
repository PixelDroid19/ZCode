import type { CreateSessionFacadeDeps, SessionFacade } from "./session-facade-contract.js";
import { createSessionClose } from "./session-facade-lifecycle.js";
import { createSessionModelOperations } from "./session-facade-models.js";
import { createSessionOperations } from "./session-facade-operations.js";
import { createSessionTargetOperations } from "./session-facade-targets.js";

export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  const models = createSessionModelOperations(deps);
  const targets = createSessionTargetOperations(deps);
  const lifecycle = createSessionClose(deps);
  const operations = createSessionOperations(deps);
  return {
    close: lifecycle.close,
    getMode: models.getMode,
    getModel: models.getModel,
    getLocale: models.getLocale,
    getTheme: models.getTheme,
    getDefaultThoughtLevel: models.getDefaultThoughtLevel,
    getThoughtLevel: models.getThoughtLevel,
    loadSessionTranscript: operations.loadSessionTranscript,
    readSubagents: operations.readSubagents,
    readSubagentTranscript: operations.readSubagentTranscript,
    readTodos: operations.readTodos,
    readTarget: targets.readTarget,
    setCustomSessionTitle: operations.setCustomSessionTitle,
    setTarget: targets.setTarget,
    updateTargetStatus: targets.updateTargetStatus,
    clearTarget: targets.clearTarget,
    listModels: models.listModels,
    getCurrentModelOption: models.getCurrentModelOption,
    getModelOption: models.getModelOption,
    listThoughtLevels: models.listThoughtLevels,
    listMcpServers: operations.listMcpServers,
    connectMcpServer: operations.connectMcpServer,
    readBackgroundBashOutput: operations.readBackgroundBashOutput,
    cancelBackgroundTask: operations.cancelBackgroundTask,
    disconnectMcpServer: operations.disconnectMcpServer,
    listCheckpoints: operations.listCheckpoints,
    forkFromCheckpoint: operations.forkFromCheckpoint,
    generateWorkspaceText: operations.generateWorkspaceText,
    testModelConnectivity: operations.testModelConnectivity,
    setMode: models.setMode,
    setModel: models.setModel,
    setThoughtLevel: models.setThoughtLevel,
    setLocale: models.setLocale,
  };
}
