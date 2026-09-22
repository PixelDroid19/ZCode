export const retrievalCases = [
  {
    topic: "sqlite_writer",
    title: "SQLite: database is locked",
    summary:
      "La escritura SQLite fallaba por transacciones simultáneas. Serializamos las transacciones de escritura y configuramos busy_timeout para esperar al escritor activo.",
    keyword: "SQLite database is locked busy_timeout",
    paraphrase:
      "El almacén local rechaza modificaciones concurrentes; ¿qué hicimos para que los escritores se turnaran?",
    crossLanguage: "How did we fix competing writers locking the embedded database?",
  },
  {
    topic: "oauth_cookie",
    title: "OAuth callback sin cookie de sesión",
    summary:
      "El retorno OAuth perdía la cookie al cruzar orígenes. La corrección fue SameSite=None y Secure sobre HTTPS, conservando la verificación de state.",
    keyword: "OAuth callback cookie SameSite",
    paraphrase:
      "Al volver del proveedor de identidad se perdía el acceso; ¿cómo conservamos la autenticación entre dominios?",
    crossLanguage: "Why did sign-in forget the login after returning from an identity provider?",
  },
  {
    topic: "watcher_inotify",
    title: "Watcher Linux ENOSPC inotify",
    summary:
      "El watcher agotaba los descriptores inotify de Linux. Excluimos node_modules y dist de la observación para reducir archivos vigilados antes de elevar el límite del sistema.",
    keyword: "ENOSPC inotify watcher Linux",
    paraphrase:
      "El observador dejó de detectar ediciones al agotar los recursos del kernel; ¿qué directorios dejamos fuera?",
    crossLanguage: "What folders did we exclude when file watching exhausted kernel resources?",
  },
  {
    topic: "stream_utf8",
    title: "UTF-8 partido entre chunks SSE",
    summary:
      "Los acentos se corrompían cuando un carácter UTF-8 quedaba dividido entre chunks SSE. Reutilizamos un TextDecoder con stream=true para conservar los bytes incompletos.",
    keyword: "UTF-8 chunks SSE TextDecoder",
    paraphrase:
      "Las letras acentuadas llegaban rotas cuando sus bytes venían en paquetes distintos; ¿cómo evitamos perder el fragmento pendiente?",
    crossLanguage: "How did we preserve a multibyte character split across network packets?",
  },
  {
    topic: "lease_owner",
    title: "Lease de tarea sobrescrito por propietario antiguo",
    summary:
      "Un propietario antiguo completaba una tarea después de perder su lease. La transición terminal compara ownerId y fencingToken en una única escritura atómica.",
    keyword: "lease ownerId fencingToken tarea",
    paraphrase:
      "Un ejecutor que ya había perdido la concesión seguía marcando el trabajo como terminado; ¿qué verificamos al cerrar?",
    crossLanguage: "How did we stop a stale worker from finalizing a job it no longer owned?",
  },
  {
    topic: "windows_paths",
    title: "Rutas Windows con espacios y comillas",
    summary:
      "El lanzamiento Windows dividía una ruta que contenía espacios. Usamos execFile con una lista de argumentos en lugar de concatenar una orden para el shell.",
    keyword: "Windows rutas espacios execFile",
    paraphrase:
      "La aplicación no arrancaba desde una carpeta cuyo nombre tenía blancos; ¿cómo pasamos los parámetros sin partirlos?",
    crossLanguage: "How did we launch a program from a directory name containing whitespace?",
  },
  {
    topic: "timezone_day",
    title: "Fecha civil desplazada por zona horaria",
    summary:
      "Una fecha YYYY-MM-DD se convertía a UTC y aparecía el día anterior en Bogotá. Conservamos la fecha civil sin construir un instante Date para ese campo.",
    keyword: "fecha YYYY-MM-DD UTC Bogotá",
    paraphrase:
      "El calendario mostraba la jornada previa por convertir una fecha sin hora; ¿qué representación mantuvimos?",
    crossLanguage: "Why did a date-only calendar value shift to the previous day?",
  },
  {
    topic: "pagination_cursor",
    title: "Paginación duplicaba filas con timestamps iguales",
    summary:
      "La paginación por timestamp saltaba y duplicaba filas cuando varios eventos tenían la misma fecha. Usamos cursor compuesto por createdAt e id y ordenamos por ambos campos.",
    keyword: "paginación timestamp cursor createdAt",
    paraphrase:
      "Al pedir el siguiente bloque faltaban elementos empatados en el tiempo; ¿qué segundo criterio añadimos al orden?",
    crossLanguage: "How did we avoid missing items tied on time when fetching the next page?",
  },
] as const;
