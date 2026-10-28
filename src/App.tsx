import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  unlink,
  type User,
} from 'firebase/auth'
import {
  createMatch as createMatchRecord,
  approveMember as approveMemberRecord,
  createMemberProfile,
  deleteProfilePhoto,
  loadProfile,
  loadProfilePhotos,
  loadAuditLogs,
  loadMatchResults,
  loadMatches,
  loadMyVotes,
  loadPlayers,
  loadProfiles,
  loadRanking as fetchRanking,
  loadRoster,
  normalizeUsername,
  savePlayer as savePlayerRecord,
  resolveUsernameEmail,
  saveProfilePhoto,
  setMemberUsername,
  setMatchStatus as updateMatchStatus,
  submitVote as castVote,
  togglePlayer as togglePlayerRecord,
  updateMember as updateMemberRecord,
  type AuditLog,
  type Match,
  type MatchPlayer,
  type MatchResult,
  type Player,
  type Profile,
  type RankingRow,
  type VoteRecord,
} from './lib/firestore'
import { auth, db, ADMIN_EMAIL, isFirebaseConfigured } from './lib/firebase'

type Tab = 'vote' | 'history' | 'admin' | 'profile'

const errorMessage = (error: unknown) => {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.includes('api-key-not-valid')
  ) {
    return 'La clave de Firebase no es válida para este proyecto. Copia de nuevo la configuración de la app web desde Firebase Console, actualiza VITE_FIREBASE_API_KEY en .env y reinicia npm run dev.'
  }
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado.'
}

const formatDate = (date: string) =>
  new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(`${date}T12:00:00`))

const formatDateTime = (date: string) =>
  new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date))

const localToday = () => {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

async function prepareProfilePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Selecciona un archivo de imagen.')
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('La imagen debe pesar menos de 10 MB.')
  }

  const image = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 400 / Math.max(image.width, image.height))
    for (const reduction of [1, 0.85, 0.7, 0.55]) {
      const dimensionScale = scale * reduction
      canvas.width = Math.max(1, Math.round(image.width * dimensionScale))
      canvas.height = Math.max(1, Math.round(image.height * dimensionScale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('No se pudo procesar la imagen en este dispositivo.')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.8, 0.65, 0.5]) {
        const result = canvas.toDataURL('image/jpeg', quality)
        if (result.length <= 850_000) return result
      }
    }
    throw new Error('No se pudo reducir la foto a un tamaño compatible. Prueba otra imagen.')
  } finally {
    image.close()
  }
}

function PlayerAvatar({
  name,
  photo,
  className,
  fallback = 'initial',
}: {
  name: string
  photo?: string
  className: string
  fallback?: 'initial' | 'anonymous'
}) {
  return photo
    ? <img className={`${className} avatar-image`} src={photo} alt={`Foto de ${name}`} />
    : fallback === 'anonymous'
      ? (
        <span className={`${className} anonymous-user-icon`} aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="8" r="4" />
            <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
          </svg>
        </span>
      )
      : <span className={className}>{name.slice(0, 1).toUpperCase()}</span>
}

function App() {
  if (!isFirebaseConfigured || !auth || !db) {
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <span className="brand-mark">AC</span>
          <p className="eyebrow">Angeles City · Mejor jugador</p>
          <h1>Conecta Firebase</h1>
          <p>
            Completa las variables <code>VITE_FIREBASE_*</code> en el archivo <code>.env</code>{' '}
            con los datos de configuración de tu aplicación web en Firebase.
          </p>
        </div>
      </div>
    )
  }

  return <ConfiguredApp client={auth} />
}

