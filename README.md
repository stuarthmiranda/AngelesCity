# Angeles City - Votación al mejor jugador

Aplicación web adaptable para que los integrantes autorizados elijan al mejor jugador de cada partido. Usa **Firebase Authentication** y **Cloud Firestore**; no requiere Cloud Functions ni pasar del plan Spark.

## Configuración de Firebase

1. En Firebase Console, crea un proyecto y una base **Cloud Firestore**. Puedes mantener el plan Spark.
2. En **Authentication > Sign-in method**, habilita **Google** y **Email/Password** para las cuentas de los integrantes.
3. Registra una aplicación web en **Project settings > General**. Copia exactamente los seis valores de esa aplicación en `.env`, según las variables indicadas en `.env.example`. `VITE_FIREBASE_API_KEY` debe ser la clave completa de la app web de este mismo proyecto.
4. Publica las reglas en **Firestore Database > Rules** usando `firestore.rules`, o ejecuta:

   ```sh
   npx firebase-tools deploy --project TU_PROJECT_ID --only firestore:rules
   ```

5. Crea la cuenta administrativa una sola vez en **Authentication > Users > Add user**:

   - Email: `admin@angelescity-aa690.firebaseapp.com` (alias técnico creado para la cuenta; no necesita recibir correo).
   - Password: la contraseña que elegiste, por ejemplo `adminAngelesCity`.

6. Copia el **UID** de la cuenta que acabas de crear. En **Firestore Database > Data**, crea la colección `profiles` y agrega un documento cuyo ID sea ese UID, con estos campos:

   ```text
   display_name: "Administrador"  (string)
   role: "admin"                  (string)
   is_authorized: true            (boolean)
   created_at: "2026-10-28T00:00:00.000Z" (string)
   ```

   También se crea la colección `players` al primer registro de un integrante.
7. El ID del proyecto configurado es `angelescity-aa690`. Despliega las reglas y ejecuta `npm install` y `npm run dev`.
8. En el formulario general, escribe el usuario `admin` y la contraseña elegida.

Si aparece `auth/api-key-not-valid`, vuelve a **Configuración del proyecto > General > Tus apps > app web > Configuración del SDK** y copia otra vez el valor `apiKey` en `VITE_FIREBASE_API_KEY`. Comprueba que los seis valores pertenecen al proyecto `angelescity-aa690`, guarda `.env` y reinicia el servidor con `npm run dev`.

## Registro de integrantes y jugadores

1. Cada integrante inicia sesión con Google o se registra con correo y contraseña. Google se considera un proveedor verificado; las cuentas de correo y contraseña deben confirmar su correo. Si quiere usar ambos métodos, puede vincular la contraseña desde el panel de cuenta.
2. En el primer acceso, la app pide un nombre de usuario único y el nombre del jugador. Crea en una operación atómica `profiles/{UID}`, `profiles/username_{nombre_normalizado}` y `players/{UID}`. El perfil principal guarda el username; el documento con prefijo `username_` es un índice mínimo para encontrar el correo sin exponer los perfiles completos. Los nombres de usuario aceptan de 3 a 20 letras, números, punto, guion o guion bajo; no distinguen mayúsculas y `admin` está reservado.
3. Las cuentas que ya tenían perfil reciben una solicitud para elegir su nombre de usuario una sola vez al volver a iniciar sesión.
4. El campo de inicio de sesión acepta el correo o el nombre de usuario; el enlace para restablecer contraseña también acepta ambos.
5. Al completar el perfil, las cuentas nuevas quedan habilitadas automáticamente. El administrador puede desactivarlas o reactivarlas desde **Administración > Integrantes**.
6. Al crear un partido, el administrador selecciona a los jugadores activos y habilitados que asistieron. Solo esos jugadores pueden recibir votos. Cualquier integrante habilitado puede votar, pero no puede votarse a sí mismo.
7. Los nombres ya guardados no se borran al desactivar un jugador; así se conserva el historial.
8. Las cuentas que ya tenían username pueden seguir iniciando sesión con el índice antiguo `usernames/{username}`. No borres esa colección hasta copiar cada username antiguo a su correspondiente índice `profiles/username_{nombre}` y comprobar que el inicio de sesión funciona sin el respaldo antiguo.

## Permisos y colecciones

- El administrador puede ver y administrar jugadores e integrantes, crear partidos y abrir o cerrar votaciones.
- Las cuentas verificadas que completen el perfil quedan habilitadas automáticamente para votar, consultar el historial y ver resultados publicados; no pueden administrar.
- El registro público permite que cualquier persona con correo verificado cree una cuenta habilitada. El administrador puede desactivar cuentas no deseadas desde **Administración > Integrantes**.
- Firestore valida los permisos del lado del servidor, incluyendo votos duplicados, autovoto y estado del partido.
- El ranking acumula votos de partidos cerrados. La tabla MVP suma uno por cada partido ganado; si hay empate en el máximo de votos, cada jugador empatado recibe uno.
- **Mi perfil** permite consultar los datos de cuenta, vincular métodos de acceso y cambiar o quitar la foto. Las imágenes se reducen en el navegador a JPEG (hasta 400 px y 850 KB) y se guardan en `profile_photos/{UID}` de Firestore. La colección se crea automáticamente al guardar la primera foto; no es necesario crearla manualmente.
- El almacenamiento de fotos en Firestore evita Cloud Storage y el requisito del plan Blaze, pero consume cuota de documentos y lecturas/escrituras. Está pensado solo para avatares pequeños, no como almacenamiento general de imágenes.
- `profiles`: perfiles principales identificados por UID, además de índices mínimos `username_{nombre}` para resolver el correo con una lectura exacta; no se permite listar estos índices públicamente.
- El índice público de nombre de usuario contiene el correo asociado y solo puede consultarse por ID exacto; por lo tanto, alguien que adivine un username podría descubrir ese correo.
- `players`: nombre, estado e ID del perfil vinculado.
- `profile_photos`: una foto comprimida por usuario, identificada con su UID; cada usuario solo puede cambiar o borrar su propia foto y los usuarios autorizados pueden verla.
- `matches`: fecha, rival, estado y jugadores elegibles.
- `matches/{matchId}/players`: jugadores seleccionados para ese partido.
- `matches/{matchId}/votes`: votos; el ID del documento es el UID del votante.
- `audit_logs`: acciones administrativas y registro de votos.

## Publicación

La aplicación web se puede publicar con Firebase Hosting o Vercel. Configura allí las variables `VITE_FIREBASE_*` y agrega el dominio en **Authentication > Settings > Authorized domains**. El alias técnico del administrador no es un buzón real.

## Comandos

- `npm run dev`: servidor web local
- `npm run build`: comprobación TypeScript y compilación de producción
- `npm run preview`: vista previa de la compilación
- `npx firebase-tools emulators:exec --project demo-angeles-city --only firestore "echo Rules OK"`: compilar y validar las reglas localmente
