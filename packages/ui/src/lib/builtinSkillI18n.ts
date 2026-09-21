import type { Locale, SkillScope } from "@zcode/shared";

interface SkillDisplayCandidate {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  pluginName?: string;
}

const OFFICIAL_BUILTIN_PLUGIN_NAMES = new Set([
  "android-emulator",
  "browser",
  "browser-use",
  "document-skills",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "ios-simulator",
  "skill-creator",
  "plugin-creator",
  "superpowers",
  "zcode-guide",
]);

const OFFICIAL_PLUGIN_PATH_MARKERS = [
  "/zcode-plugins-official/",
  "\\zcode-plugins-official\\",
  "/android-emulator-plugin/",
  "/browser-use-plugin/",
  "/document-skills-plugin/",
  "/documents-plugin/",
  "/pdf-plugin/",
  "/presentations-plugin/",
  "/spreadsheets-plugin/",
  "/ios-simulator-plugin/",
  "/skill-creator-plugin/",
  "/plugin-creator-plugin/",
  "/superpowers-plugin/",
  "/zcode-guide-plugin/",
];

const BUILTIN_SKILL_DESCRIPTIONS: Record<string, Record<Locale, string>> = {
  "android-dev": {
    "zh-CN": "通过 android-emulator MCP 工具构建、运行、检查并轻量自动化 Android 应用。",
    "en-US":
      "Build, run, inspect, and lightly automate Android apps through the android-emulator MCP tools.",
    "es-ES":
      "Compila, ejecuta, inspecciona y automatiza ligeramente apps de Android mediante las herramientas MCP de android-emulator.",
  },
  brainstorming: {
    "zh-CN":
      "在任何创造性工作前使用：创建功能、构建组件、增加能力或修改行为；先探索用户意图、需求和设计。",
    "en-US":
      "Use before any creative work, including creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements, and design before implementation.",
    "es-ES":
      "Úsala antes de cualquier trabajo creativo: crear funciones, construir componentes, añadir capacidades o modificar comportamiento. Explora la intención, los requisitos y el diseño del usuario antes de implementar.",
  },
  "control-browser": {
    "zh-CN": "控制 ZCode 内置浏览器，用于打开、检查、点击、输入、截图或验证网页和本地开发页面。",
    "en-US":
      "Control ZCode's built-in browser to open, inspect, click, type, screenshot, or verify webpages and local development targets.",
    "es-ES":
      "Controla el navegador integrado de ZCode para abrir, inspeccionar, hacer clic, escribir, capturar pantalla o verificar páginas web y destinos de desarrollo locales.",
  },
  "dispatching-parallel-agents": {
    "zh-CN": "面对 2 个以上彼此独立、无共享状态或顺序依赖的任务时使用。",
    "en-US":
      "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies.",
    "es-ES":
      "Úsala ante 2 o más tareas independientes que puedan trabajarse sin estado compartido ni dependencias secuenciales.",
  },
  docx: {
    "zh-CN":
      "完整的 DOCX 文档创建、编辑与分析能力，支持修订、批注、格式保持和文本提取。适用于创建新文档、修改内容、处理修订、添加批注或其它专业 Word 文档任务。",
    "en-US":
      "Create, edit, and analyze DOCX documents with revisions, comments, formatting preservation, and text extraction. Use for new documents, edits, revision handling, comments, and professional Word document work.",
    "es-ES":
      "Crea, edita y analiza documentos DOCX con revisiones, comentarios, conservación de formato y extracción de texto. Úsala para documentos nuevos, ediciones, manejo de revisiones, comentarios y trabajo profesional con Word.",
  },
  "dynamic-workflows": {
    "zh-CN":
      "编写、调试或重新提交 CreateWorkflow 的 dynamic workflow 脚本时使用：如何设计子代理拓扑、定义结果类型、按文件或 git 扇出、用 world.run 命令做门控检查、用 EvalWorkflowSnippet 预检片段、写 planner-reviewer 循环、用 report() 保住已完成的工作、把产物发布给用户，以及 run 转入后台后该怎么处理。",
    "en-US":
      "Use when writing, debugging, or resubmitting a dynamic-workflow script for CreateWorkflow: choosing subagent topology, typing subagent results, fanning out over files or git, gating loops on world.run commands, testing pieces with EvalWorkflowSnippet, planner-reviewer loops, report() salvage, publishing artifacts the user opens, and handling a backgrounded run.",
    "es-ES":
      "Úsala al escribir, depurar o reenviar un script de dynamic-workflow para CreateWorkflow: elegir la topología de subagentes, tipar sus resultados, hacer fan-out por archivos o git, gatear bucles con comandos world.run, probar piezas con EvalWorkflowSnippet, bucles planner-reviewer, salvamento con report(), publicar artefactos para el usuario y manejar una ejecución en segundo plano.",
  },
  "executing-plans": {
    "zh-CN": "已有书面实现计划，并要在带评审检查点的独立会话中执行时使用。",
    "en-US":
      "Use when you have a written implementation plan to execute in a separate session with review checkpoints.",
    "es-ES":
      "Úsala cuando tengas un plan de implementación escrito para ejecutar en una sesión separada con puntos de revisión.",
  },
  "finishing-a-development-branch": {
    "zh-CN": "实现已完成、测试通过、需要决定如何合并、发 PR 或清理分支时使用。",
    "en-US":
      "Use when implementation is complete, tests pass, and you need to decide how to integrate the work through merge, PR, or cleanup.",
    "es-ES":
      "Úsala cuando la implementación esté completa, los tests pasen y necesites decidir cómo integrar el trabajo mediante merge, PR o limpieza.",
  },
  "ios-dev": {
    "zh-CN": "通过 ios-simulator MCP 工具构建、运行、检查并轻量自动化 iOS 模拟器应用。",
    "en-US":
      "Build, run, inspect, and lightly automate iOS Simulator apps through the ios-simulator MCP tools.",
    "es-ES":
      "Compila, ejecuta, inspecciona y automatiza ligeramente apps del simulador de iOS mediante las herramientas MCP de ios-simulator.",
  },
  pdf: {
    "zh-CN":
      "专业 PDF 工具集，覆盖报告、创意视觉、学术 LaTeX 和现有 PDF 处理四条生产线。可按文档类型自动路由，支持报告、海报、论文、简历、提取、合并、拆分、表单填写和格式转换等任务。",
    "en-US":
      "Professional PDF toolkit for reports, creative visuals, academic LaTeX, and existing-PDF workflows. Supports reports, posters, papers, resumes, extraction, merge, split, forms, and conversion.",
    "es-ES":
      "Kit profesional de PDF para informes, visuales creativos, LaTeX académico y flujos con PDF existentes. Soporta informes, pósters, artículos, currículums, extracción, unión, división, formularios y conversión.",
  },
  pptx: {
    "zh-CN":
      "检查并窄范围更新从 PPTX 预览区选择的元素。通过完整文件指纹和 OOXML 定位校验 shape 文本或表格单元格，冲突时停止而不猜测。",
    "en-US":
      "Inspect and narrowly update elements selected in PPTX Preview Pane. Verifies the whole-file fingerprint and OOXML locator for shape or table-cell text, and stops on conflicts instead of guessing.",
    "es-ES":
      "Inspecciona y actualiza de forma acotada los elementos seleccionados en el panel de vista previa de PPTX. Verifica el fingerprint del archivo completo y el localizador OOXML del texto de una shape o celda, y se detiene ante conflictos en lugar de adivinar.",
  },
  "receiving-code-review": {
    "zh-CN":
      "收到代码评审反馈、准备实现建议前使用；尤其当反馈不清楚或技术上可疑时，需要严谨验证而非盲目同意。",
    "en-US":
      "Use when receiving code review feedback before implementing suggestions, especially when feedback is unclear or technically questionable.",
    "es-ES":
      "Úsala al recibir feedback de revisión de código antes de implementar sugerencias, especialmente cuando el feedback no es claro o es técnicamente cuestionable.",
  },
  "requesting-code-review": {
    "zh-CN": "完成任务、实现重大功能或合并前，用于请求代码评审以确认满足需求。",
    "en-US":
      "Use when completing tasks, implementing major features, or before merging to verify work meets requirements.",
    "es-ES":
      "Úsala al completar tareas, implementar funciones importantes o antes de hacer merge, para verificar que el trabajo cumple los requisitos.",
  },
  "plugin-creator": {
    "zh-CN": "创建、校验 ZCode 插件，并指导本地安装与更新。",
    "en-US": "Create and validate ZCode plugins, and guide local installation and updates.",
    "es-ES": "Crea y valida plugins de ZCode, y guía la instalación y actualización locales.",
  },
  "skill-creator": {
    "zh-CN":
      "创建新技能、编辑现有技能并迭代措辞。适用于从零编写 SKILL.md、改进已有技能、把重复工作流沉淀为可复用技能，或优化技能描述以提升触发可靠性。",
    "en-US":
      "Create new skills, edit existing skills, and iterate wording. Use for writing SKILL.md from scratch, improving skills, capturing repeated workflows, or tuning descriptions for reliable triggering.",
    "es-ES":
      "Crea skills nuevos, edita los existentes e itera su redacción. Úsala para escribir SKILL.md desde cero, mejorar skills, convertir flujos repetidos en skills reutilizables o afinar descripciones para un disparo fiable.",
  },
  "subagent-driven-development": {
    "zh-CN": "在当前会话中执行包含独立任务的实现计划时使用。",
    "en-US":
      "Use when executing implementation plans with independent tasks in the current session.",
    "es-ES":
      "Úsala al ejecutar planes de implementación con tareas independientes en la sesión actual.",
  },
  "systematic-debugging": {
    "zh-CN": "遇到任何 bug、测试失败或异常行为时，在提出修复前使用。",
    "en-US":
      "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.",
    "es-ES":
      "Úsala ante cualquier bug, fallo de test o comportamiento inesperado, antes de proponer correcciones.",
  },
  "test-driven-development": {
    "zh-CN": "实现任何功能或 bugfix 时，在编写实现代码前使用。",
    "en-US": "Use when implementing any feature or bugfix, before writing implementation code.",
    "es-ES":
      "Úsala al implementar cualquier función o corrección de bug, antes de escribir el código de implementación.",
  },
  "using-git-worktrees": {
    "zh-CN":
      "开始需要隔离的功能工作或执行实现计划前使用，确保存在隔离 workspace，优先使用原生工具，否则回退 git worktree。",
    "en-US":
      "Use when starting feature work that needs isolation or before executing implementation plans. Ensures an isolated workspace exists via native tools or git worktree fallback.",
    "es-ES":
      "Úsala al empezar trabajo de funciones que necesita aislamiento o antes de ejecutar planes de implementación. Garantiza que existe un workspace aislado mediante herramientas nativas o git worktree como alternativa.",
  },
  "using-superpowers": {
    "zh-CN":
      "开始任何对话时使用；说明如何查找和使用技能，并要求在任何回复包括澄清问题前调用 Skill 工具。",
    "en-US":
      "Use when starting any conversation. Establishes how to find and use skills, requiring Skill tool invocation before any response including clarifying questions.",
    "es-ES":
      "Úsala al iniciar cualquier conversación. Establece cómo encontrar y usar skills, y exige invocar la herramienta Skill antes de cualquier respuesta, incluidas preguntas aclaratorias.",
  },
  "verification-before-completion": {
    "zh-CN":
      "准备声明工作完成、已修复或测试通过前使用；要求先运行验证命令并确认输出，先有证据再下结论。",
    "en-US":
      "Use before claiming work is complete, fixed, or passing. Requires running verification commands and confirming output before success claims.",
    "es-ES":
      "Úsala antes de afirmar que el trabajo está completo, corregido o pasando. Exige ejecutar comandos de verificación y confirmar la salida antes de afirmar el éxito.",
  },
  "web-gui-tester": {
    "zh-CN":
      "使用 ZCode Browser Use 对网页和本地 Web 前端执行纯 GUI 黑盒测试，通过真实用户交互、DOM 语义证据和截图验证功能、交互与响应式布局。",
    "en-US":
      "Run pure GUI black-box tests against websites and local web frontends with ZCode Browser Use, combining real user interactions, semantic DOM evidence, and inspected screenshots.",
    "es-ES":
      "Ejecuta tests GUI de caja negra contra sitios web y frontends web locales con ZCode Browser Use, combinando interacciones de usuario reales, evidencia semántica del DOM y capturas inspeccionadas.",
  },
  "writing-plans": {
    "zh-CN": "已有规格或多步骤任务需求，在动代码前用于编写实现计划。",
    "en-US":
      "Use when you have a spec or requirements for a multi-step task, before touching code.",
    "es-ES":
      "Úsala cuando tengas una especificación o requisitos de una tarea de varios pasos, antes de tocar código.",
  },
  "writing-skills": {
    "zh-CN": "创建新技能、编辑现有技能或在发布前验证技能是否有效时使用。",
    "en-US":
      "Use when creating new skills, editing existing skills, or verifying skills work before deployment.",
    "es-ES":
      "Úsala al crear skills nuevos, editar los existentes o verificar que funcionan antes de publicarlos.",
  },
};