function ConfiguredApp({ client }: { client: NonNullable<typeof auth> }) {
  const [user, setUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profilePhotos, setProfilePhotos] = useState<Record<string, string>>({})
  const [needsProfileSetup, setNeedsProfileSetup] = useState(false)
  const [needsUsernameSetup, setNeedsUsernameSetup] = useState(false)
  const [players, setPlayers] = useState<Player[]>([])
  const [matches, setMatches] = useState<Match[]>([])
  const [matchPlayers, setMatchPlayers] = useState<MatchPlayer[]>([])
  const [votes, setVotes] = useState<VoteRecord[]>([])
  const [members, setMembers] = useState<Profile[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([])
  const [ranking, setRanking] = useState<RankingRow[]>([])
  const [matchResults, setMatchResults] = useState<Record<string, MatchResult[]>>({})
  const [tab, setTab] = useState<Tab>('vote')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isRegistering, setIsRegistering] = useState(false)
  const [linkPassword, setLinkPassword] = useState('')
  const [accountBusy, setAccountBusy] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [profilePlayerName, setProfilePlayerName] = useState('')
  const [playerName, setPlayerName] = useState('')
  const [playerProfileId, setPlayerProfileId] = useState('')
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null)
  const [matchDate, setMatchDate] = useState(localToday)
  const [opponent, setOpponent] = useState('')
  const [selectedPlayers, setSelectedPlayers] = useState<string[]>([])
  const [votingPlayer, setVotingPlayer] = useState<Record<string, string>>({})

  const isAdmin = profile?.role === 'admin'
  const isAuthorized = Boolean(profile?.is_authorized)
  const isEmailVerified = (currentUser: User) =>
    currentUser.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase() ||
    currentUser.emailVerified ||
    currentUser.providerData.some((provider) => provider.providerId === 'google.com')

  const announce = (text: string, kind: 'success' | 'error' = 'success') => {
    setMessage(text)
    setMessageKind(kind)
  }

  const loadData = useCallback(async (currentUser: User) => {
    if (!isEmailVerified(currentUser)) return
    setLoading(true)
    setMessage('')
    let loadingStage = 'tu perfil'
    try {
      const ownProfile = await loadProfile(currentUser.uid)
      if (!ownProfile) {
        setProfile(null)
        setNeedsProfileSetup(true)
        setNeedsUsernameSetup(false)
        return
      }
      setNeedsProfileSetup(false)
      setProfile(ownProfile)
      setTab(ownProfile.role === 'admin' ? 'history' : 'vote')

      if (!ownProfile.username && ownProfile.role !== 'admin') {
        setNeedsUsernameSetup(true)
        return
      }
      setNeedsUsernameSetup(false)

      if (!ownProfile.is_authorized) {
        setPlayers([])
        setMatches([])
        setMatchPlayers([])
        setVotes([])
        setMembers([])
        setAuditLogs([])
        return
      }

      loadingStage = 'jugadores y partidos'
      const [playerRows, matchRows] = await Promise.all([
        loadPlayers(),
        loadMatches(),
      ])
      loadingStage = 'plantillas y tus votos'
      const [rosterRows, voteRows] = await Promise.all([
        loadRoster(matchRows),
        loadMyVotes(matchRows, currentUser.uid),
      ])
      setPlayers(playerRows)
      setMatches(matchRows)
      setMatchPlayers(rosterRows)
      setVotes(voteRows)
      const photoProfileIds = [
        currentUser.uid,
        ...playerRows.map((player) => player.profile_id ?? ''),
      ]

      if (ownProfile.role === 'admin') {
        loadingStage = 'integrantes y registro de actividad'
        const [memberRows, logs] = await Promise.all([loadProfiles(), loadAuditLogs()])
        setMembers(memberRows)
        setAuditLogs(logs)
        photoProfileIds.push(...memberRows.map((member) => member.id))
      } else {
        setMembers([])
        setAuditLogs([])
      }

      loadingStage = 'fotos de perfil'
      setProfilePhotos(await loadProfilePhotos(photoProfileIds))
    } catch (error) {
      const detail = errorMessage(error)
      announce(
        detail.includes('Missing or insufficient permissions')
          ? `Firestore denegó permisos al cargar ${loadingStage}. Publica las reglas actuales desde firestore.rules y vuelve a iniciar sesión.`
          : detail,
        'error',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(client, (nextUser) => {
      setUser(nextUser)
      setProfile((current) => current?.id === nextUser?.uid ? current : null)
      setProfilePhotos({})
      setNeedsProfileSetup(false)
      setNeedsUsernameSetup(false)
      setUsername('')
      setTab('vote')
      setMessage('')
      setAuthReady(true)
    })
    return unsubscribe
  }, [client])

  useEffect(() => {
    if (user && isEmailVerified(user)) void loadData(user)
    else {
      setProfile(null)
      setLoading(false)
    }
  }, [user, loadData])

  const openMatches = matches.filter((match) => match.status === 'open')
  const closedMatches = matches.filter((match) => match.status === 'closed')
  const draftMatches = matches.filter((match) => match.status === 'draft')
  const currentPlayer = players.find((player) => player.profile_id === user?.uid)
  const photoForPlayer = (playerId: string) => {
    const player = players.find((entry) => entry.id === playerId)
    return player?.profile_id ? profilePhotos[player.profile_id] : undefined
  }

  const refresh = async () => {
    if (user) await loadData(user)
  }

  const finishProfileSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user) return
    const playerName = profilePlayerName.trim()
    const normalizedUsername = normalizeUsername(username)
    if (!profile && !playerName) {
      announce('Escribe tu nombre de jugador.', 'error')
      return
    }
    if (!/^[a-z0-9._-]{3,20}$/.test(normalizedUsername)) {
      announce('El nombre de usuario debe tener entre 3 y 20 caracteres: letras, números, punto, guion o guion bajo.', 'error')
      return
    }
    setLoading(true)
    try {
      if (profile) {
        if (!user.email) throw new Error('La cuenta no tiene un correo asociado para crear el nombre de usuario.')
        await setMemberUsername(user.uid, user.email, normalizedUsername)
        setNeedsUsernameSetup(false)
      } else {
        await createMemberProfile(user, playerName, normalizedUsername)
        setNeedsProfileSetup(false)
      }
      announce(profile
        ? 'Nombre de usuario guardado.'
        : 'Perfil creado. Tu cuenta ya está habilitada para participar.')
      await loadData(user)
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoading(true)
    try {
      if (isRegistering) {
        const result = await createUserWithEmailAndPassword(client, email.trim(), password)
        await sendEmailVerification(result.user)
        announce('Cuenta creada. Confirma tu correo para poder continuar.')
      } else if (email.trim().toLowerCase() === 'admin') {
        await signInWithEmailAndPassword(client, ADMIN_EMAIL, password)
        setPassword('')
      } else {
        const identifier = email.trim()
        const loginEmail = identifier.includes('@')
          ? identifier
          : await resolveUsernameEmail(identifier)
        const result = await signInWithEmailAndPassword(client, loginEmail, password)
        if (!result.user.emailVerified) {
          await sendEmailVerification(result.user)
          announce('Confirma tu correo antes de iniciar sesión. Te enviamos un enlace de verificación.', 'error')
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'auth/account-exists-with-different-credential'
      ) {
        announce('Ese correo ya tiene otro método de acceso. Inicia sesión con él y vincula Google desde “Tu cuenta”.', 'error')
      } else {
        announce(errorMessage(error), 'error')
      }
    } finally {
      setLoading(false)
    }
  }

  const signInWithGoogle = async () => {
    setLoading(true)
    try {
      const result = await signInWithPopup(client, new GoogleAuthProvider())
      if (!isEmailVerified(result.user)) {
        await firebaseSignOut(client)
        throw new Error('Google no confirmó la dirección de correo de esta cuenta.')
      }
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  const connectGoogle = async () => {
    if (!user || user.providerData.some((provider) => provider.providerId === 'google.com')) return
    setAccountBusy(true)
    try {
      const result = await linkWithPopup(user, new GoogleAuthProvider())
      if (result.user.email?.toLowerCase() !== user.email?.toLowerCase()) {
        await unlink(result.user, 'google.com')
        throw new Error('La cuenta de Google debe usar el mismo correo de esta cuenta.')
      }
      announce('Google quedó vinculado. Ya puedes iniciar sesión con Google o con contraseña.')
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setAccountBusy(false)
    }
  }

  const connectPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!user?.email) {
      announce('Esta cuenta necesita un correo antes de vincular una contraseña.', 'error')
      return
    }
    setAccountBusy(true)
    try {
      const credential = EmailAuthProvider.credential(user.email, linkPassword)
      const result = await linkWithCredential(user, credential)
      if (!result.user.emailVerified) await sendEmailVerification(result.user)
      setLinkPassword('')
      announce('Contraseña vinculada. Usa el mismo correo de esta cuenta para ingresar.')
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setAccountBusy(false)
    }
  }

  const signOut = async () => {
    try {
      await firebaseSignOut(client)
    } catch (error) {
      announce(errorMessage(error), 'error')
    }
  }

  const submitVote = async (matchId: string) => {
    const playerId = votingPlayer[matchId]
    if (!playerId) {
      announce('Elige un jugador antes de confirmar tu voto.', 'error')
      return
    }
    if (!user) return
    setLoading(true)
    try {
      await castVote(matchId, playerId, user.uid)
      setVotes((current) => [...current, { match_id: matchId, player_id: playerId }])
      announce('Tu voto quedó registrado. No se puede cambiar.')
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  const loadRanking = async () => {
    try {
      setRanking(await fetchRanking(players, matches))
    } catch (error) {
      announce(errorMessage(error), 'error')
    }
  }

  const showResults = async (matchId: string) => {
    try {
      const results = await loadMatchResults(matchId, players)
      setMatchResults((current) => ({ ...current, [matchId]: results }))
    } catch (error) {
      announce(errorMessage(error), 'error')
    }
  }

  const savePlayer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = playerName.trim()
    if (!name) return
    if (!user) return
    setLoading(true)
    try {
      await savePlayerRecord(user.uid, editingPlayerId, name, playerProfileId || null)
      setPlayerName('')
      setPlayerProfileId('')
      setEditingPlayerId(null)
      announce(editingPlayerId ? 'Jugador actualizado.' : 'Jugador agregado.')
      await refresh()
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  const editPlayer = (player: Player) => {
    setEditingPlayerId(player.id)
    setPlayerName(player.name)
    setPlayerProfileId(player.profile_id ?? '')
  }

  const togglePlayer = async (player: Player) => {
    if (!user) return
    try {
      await togglePlayerRecord(player, user.uid)
      announce(player.active ? 'Jugador desactivado; su historial se conserva.' : 'Jugador activado.')
      await refresh()
    } catch (error) {
      announce(errorMessage(error), 'error')
    }
  }

  const updateMember = async (member: Profile, changes: Partial<Profile>) => {
    if (!user) return
    try {
      await updateMemberRecord(member.id, user.uid, changes)
      announce('Permisos del integrante actualizados.')
      await refresh()
    } catch (error) {
      announce(errorMessage(error), 'error')
    }
  }

  const approveMember = async (member: Profile) => {
    if (!user) return
    try {
      await approveMemberRecord(member, user.uid)
      announce(`${member.requested_player_name} ya tiene acceso y está disponible para partidos.`)
      await refresh()
    } catch (error) {
      announce(errorMessage(error), 'error')
    }
  }

  const createMatch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (selectedPlayers.length < 2) {
      announce('Selecciona al menos dos jugadores habilitados.', 'error')
      return
    }
    if (!user) return
    setLoading(true)
    try {
      await createMatchRecord(user.uid, matchDate, opponent.trim() || null, selectedPlayers)
      setOpponent('')
      setSelectedPlayers([])
      announce('Partido creado. Abre la votación cuando el equipo esté listo.')
      await refresh()
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setLoading(false)
    }
  }

  const changeMatchStatus = async (match: Match, status: 'open' | 'closed') => {
    if (!user) return
    try {
      await updateMatchStatus(match.id, status, user.uid)
      announce(status === 'open' ? 'Votación abierta.' : 'Votación cerrada; resultados publicados.')
      await refresh()
    } catch (error) {
      announce(errorMessage(error), 'error')
    }
  }

  const uploadProfilePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || !user) return
    setPhotoBusy(true)
    try {
      const photoData = await prepareProfilePhoto(file)
      await saveProfilePhoto(user.uid, photoData)
      setProfilePhotos((current) => ({ ...current, [user.uid]: photoData }))
      announce('Foto de perfil actualizada.')
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setPhotoBusy(false)
    }
  }

  const removeProfilePhoto = async () => {
    if (!user) return
    setPhotoBusy(true)
    try {
      await deleteProfilePhoto(user.uid)
      setProfilePhotos((current) => {
        const next = { ...current }
        delete next[user.uid]
        return next
      })
      announce('Foto de perfil eliminada.')
    } catch (error) {
      announce(errorMessage(error), 'error')
    } finally {
      setPhotoBusy(false)
    }
  }

  const toggleSelectedPlayer = (playerId: string) => {
    setSelectedPlayers((current) =>
      current.includes(playerId)
        ? current.filter((id) => id !== playerId)
        : [...current, playerId],
    )
  }

  if (!authReady) {
    return <div className="loading-screen"><span className="spinner" />Cargando...</div>
  }

  if (user && isEmailVerified(user) && !needsProfileSetup && profile?.id !== user.uid) {
    return (
      <div className="loading-screen">
        {loading ? <span className="spinner" /> : <p>{message || 'No se pudo cargar tu perfil.'}</p>}
        {!loading && <button className="button button-secondary" onClick={() => void refresh()}>Reintentar</button>}
      </div>
    )
  }

  if (!user) {
    return (
      <div className="login-screen">
        <div className="login-form-wrap">
          <div className="login-form">
            <div className="login-brand">
              <span className="brand-mark">AC</span>
              <p className="eyebrow">Angeles City</p>
            </div>
            <h2>{isRegistering ? 'Crear cuenta' : 'Iniciar sesión'}</h2>
            <button
              type="button"
              className="button button-secondary button-wide google-button"
              disabled={loading}
              onClick={() => void signInWithGoogle()}
            >
              <svg className="google-mark" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.91 3.28-4.73 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.99 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.15v2.84A11 11 0 0012 23z" />
                <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 010-4.2V7.06H2.15a11 11 0 000 9.88l3.69-2.84z" />
                <path fill="#EA4335" d="M12 4.36c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 1.09 14.97 0 12 0A11 11 0 002.15 7.06L5.84 9.9C6.71 7.3 9.14 5.36 12 5.36z" />
              </svg>
              <span className="google-button-label">Continuar con Google</span>
            </button>
            <div className="form-divider"><span>o con correo y contraseña</span></div>
            <form onSubmit={signIn} className="stack-form">
              <label>
                {isRegistering ? 'Correo electrónico' : 'Correo o nombre de usuario'}
                <input
                  type={isRegistering ? 'email' : 'text'}
                  autoComplete={isRegistering ? 'email' : 'username'}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label>
                Contraseña
                <input
                  type="password"
                  autoComplete={isRegistering ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={isRegistering ? 8 : undefined}
                  required
                />
              </label>
              <button className="button button-primary button-wide" disabled={loading}>
                {loading
                  ? 'Un momento...'
                  : isRegistering
                    ? 'Crear cuenta'
                    : 'Iniciar sesión'} <span aria-hidden="true">→</span>
              </button>
            </form>
            {!isRegistering && (
              <button
                type="button"
                className="forgot-password"
                onClick={async () => {
                  if (!email.trim()) {
                    announce('Escribe tu correo o nombre de usuario para enviarte el enlace de recuperación.', 'error')
                    return
                  }
                  if (email.trim().toLowerCase() === 'admin') {
                    announce('El administrador debe restablecer su contraseña desde Firebase Console.', 'error')
                    return
                  }
                  try {
                    const identifier = email.trim()
                    const resetEmail = identifier.includes('@')
                      ? identifier
                      : await resolveUsernameEmail(identifier)
                    await sendPasswordResetEmail(client, resetEmail)
                    announce('Te enviamos un enlace para restablecer la contraseña.')
                  } catch (error) {
                    announce(errorMessage(error), 'error')
                  }
                }}
              >
                ¿Olvidaste tu contraseña?
              </button>
            )}
            <p className="login-footnote">
              {isRegistering ? '¿Ya tienes cuenta?' : '¿Aún no tienes cuenta?'}{' '}
              <button type="button" onClick={() => { setIsRegistering((current) => !current); setPassword('') }}>
                {isRegistering ? 'Inicia sesión' : 'Regístrate'}
              </button>
              <br />Verifica tu correo y completa el perfil para comenzar a participar.
            </p>
            {message && <div className={`notice ${messageKind}`} role="status">{message}</div>}
          </div>
        </div>
      </div>
    )
  }

  if (needsProfileSetup || needsUsernameSetup) {
    return (
      <div className="setup-screen">
        <div className="setup-card profile-setup-card">
          <span className="brand-mark">AC</span>
          <p className="eyebrow">PERFIL DEL EQUIPO</p>
          <h1>{needsProfileSetup ? 'Completa tu perfil' : 'Elige un nombre de usuario'}</h1>
          <p>{needsProfileSetup
            ? 'Elige un nombre de usuario para iniciar sesión y escribe tu nombre de jugador.'
            : 'Elige un nombre de usuario para iniciar sesión además de tu correo.'}</p>
          <form className="stack-form" onSubmit={(event) => void finishProfileSetup(event)}>
            {needsProfileSetup && (
              <label>
                Nombre de jugador
                <input
                  autoComplete="name"
                  value={profilePlayerName}
                  onChange={(event) => setProfilePlayerName(event.target.value)}
                  maxLength={60}
                  required
                />
              </label>
            )}
            <label>
              Nombre de usuario
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                minLength={3}
                maxLength={20}
                pattern="[A-Za-z0-9._-]{3,20}"
                required
              />
            </label>
            <button className="button button-primary button-wide" disabled={loading}>
              {loading ? 'Guardando...' : needsProfileSetup ? 'Guardar mi perfil →' : 'Guardar usuario →'}
            </button>
          </form>
          {needsProfileSetup && <p className="login-footnote">Al completar el perfil podrás participar. No podrás votarte a ti mismo.</p>}
          {message && <div className={`notice ${messageKind}`} role="status">{message}</div>}
          <button className="text-button" onClick={() => void firebaseSignOut(client)}>Cerrar sesión</button>
        </div>
      </div>
    )
  }

  if (!isEmailVerified(user)) {
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <span className="brand-mark">AC</span>
          <p className="eyebrow">VERIFICACIÓN DE CORREO</p>
          <h1>Revisa tu bandeja de entrada</h1>
          <p>Enviamos un enlace a <strong>{user.email}</strong>. Confirma el correo y vuelve para habilitar tu perfil.</p>
          <div className="verification-actions">
            <button
              className="button button-primary"
              onClick={async () => {
                try {
                  await reload(user)
                  const refreshedUser = client.currentUser
                  if (refreshedUser) {
                    await refreshedUser.getIdToken(true)
                    setUser(refreshedUser)
                  }
                  if (refreshedUser && !isEmailVerified(refreshedUser)) {
                    announce('Todavía no aparece la verificación. Abre el enlace del correo y vuelve a intentar.', 'error')
                  }
                } catch (error) {
                  announce(errorMessage(error), 'error')
                }
              }}
            >
              Ya verifiqué mi correo
            </button>
            <button
              className="button button-secondary"
              onClick={async () => {
                try {
                  await sendEmailVerification(user)
                  announce('Te enviamos otro correo de verificación.')
                } catch (error) {
                  announce(errorMessage(error), 'error')
                }
              }}
            >
              Reenviar correo
            </button>
            <button className="text-button" onClick={() => void firebaseSignOut(client)}>Cerrar sesión</button>
          </div>
          {message && <p className={`notice ${messageKind}`} role="status">{message}</p>}
        </div>
      </div>
    )
  }

  if (!isAuthorized && profile) {
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <span className="brand-mark">AC</span>
          <p className="eyebrow">Angeles City</p>
          <h1>Tu cuenta está desactivada</h1>
          <p>El administrador desactivó tu acceso. Contacta con él para que lo vuelva a habilitar.</p>
          <div className="pending-account-methods">
            <span className="pending-email">
              {user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()
                ? 'Acceso de administrador'
                : user.email}
            </span>
            <p className="helper-text">Puedes vincular ambos métodos al mismo correo.</p>
            {!user.providerData.some((provider) => provider.providerId === 'google.com') && (
              <button
                className="button button-secondary button-wide"
                disabled={accountBusy}
                onClick={() => void connectGoogle()}
              >
                Vincular Google
              </button>
            )}
            {!user.providerData.some((provider) => provider.providerId === 'password') && (
              <form className="stack-form pending-password-form" onSubmit={(event) => void connectPassword(event)}>
                <label>
                  Contraseña para este correo
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    required
                    value={linkPassword}
                    onChange={(event) => setLinkPassword(event.target.value)}
                  />
                </label>
                <button className="button button-secondary button-wide" disabled={accountBusy}>
                  Vincular contraseña
                </button>
              </form>
            )}
          </div>
          <button className="button button-secondary" onClick={signOut}>Cerrar sesión</button>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark">AC</span>
          <span>ANGELES <b>CITY</b><small>VOTACIÓN DEL EQUIPO</small></span>
        </a>
        <div className="account">
          <span className="online-dot" />
          <button
            className="account-profile-button"
            title="Mi perfil"
            aria-label="Abrir Mi perfil"
            onClick={() => setTab('profile')}
          >
            <PlayerAvatar
              name={profile?.display_name ?? 'Usuario'}
              photo={user ? profilePhotos[user.uid] : undefined}
              className="account-avatar"
              fallback="anonymous"
            />
            <span className="account-name">{profile?.display_name}</span>
          </button>
          {isAdmin && <span className="role-pill">Admin</span>}
          <button className="text-button" onClick={signOut}>Salir</button>
        </div>
      </header>

      <main className="main-content">
        <section className="welcome-row">
          <div>
            <p className="eyebrow">TEMPORADA · ANGELES CITY</p>
            <h1>Hola, {profile?.display_name?.split(' ')[0]} <span className="wave">✦</span></h1>
            <p className="muted">El equipo decide quién fue el jugador del partido.</p>
          </div>
          <div className="quick-stats">
            <div><strong>{closedMatches.length}</strong><span>PARTIDOS</span></div>
            <div><strong>{players.filter((player) => player.active).length}</strong><span>JUGADORES</span></div>
          </div>
        </section>

        <nav className="tabs" aria-label="Secciones">
          {!isAdmin && (
            <button className={tab === 'vote' ? 'tab active' : 'tab'} onClick={() => setTab('vote')}>
              <span>01</span> Votación {openMatches.length > 0 && <i className="tab-indicator" />}
            </button>
          )}
          <button
            className={tab === 'history' ? 'tab active' : 'tab'}
            onClick={() => {
              setTab('history')
              void loadRanking()
            }}
          >
            <span>{isAdmin ? '01' : '02'}</span> Historial y ranking
          </button>
          {isAdmin && (
            <button className={tab === 'admin' ? 'tab active' : 'tab'} onClick={() => setTab('admin')}>
              <span>02</span> Administración
            </button>
          )}
        </nav>

        {message && (
          <div className={`notice ${messageKind}`} role="status">
            <span>{messageKind === 'success' ? '✓' : '!'}</span> {message}
            <button aria-label="Cerrar aviso" onClick={() => setMessage('')}>×</button>
          </div>
        )}

        {loading && <div className="refresh-line"><span className="spinner small" /> Actualizando datos...</div>}

        {tab === 'profile' && (
          <section className="content-section profile-section">
            <div className="section-heading">
              <div><p className="eyebrow">TU CUENTA</p><h2>Mi perfil</h2></div>
            </div>
            <div className="profile-layout">
              <div className="panel profile-photo-panel">
                <PlayerAvatar
                  name={currentPlayer?.name ?? profile?.display_name ?? 'Jugador'}
                  photo={user ? profilePhotos[user.uid] : undefined}
                  className="profile-avatar"
                  fallback="anonymous"
                />
                <h3>{currentPlayer?.name ?? profile?.display_name}</h3>
                <p>@{profile?.username ?? 'admin'}</p>
                <label className="button button-primary profile-upload-button">
                  <input
                    className="profile-photo-input"
                    type="file"
                    accept="image/*"
                    aria-label="Seleccionar foto de perfil"
                    disabled={photoBusy}
                    onChange={(event) => void uploadProfilePhoto(event)}
                  />
                  {photoBusy ? 'Guardando foto...' : 'Cambiar foto'}
                </label>
                {user && profilePhotos[user.uid] && (
                  <button
                    className="button button-secondary"
                    disabled={photoBusy}
                    onClick={() => void removeProfilePhoto()}
                  >
                    Quitar foto
                  </button>
                )}
                <p className="helper-text">La foto se ajusta automáticamente. Máximo 10 MB antes de procesarla.</p>
              </div>
              <div className="panel profile-info-panel">
                <div className="panel-heading">
                  <div><p className="eyebrow">INFORMACIÓN PERSONAL</p><h3>Datos de la cuenta</h3></div>
                </div>
                <dl className="profile-details">
                  <div><dt>Nombre del jugador</dt><dd>{currentPlayer?.name ?? 'Sin jugador vinculado'}</dd></div>
                  <div><dt>Nombre de usuario</dt><dd>@{profile?.username ?? 'admin'}</dd></div>
                  <div><dt>Correo de acceso</dt><dd>{user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'Acceso de administrador' : user.email}</dd></div>
                  <div><dt>Cuenta creada</dt><dd>{profile?.created_at ? formatDateTime(profile.created_at) : '—'}</dd></div>
                  <div>
                    <dt>Métodos de acceso</dt>
                    <dd className="profile-methods">
                      {user.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()
                        ? <span>Cuenta administrativa</span>
                        : <>
                            {user.providerData.some((provider) => provider.providerId === 'google.com')
                              ? <span className="linked-method"><span className="google-mark">G</span> Google vinculado</span>
                              : <button className="button button-secondary" disabled={accountBusy} onClick={() => void connectGoogle()}>Vincular Google</button>}
                            {user.providerData.some((provider) => provider.providerId === 'password')
                              ? <span className="linked-method">✓ Contraseña vinculada</span>
                              : <form className="link-password-form" onSubmit={(event) => void connectPassword(event)}>
                                  <input
                                    type="password"
                                    autoComplete="new-password"
                                    aria-label="Contraseña para vincular"
                                    minLength={8}
                                    required
                                    value={linkPassword}
                                    onChange={(event) => setLinkPassword(event.target.value)}
                                  />
                                  <button className="button button-secondary" disabled={accountBusy}>Vincular contraseña</button>
                                </form>}
                          </>}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>
        )}

        {tab === 'vote' && !isAdmin && (
          <section className="content-section">
            <div className="section-heading">
              <div><p className="eyebrow">TU OPINIÓN CUENTA</p><h2>Votaciones abiertas</h2></div>
              <span className="count-pill">{openMatches.length} ABIERTA{openMatches.length === 1 ? '' : 'S'}</span>
            </div>
            {openMatches.length === 0 ? (
              <div className="empty-card">
                <span className="empty-icon">◎</span>
                <h3>No hay votaciones abiertas</h3>
                <p>Cuando el moderador habilite una votación, aparecerá aquí.</p>
              </div>
            ) : (
              <div className="match-grid">
                {openMatches.map((match, index) => {
                  const submittedVote = votes.find((vote) => vote.match_id === match.id)
                  const alreadyVoted = Boolean(submittedVote)
                  const votedPlayerName = players.find((player) => player.id === submittedVote?.player_id)?.name
                  const eligibleIds = matchPlayers
                    .filter((entry) => entry.match_id === match.id)
                    .map((entry) => entry.player_id)
                  const eligiblePlayers = players.filter(
                    (player) => player.active && eligibleIds.includes(player.id),
                  )
                  return (
                    <article className="vote-card" key={match.id}>
                      <div className="card-topline">
                        <span className="live-tag"><i /> VOTACIÓN EN CURSO</span>
                        <span className="match-number">PARTIDO {String(index + 1).padStart(2, '0')}</span>
                      </div>
                      <div className="match-title">
                        <span className="match-ball">⚽</span>
                        <div><h3>Angeles City <span>vs.</span> {match.opponent || 'Partido'}</h3>
                          <p>{formatDate(match.played_at)}</p></div>
                      </div>
                      {alreadyVoted ? (
                        <div className="vote-confirmed">
                          <span>✓</span><div><strong>Voto registrado</strong><small>Tu voto por {votedPlayerName ?? 'el jugador seleccionado'} quedó confirmado y es definitivo.</small></div>
                        </div>
                      ) : (
                        <div className="vote-form">
                          <label htmlFor={`vote-${match.id}`}>¿Quién fue el mejor jugador?</label>
                          <div className="vote-controls">
                            <select
                              id={`vote-${match.id}`}
                              value={votingPlayer[match.id] ?? ''}
                              onChange={(event) =>
                                setVotingPlayer((current) => ({ ...current, [match.id]: event.target.value }))
                              }
                            >
                              <option value="">Selecciona un jugador</option>
                              {eligiblePlayers.map((player) => (
                                <option
                                  key={player.id}
                                  value={player.id}
                                  disabled={player.profile_id === profile?.id}
                                >
                                  {player.name}{player.profile_id === profile?.id ? ' (tú)' : ''}
                                </option>
                              ))}
                            </select>
                            <button
                              className="button button-primary"
                              disabled={loading || !votingPlayer[match.id]}
                              onClick={() => void submitVote(match.id)}
                            >
                              Votar <span aria-hidden="true">→</span>
                            </button>
                          </div>
                          <p className="helper-text">Tu voto es privado y no se puede cambiar.</p>
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        )}

        {tab === 'history' && (
          <section className="content-section">
            <div className="section-heading">
              <div><p className="eyebrow">EL RECONOCIMIENTO DEL EQUIPO</p><h2>Historial y ranking</h2></div>
              <button className="button button-secondary" onClick={() => void loadRanking()}>Actualizar ranking ↻</button>
            </div>
            <div className="history-layout">
              <div className="panel ranking-panel">
                <div className="panel-heading"><div><p className="eyebrow">ACUMULADO</p><h3>Tabla de honor</h3></div><span className="trophy">★</span></div>
                {ranking.length === 0 ? (
                  <p className="empty-inline">El ranking se actualizará con los votos de partidos cerrados.</p>
                ) : (
                  <div className="ranking-list">
                    {ranking.map((row, index) => (
                      <div className={`ranking-row ${index === 0 && row.total_votes > 0 ? 'leader' : ''}`} key={row.player_id}>
                        <span className="rank-number">{String(index + 1).padStart(2, '0')}</span>
                        <PlayerAvatar name={row.player_name} photo={photoForPlayer(row.player_id)} className="rank-avatar" />
                        <span className="rank-name">{row.player_name}<small>{row.matches_played} {row.matches_played === 1 ? 'partido' : 'partidos'}</small></span>
                        <strong className="rank-votes">{row.total_votes}<small> VOTOS</small></strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="panel mvp-panel">
                <div className="panel-heading"><div><p className="eyebrow">POR PARTIDO</p><h3>Jugador más valioso (MVP)</h3></div><span className="trophy">🏅</span></div>
                {ranking.every((row) => row.mvp_count === 0) ? (
                  <p className="empty-inline">El conteo de MVP aparecerá cuando haya partidos cerrados con votos.</p>
                ) : (
                  <div className="ranking-list">
                    {[...ranking]
                      .sort((a, b) => b.mvp_count - a.mvp_count || b.total_votes - a.total_votes || a.player_name.localeCompare(b.player_name))
                      .map((row, index) => (
                        <div className={`ranking-row ${index === 0 && row.mvp_count > 0 ? 'leader' : ''}`} key={row.player_id}>
                          <span className="rank-number">{String(index + 1).padStart(2, '0')}</span>
                          <PlayerAvatar name={row.player_name} photo={photoForPlayer(row.player_id)} className="rank-avatar" />
                          <span className="rank-name">{row.player_name}<small>{row.total_votes} {row.total_votes === 1 ? 'voto acumulado' : 'votos acumulados'}</small></span>
                          <strong className="rank-votes">{row.mvp_count}<small> MVP</small></strong>
                        </div>
                      ))}
                  </div>
                )}
              </div>
              <div className="panel results-panel">
                <div className="panel-heading"><div><p className="eyebrow">RESULTADOS PUBLICADOS</p><h3>Partidos recientes</h3></div></div>
                {closedMatches.length === 0 ? (
                  <p className="empty-inline">Los resultados aparecerán aquí al cerrar una votación.</p>
                ) : (
                  <div className="closed-match-list">
                    {closedMatches.map((match) => (
                      <div className="closed-match" key={match.id}>
                        <button className="closed-match-button" onClick={() => void showResults(match.id)}>
                          <span className="match-date-block">{formatDate(match.played_at)}</span>
                          <span className="closed-match-info"><strong>Angeles City vs. {match.opponent || 'Partido'}</strong><small>Votación cerrada · Ver resultados</small></span>
                          <span className="chevron">›</span>
                        </button>
                        {matchResults[match.id] && (
                          <div className="match-result-list">
                            {matchResults[match.id].map((result, index) => (
                              <div className="result-row" key={result.player_id}>
                                <span>{index === 0 && result.vote_count > 0 ? '★' : `${index + 1}.`}</span>
                                <PlayerAvatar name={result.player_name} photo={photoForPlayer(result.player_id)} className="result-avatar" />
                                <strong>{result.player_name}</strong>
                                <span>{result.vote_count} {result.vote_count === 1 ? 'voto' : 'votos'}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {tab === 'admin' && isAdmin && (
          <section className="content-section admin-section">
            <div className="section-heading">
              <div><p className="eyebrow">PANEL DE CONTROL</p><h2>Administración</h2></div>
              <span className="admin-note">Solo visible para administradores</span>
            </div>
            <div className="admin-grid">
              <div className="panel">
                <div className="panel-heading"><div><p className="eyebrow">PLANTILLA</p><h3>Jugadores</h3></div><span className="panel-count">{players.length}</span></div>
                <form className="admin-form" onSubmit={(event) => void savePlayer(event)}>
                  <label>Nombre del jugador<input value={playerName} onChange={(event) => setPlayerName(event.target.value)} required /></label>
                  <label>Cuenta del integrante
                    <select value={playerProfileId} onChange={(event) => setPlayerProfileId(event.target.value)}>
                      <option value="">Sin vincular</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.display_name}{member.is_authorized ? '' : ' · desactivado'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="form-actions">
                    <button className="button button-primary" disabled={loading}>{editingPlayerId ? 'Guardar cambios' : 'Agregar jugador'}</button>
                    {editingPlayerId && <button type="button" className="text-button" onClick={() => { setEditingPlayerId(null); setPlayerName(''); setPlayerProfileId('') }}>Cancelar</button>}
                  </div>
                </form>
                <div className="admin-list">
                  {players.map((player) => (
                    <div className="admin-list-row" key={player.id}>
                      <span className={`status-dot ${player.active ? 'active' : ''}`} />
                      <PlayerAvatar name={player.name} photo={player.profile_id ? profilePhotos[player.profile_id] : undefined} className="member-avatar" />
                      <span className="admin-list-main"><strong>{player.name}</strong><small>{members.find((member) => member.id === player.profile_id)?.display_name ?? 'Sin cuenta vinculada'}</small></span>
                      <button className="mini-button" onClick={() => editPlayer(player)}>Editar</button>
                      <button className="mini-button" onClick={() => void togglePlayer(player)}>{player.active ? 'Desactivar' : 'Activar'}</button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel">
                <div className="panel-heading"><div><p className="eyebrow">ACCESO AL EQUIPO</p><h3>Integrantes</h3></div><span className="panel-count">{members.length}</span></div>
                <p className="panel-description">Las cuentas verificadas quedan habilitadas al completar el registro. Desde aquí puedes desactivar o reactivar su acceso.</p>
                <div className="admin-list">
                  {members.map((member) => (
                    <div className="member-row" key={member.id}>
                      <PlayerAvatar name={member.display_name} photo={profilePhotos[member.id]} className="member-avatar" />
                      <span className="admin-list-main"><strong>{member.display_name}{member.id === profile?.id ? ' (tú)' : ''}</strong><small>{member.role === 'admin' ? 'Administrador' : 'Integrante'} · @{member.username ?? 'sin usuario'}</small></span>
                      <label className="switch-label" title={member.is_authorized ? 'Desactivar cuenta' : 'Reactivar cuenta'}>
                        <input
                          type="checkbox"
                          checked={member.is_authorized}
                          disabled={member.id === profile?.id}
                          onChange={(event) => {
                            if (event.target.checked && member.requested_player_name) {
                              void approveMember(member)
                            } else {
                              void updateMember(member, { is_authorized: event.target.checked })
                            }
                          }}
                        />
                        <span className="switch" />
                      </label>
                      <select
                        className="role-select"
                        aria-label={`Rol de ${member.display_name}`}
                        value={member.role}
                        disabled={member.id === profile?.id}
                        onChange={(event) => void updateMember(member, { role: event.target.value as Profile['role'] })}
                      >
                        <option value="member">Miembro</option>
                        <option value="admin">Admin</option>
                      </select>
                      {!member.is_authorized && member.requested_player_name && (
                        <button
                          className="mini-button action"
                          title={`Activar a ${member.requested_player_name}`}
                          onClick={() => void approveMember(member)}
                        >
                          Activar integrante
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="helper-text">El interruptor junto al nombre habilita o bloquea el acceso.</p>
              </div>

              <div className="panel">
                <div className="panel-heading"><div><p className="eyebrow">NUEVA JORNADA</p><h3>Crear partido</h3></div><span className="panel-icon">＋</span></div>
                <form className="admin-form" onSubmit={(event) => void createMatch(event)}>
                  <div className="form-two">
                    <label>Fecha<input type="date" value={matchDate} onChange={(event) => setMatchDate(event.target.value)} required /></label>
                    <label>Rival (opcional)<input value={opponent} onChange={(event) => setOpponent(event.target.value)} /></label>
                  </div>
                  <fieldset className="player-picker">
                    <legend>Jugadores que asistieron (elegibles para recibir votos)</legend>
                    {players.filter((player) =>
                      player.active &&
                      player.profile_id &&
                      members.some((member) => member.id === player.profile_id && member.is_authorized),
                    ).length === 0 ? (
                      <p className="empty-inline">Autoriza integrantes antes de seleccionar jugadores para el partido.</p>
                    ) : (
                      players.filter((player) =>
                        player.active &&
                        player.profile_id &&
                        members.some((member) => member.id === player.profile_id && member.is_authorized),
                      ).map((player) => (
                        <label className="check-option" key={player.id}>
                          <input type="checkbox" checked={selectedPlayers.includes(player.id)} onChange={() => toggleSelectedPlayer(player.id)} />
                          <span>{player.name}</span>
                        </label>
                      ))
                    )}
                  </fieldset>
                  <button className="button button-primary" disabled={loading}>Crear partido como borrador <span aria-hidden="true">→</span></button>
                </form>
              </div>

              <div className="panel">
                <div className="panel-heading"><div><p className="eyebrow">MODERACIÓN</p><h3>Gestionar votaciones</h3></div></div>
                {matches.length === 0 ? <p className="empty-inline">Todavía no hay partidos creados.</p> : (
                  <div className="admin-list">
                    {[...draftMatches, ...openMatches].map((match) => (
                      <div className="admin-match-row" key={match.id}>
                        <span className={`match-status ${match.status}`}>{match.status === 'open' ? 'Abierta' : 'Borrador'}</span>
                        <span className="admin-list-main"><strong>vs. {match.opponent || 'Partido'}</strong><small>{formatDate(match.played_at)}</small></span>
                        {match.status === 'draft' ? (
                          <button className="mini-button action" onClick={() => void changeMatchStatus(match, 'open')}>Abrir votación</button>
                        ) : (
                          <button className="mini-button action close-action" onClick={() => void changeMatchStatus(match, 'closed')}>Cerrar y publicar</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="helper-text">Al cerrar, los resultados se publican para todo el equipo.</p>
              </div>

              <div className="panel audit-panel">
                <div className="panel-heading"><div><p className="eyebrow">TRAZABILIDAD</p><h3>Actividad reciente</h3></div><span className="panel-count">{auditLogs.length}</span></div>
                {auditLogs.length === 0 ? <p className="empty-inline">Todavía no hay acciones registradas.</p> : (
                  <div className="audit-list">
                    {auditLogs.map((log) => (
                      <div className="audit-row" key={log.id}>
                        <span className="audit-action">{log.action.replaceAll('.', ' ')}</span>
                        <span className="audit-main">{members.find((member) => member.id === log.actor_id)?.display_name ?? 'Sistema'}<small>{log.entity_type}{typeof log.details.name === 'string' ? ` · ${log.details.name}` : ''}</small></span>
                        <time>{formatDateTime(log.created_at)}</time>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        <footer className="footer"><span>ANGELES CITY</span><span>La elección del equipo, partido a partido.</span><button onClick={() => void refresh()}>Sincronizar ↻</button></footer>
      </main>
    </div>
  )
}

export default App
