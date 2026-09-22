export type Arm = "on" | "off";
export type Stage = "initial" | "updated";

export interface BenchmarkCase {
  id: string;
  stage: Stage;
  project: "a" | "b";
  question: string;
  expected: Partial<Answer>;
  category: "recall" | "negative" | "control";
}

export interface Answer {
  answer: string | null;
  status: string | null;
  reason: string | null;
}

export function fixture(replica: number) {
  const suffix = String(41 + replica * 32);
  const project = `Alba${suffix}`;
  const incident = `Fenix${suffix}`;
  const repair = `epoch${suffix}`;
  const cause = `stale_owner_${suffix}`;
  const preference = `repair-${suffix}/`;
  const oldPort = `421${suffix}`;
  const port = `427${suffix}`;
  const acknowledge = " No ejecutes acciones ni herramientas; responde con una frase breve.";
  const initial = [
    `En el proyecto ${project} resolvimos la incidencia ${incident}: se duplicaban trabajos tras cambiar de líder. La solución fue establecer fencingMode=${repair}. La causa registrada es ${cause}: el propietario anterior conservaba un arrendamiento obsoleto. Yo, el usuario, confirmo que ese cambio funcionó. Esta experiencia es específica de este proyecto.${acknowledge}`,
    `Mi preferencia personal, aplicable a todos mis proyectos y agentes: las ramas para arreglos deben comenzar exactamente por ${preference}. Es una convención mía entre proyectos, no una regla exclusiva de ${project}.${acknowledge}`,
    `Dato exclusivo del proyecto ${project}: su canal de despliegue de laboratorio se llama canopy-${suffix}. Es un nombre ficticio, no una credencial. No es una preferencia personal y no corresponde compartirlo con otros proyectos.${acknowledge}`,
    `Configuración actual del proyecto ${project}: el servidor de fixtures de laboratorio usa el puerto ${oldPort}. Esta decisión debe persistir para futuras sesiones de este proyecto.${acknowledge}`,
  ];
  const updates = [
    `La incidencia ${incident} reapareció en ${project}. El cambio fencingMode=${repair} NO solucionó definitivamente el problema: hoy volvió a duplicar trabajos. Mi confirmación anterior ya no representa el estado actual. Registra la recurrencia y no lo presentes como resuelto.${acknowledge}`,
    `Corrección permanente para ${project}: el servidor de fixtures ahora usa el puerto ${port}; reemplaza el valor anterior ${oldPort}, que dejó de ser válido.${acknowledge}`,
  ];
  const cases: BenchmarkCase[] = [
    {
      id: "repair_and_cause",
      stage: "initial",
      project: "a",
      category: "recall",
      question: `En ${project}, ¿qué valor de fencingMode resolvió ${incident}, qué código de causa se registró y cuál fue el estado confirmado por el usuario?`,
      expected: { answer: repair, status: "user_confirmed", reason: cause },
    },
    {
      id: "portable_preference",
      stage: "initial",
      project: "b",
      category: "recall",
      question:
        "Estamos en otro proyecto del mismo usuario. ¿Qué prefijo personal exacto había elegido para las ramas de arreglos?",
      expected: { answer: preference },
    },
    {
      id: "recurrence",
      stage: "updated",
      project: "a",
      category: "recall",
      question: `¿Cuál es ahora el estado de ${incident} en ${project}, después del último informe del usuario? Devuelve el valor de fencingMode que se había intentado y el estado actual.`,
      expected: { answer: repair, status: "recurring" },
    },
    {
      id: "latest_value",
      stage: "updated",
      project: "a",
      category: "recall",
      question: `¿Cuál es el puerto vigente del servidor de fixtures de ${project}?`,
      expected: { answer: port },
    },
    {
      id: "project_isolation",
      stage: "updated",
      project: "b",
      category: "negative",
      question: `¿Cuál era el canal de despliegue de laboratorio del proyecto ${project}?`,
      expected: { answer: null, status: "unknown", reason: null },
    },
    {
      id: "unknown_fact",
      stage: "updated",
      project: "a",
      category: "negative",
      question: `¿Qué versión exacta del compilador Kotlin usa ${project}?`,
      expected: { answer: null, status: "unknown", reason: null },
    },
    {
      id: "paraphrase",
      stage: "updated",
      project: "a",
      category: "recall",
      question:
        "¿Qué ajuste de protección habíamos intentado para impedir que dos líderes se creyeran dueños del mismo trabajo? Indica el valor del ajuste y si sigue considerándose una solución confirmada o si el fallo volvió.",
      expected: { answer: repair, status: "recurring" },
    },
    {
      id: "self_contained",
      stage: "updated",
      project: "a",
      category: "control",
      question: "Pregunta independiente de cualquier sesión anterior: ¿cuánto es 17 + 25?",
      expected: { answer: "42" },
    },
  ];
  return { initial, updates, cases, privateValue: `canopy-${suffix}` };
}

export function questionPrompt(question: string): string {
  return `${question}\n\nResponde únicamente con un objeto JSON: {"answer": string|null, "status": string|null, "reason": string|null}. Usa status "user_confirmed", "recurring", "recorded" o "unknown" cuando corresponda. Si no conoces la respuesta, answer debe ser null y status "unknown". Usa en answer sólo el valor exacto solicitado y en reason el código de causa si se pidió. Consulta los recuerdos disponibles si ayudan, sin crearlos ni modificarlos. No supongas que una solución anterior sigue siendo válida.`;
}

export function score(text: string, expected: Partial<Answer>) {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { passed: false, malformed: true };
    }
    const answer = parsed as Record<string, unknown>;
    const valid =
      Object.keys(answer).length === 3 &&
      ["answer", "status", "reason"].every(
        (key) => answer[key] === null || typeof answer[key] === "string",
      ) &&
      [null, "user_confirmed", "recurring", "recorded", "unknown"].includes(
        answer.status as string | null,
      );
    return {
      passed: valid && Object.entries(expected).every(([key, value]) => answer[key] === value),
      malformed: !valid,
      answer,
    };
  } catch {
    return { passed: false, malformed: true };
  }
}
