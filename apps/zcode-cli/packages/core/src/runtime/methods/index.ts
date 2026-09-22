import { installRuntimeConfigurationMethods } from "./install-configuration-methods.js";
import { installRuntimeContextMethods } from "./install-context-methods.js";
import { installRuntimeSteeringMethods } from "./install-steering-methods.js";
import { installRuntimeTurnExecutionMethods } from "./install-turn-execution-methods.js";

type AgentRuntimeConstructor = { prototype: object };

export function installAgentRuntimeMethods(ctor: AgentRuntimeConstructor): void {
  const proto = ctor.prototype as Record<string, unknown>;
  installRuntimeConfigurationMethods(proto);
  installRuntimeSteeringMethods(proto);
  installRuntimeContextMethods(proto);
  installRuntimeTurnExecutionMethods(proto);
}