export function resolveSkillSourceLabel(scope: SkillScope, locale?: Locale): string {
  if (locale === "zh-CN") {
    if (scope === "workspace") return "工作区";
    if (scope === "plugin") return "插件";
    return "用户";
  }
  if (locale === "es-ES") {
    if (scope === "workspace") return "Workspace";
    if (scope === "plugin") return "Plugin";
    return "Usuario";
  }
  if (scope === "workspace") return "Workspace";
  if (scope === "plugin") return "Plugin";
  return "User";
}

export function resolveSkillDisplayDescription(
  skill: SkillDisplayCandidate,
  locale?: Locale,
): string {
  const localized = isOfficialBuiltinSkill(skill)
    ? BUILTIN_SKILL_DESCRIPTIONS[skill.name]?.[locale ?? "en-US"]
    : undefined;
  return localized ?? skill.description;
}

function isOfficialBuiltinSkill(skill: SkillDisplayCandidate): boolean {
  if (skill.scope !== "plugin") {
    return false;
  }
  const pluginName = skill.pluginName?.trim();
  if (pluginName && OFFICIAL_BUILTIN_PLUGIN_NAMES.has(pluginName)) {
    return true;
  }
  const normalizedPath = skill.path.replaceAll("\\", "/");
  return OFFICIAL_PLUGIN_PATH_MARKERS.some((marker) => normalizedPath.includes(marker));
}
