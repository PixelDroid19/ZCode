import type { ZCodeCopy } from "../types.js";

export const esES: ZCodeCopy = {
  locale: "es-ES",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Valor de --locale no soportado: ${value}. Locales soportados: en-US, zh-CN, es-ES, auto.`,
    },
    help: (version) => `zcode ${version}

Uso:
  zcode [comando] [opciones]

Sin comando, zcode abre la TUI a pantalla completa.

Comandos:
  app-server Ejecuta el servidor de aplicación stdio del ZCode Protocol
  commands   Lista comandos slash personalizados (\`commands list\`)
  doctor     Inspecciona el runtime y las suposiciones de empaquetado
  login [zai|bigmodel]  Inicia sesión mediante autorización en el navegador
  logout     Elimina las credenciales compartidas de Z.AI
  plugins    Gestiona plugins y marketplaces (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Lista skills locales (\`skills list\`)
  tui        Abre la interfaz de terminal
  version    Muestra la versión del CLI

Opciones:
  -h, --help       Muestra la ayuda
  -v, --version    Muestra la versión
  -p, --prompt <text>  Ejecuta un único prompt sin abrir la TUI
  --memory-bench   Con --prompt, activa la extracción automática de Memory y espera antes de salir (requiere Memory habilitado)
  --browser-use <mode> Activa el backend de Browser Use (soportado: headless)
  --surface <surface>  Superficie de presentación para prompts/app-server headless: terminal o desktop
  --browser-executable <path> Ejecutable de Chrome/Chromium para Browser Use headless
  --attach <path>  Adjunta un archivo local a --prompt; repite para varios archivos
  --cwd <path>     Ejecuta este comando desde el directorio indicado
  --disallowed-tools, --disallowedTools <tools...>
    Quita herramientas completas solo para esta ejecución de prompt/TUI; la configuración guardada no cambia.
    Nombres de herramienta separados por coma o espacio, p. ej. "Bash Edit".
    "Bash(git *)" quita todo Bash; los patrones de comando no se evalúan.
  --force-mcs      Fuerza la proyección de sistema a mitad de conversación para providers Anthropic
  --locale <locale>  Locale de la UI: en-US, zh-CN, es-ES o auto
  --mode <mode>    Modo de permisos para prompts: build, edit, plan o yolo (predeterminado: yolo para --prompt)
  --resume <sessionId>  Reanuda una sesión persistida por sessionId (sess_...)
  --target <text>  Ejecuta o define el objetivo de la sesión en modo headless
  --target-replace Reemplaza cualquier objetivo de sesión existente definido por --target
  -c, --continue        Reanuda la última sesión del directorio actual
  --json           Imprime JSON legible por máquina donde se soporte
  --no-browser     Imprime la URL de OAuth sin abrir un navegador
  --no-color       Desactiva los colores ANSI
  --verbose        Imprime detalle de diagnóstico adicional

Comandos slash:
  /help [command]       Muestra la ayuda de comandos slash
  /login                Elige inicio de sesión en navegador con Z.AI o BigModel
  /logout               Elimina las credenciales compartidas de Z.AI
  /compact [instructions]  Compacta la conversación actual
  /expert [status|resume|stop|<task>]  Ejecuta o gestiona el flujo de trabajo experto
  /dwf [list|cancel|resume]  Lista, cancela o reanuda ejecuciones de workflow dinámico
  /fork [latest|checkpointId]  Bifurca una sesión nueva desde un checkpoint del workspace
  /mcp [list|status|connect|disconnect]  Muestra o gestiona servidores MCP
  /mode [mode]          Muestra o cambia el modo de permisos: build, edit, plan o yolo
  /model [id]           Muestra o cambia el modelo de la sesión actual
  /new                  Inicia una sesión nueva en la TUI
  /resume [sessionId]   Reanuda una sesión por sessionId; omítelo para la última en cwd
  /rewind [latest|checkpointId]  Muestra el último checkpoint o restaura archivos del workspace
  /skill [name] [task]  Lista skills, o fuerza al siguiente prompt a cargar una
  /goal [action]        Muestra o define el objetivo de la sesión actual
`,
  },
  tui: {
    copy: {
      copied: "Texto seleccionado copiado al portapapeles.",
      failed: "No se pudo copiar el texto seleccionado.",
      unavailable: "La copia de texto al portapapeles no está disponible en esta terminal.",
    },
    effort: {
      disabled: "desactivado",
      enabled: "activado",
    },
    input: {
      activeStatusHint: "esc para interrumpir",
      busyPlaceholder: "Escribe para encolar la entrada",
      placeholder: "Escribe un prompt",
      queuedMore: (count) => `+ ${count} más en cola`,
      queuedSubmitHint: "Se enviará tras la próxima llamada de herramienta.",
      queuedTitle: (count) => ` En cola (${count}) `,
      title: "Entrada",
      noHistorySource: "No hay una fuente de historial de entrada configurada.",
      noPreviousInput: "No hay entrada previa para este proyecto.",
      restoredPreviousInput: "Entrada previa restaurada.",
      restoredPreviousInputWithAttachments: (count) =>
        `Entrada previa restaurada con ${count} adjunto(s).`,
      restorePreviousInputFailed: "No se pudo restaurar la entrada previa.",
      typePrompt: "Escribe una pregunta y pulsa Enter.",
    },
    loginRequired: {
      help: "Usa /model para ver modelos, o /login para conectar una cuenta Coding Plan.",
      message: "No hay modelos disponibles. Configura un provider o inicia sesión con /login.",
      status: "No hay modelos disponibles. Configura un provider o inicia sesión con /login.",
      title: "se requiere configurar el modelo",
    },
    loginSetup: {
      emptyMessage: "No hay opciones de inicio de sesión disponibles.",
      help: "Usa Arriba/Abajo para elegir, Enter para seleccionar.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Introduce la API Key de BigModel Coding Plan",
          inputSecondary: "Pega la clave aquí. Se oculta mientras escribes.",
          primary: "API Key de BigModel Coding Plan",
          secondary: "Pega una API key de Coding Plan manualmente.",
        },
        bigmodelOauth: {
          pendingPrimary: "Esperando autorización de BigModel",
          pendingSecondary:
            "Completa el inicio de sesión en tu navegador. La autorización se detecta automáticamente.",
          primary: "BigModel Coding Plan",
          secondary: "Abre el inicio de sesión en navegador; la autorización se detecta automáticamente.",
        },
        zaiApiKey: {
          inputPrimary: "Introduce la API Key de Z.AI Coding Plan",
          inputSecondary: "Pega la clave aquí. Se oculta mientras escribes.",
          primary: "API Key de Z.AI Coding Plan",
          secondary: "Pega una API key de Coding Plan manualmente.",
        },
        zaiOauth: {
          pendingPrimary: "Esperando autorización de Z.AI",
          pendingSecondary:
            "Completa el inicio de sesión en tu navegador. Continuaré cuando termine la autorización.",
          primary: "Z.AI Coding Plan",
          secondary: "Abre el inicio de sesión en navegador y crea una API key de Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Inicio de sesión cancelado. Elige un método de configuración.",
        help: "Esc cancela y vuelve a las opciones de configuración.",
        status: "Esperando autorización del navegador...",
      },
      input: {
        cancelStatus: "Entrada de API key cancelada. Elige un método de configuración.",
        clearStatus: "Entrada de API key borrada.",
        emptyStatus: "La API key es obligatoria.",
        help: "Enter guarda la clave. Esc vuelve a las opciones de configuración.",
        placeholder: "Pega la API key",
        status: "Introduce la API key y pulsa Enter.",
        submitStatus: "Guardando API key...",
      },
      prompt: "Elige un método de inicio de sesión o de configuración de API key.",
      response: "Elige cómo configurar un provider de Coding Plan.",
      title: "Configurar Coding Plan",
    },
    model: {
      requestFailed: (message) => `La petición al modelo falló: ${message}`,
      responseReceived: "Respuesta del modelo recibida.",
      responseReceivedWithTokens: (tokens) => `Respuesta del modelo recibida. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Reintentando petición al modelo ${attempt}/${Math.max(1, maxAttempts - 1)} en ${delay}: ${reason}`,
      streamStalled: "El stream del modelo se estancó.",
    },
    sidebar: {
      subagents: {
        title: "Subagentes",
        empty: "Aún no hay subagentes.",
        emptyOutput: "Aún no hay salida.",
        back: "← Conversación principal",
        readonly: "Solo lectura · Esc para volver",
        loading: "Cargando salida del subagente...",
        unavailable: "Salida del subagente no disponible.",
        retry: "Reintentar",
        more: "Cargar más",
        pendingMain: "La conversación principal necesita tu entrada — vuelve para responder",
        ended: (count) => `Terminados (${count})`,
        status: {
          running: "en ejecución",
          waiting: "esperando",
          blocked: "bloqueado",
          success: "completado",
          failed: "fallido",
          cancelled: "cancelado",
          lost: "perdido",
        },
      },
      api: {
        empty: "Aún no hay llamadas de API.",
        model: "Modelo",
        more: (count) => `+${count} más`,
        requests: "Peticiones",
        server: "Servidor",
      },
      cache: {
        hit: "acierto",
        lastHit: "último acierto",
        lastMiss: "último fallo",
        readWrite: ({ read, write }) => `${read} lectura / ${write} escritura`,
        total: "total",
      },
      context: {
        cache: "Caché",
        cacheReadWrite: "Caché L/E",
        inputOutput: "E/S",
        reason: "Motivo",
        tokens: "Tokens",
        used: "Usado",
        window: "Ventana",
      },
      modifiedFiles: {
        empty: "Aún no hay cambios de archivos.",
        more: (count) => `+${count} más`,
      },
      mcp: {
        empty: "No hay servidores MCP configurados.",
        loadFailed: "Estado de MCP no disponible.",
        loading: "Cargando estado de MCP...",
        more: (count) => `+${count} más`,
        servers: "Servidores",
        status: {
          connected: "conectado",
          connecting: "conectando",
          disabled: "desactivado",
          disconnected: "desconectado",
          failed: "fallido",
          untrusted: "no confiable",
        },
        summary: ({ connected, total }) => `${connected}/${total} conectados`,
        tools: (count) => `${count} ${count === 1 ? "herramienta" : "herramientas"}`,
      },
      request: {
        complete: "completa",
        error: "error",
        errorWithStatus: (statusCode) => `error ${statusCode}`,
        pending: "pendiente",
      },
      status: {
        last: "Última",
      },
      run: {
        draft: "Borrador",
        draftChars: (count) => `${count} caracteres`,
        draftEmpty: "vacío",
        messages: "Mensajes",
        mode: "Modo",
        model: "Modelo",
        provider: "Provider",
        thought: "Pensamiento",
        trace: "Traza",
        turn: "Turno",
        workspace: "Workspace",
      },
      sections: {
        apis: "APIs",
        context: "Contexto",
        mcp: "MCP",
        modifiedFiles: "Archivos modificados",
        run: "Ejecución",
        status: "Estado",
        todos: "Tareas",
      },
      shellSubtitle: "Shell OpenTUI",
      title: "Barra lateral",
      todos: {
        empty: "Aún no hay tareas.",
        more: (count) => `+${count} más`,
        progress: "Progreso",
      },
    },
    status: {
      compactFailed: "La compresión de contexto falló.",
      compacted: "Conversación compactada.",
      compacting: "Comprimiendo contexto...",
      interruptedStreamDiscarded: "Stream de modelo interrumpido descartado.",
      modelCalling: "Llamando al modelo...",
      permissionRequested: (toolName) => `Permiso solicitado para ${toolName}.`,
      permissionResolved: (toolName) => `Permiso resuelto para ${toolName}.`,
      ready: "Listo.",
      recoveringStream: "Recuperando stream de modelo interrumpido...",
      retryingStream: "Reintentando stream del modelo...",
      sessionResumed: "Sesión reanudada.",
      targetChanged: (action) => `Objetivo ${action}.`,
      thinking: "Pensando...",
      toolCompleted: (toolName) => `Herramienta ${toolName} completada.`,
      toolFailed: (toolName) => `Herramienta ${toolName} falló.`,
      toolPending: (toolName) => `Herramienta ${toolName} pendiente.`,
      toolRunning: (toolName) => `Herramienta ${toolName} en ejecución.`,
      turnFailed: "El turno falló.",
    },
    terminal: {
      requiresInteractive: "La TUI requiere una terminal interactiva.",
      starting: "Iniciando ZCode... Ctrl+C para salir",
    },
    transcript: {
      compact: {
        completed: "Contexto comprimido",
        failed: "La compresión de contexto falló",
        interrupted: "Compresión de contexto interrumpida",
        retry: (command) => `Ctrl-R para reintentar ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Reintentando compresión de contexto (${attempt}/${maxAttempts})`
            : "Reintentando compresión de contexto",
        skipped: "El contexto está al día; no hace falta compresión",
        started: "Comprimiendo contexto",
      },
      roles: {
        agent: "Agente",
        system: "Sistema",
        user: "Usuario",
      },
      thought: {
        complete: "Pensamiento",
        thinking: "Pensando...",
      },
      title: "Transcripción",
      workflow: {
        actors: "actores:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `uso: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Workflow ${label} - ${status} (${nodesSettled}/${nodesTotal} pasos)`,
        error: (message) => `error: ${message}`,
        expandHint: "+ para expandir",
        collapseHint: "- para contraer",
        log: "log:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} pasos resueltos`,
        result: (preview) => `resultado: ${preview}`,
        status: {
          completed: "completado",
          errored: "con error",
          pending: "pendiente",
          running: "en ejecución",
          stopped: "detenido",
        },
        stopReason: {
          user: "por ti",
          model: "por el agente",
          provider: "error del modelo",
          interrupted: "el proceso terminó",
          superseded: "reemplazado por una ejecución corregida",
        },
        truncated: "(truncado - historial completo en el journal de la ejecución)",
        interruptedNotice: ({ label, runId }) =>
          `El workflow ${label} se interrumpió y puede reanudarse: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter selecciona, Esc cancela",
      disabled: (reason) => ` [desactivado: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filtro: ${filter || "-"} | ${help ?? "Enter selecciona, Esc cancela"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "No hay rutas del workspace que coincidan.",
      loading: "Cargando rutas del workspace...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Archivos",
    },
    slash: {
      title: "Comandos",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
