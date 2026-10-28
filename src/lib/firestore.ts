import type { User } from 'firebase/auth'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore'
import { db } from './firebase'

export type Profile = {
  id: string
  display_name: string
  username: string | null
  role: 'member' | 'admin'
  is_authorized: boolean
  created_at: string
  requested_player_name: string | null
}

export type Player = {
  id: string
  name: string
  profile_id: string | null
  active: boolean
}

export type Match = {
  id: string
  played_at: string
  opponent: string | null
  status: 'draft' | 'open' | 'closed'
}

export type MatchPlayer = {
  match_id: string
  player_id: string
}

export type VoteRecord = {
  match_id: string
  player_id: string
}

export type RankingRow = {
  player_id: string
  player_name: string
  total_votes: number
  matches_played: number
  mvp_count: number
}

export type MatchResult = {
  player_id: string
  player_name: string
  vote_count: number
}

export type AuditLog = {
  id: string
  actor_id: string
  action: string
  entity_type: string
  entity_id: string
  details: Record<string, unknown>
  created_at: string
}

const firestore = () => {
  if (!db) throw new Error('Firebase no está configurado. Revisa las variables del archivo .env.')
  return db
}

const profileRef = (uid: string) => doc(firestore(), 'profiles', uid)
const usernameIndexRef = (username: string) => doc(firestore(), 'profiles', `username_${username}`)
const legacyUsernameRef = (username: string) => doc(firestore(), 'usernames', username)
const matchRef = (matchId: string) => doc(firestore(), 'matches', matchId)
const rosterRef = (matchId: string, playerId: string) =>
  doc(firestore(), 'matches', matchId, 'players', playerId)
const voteRef = (matchId: string, voterId: string) =>
  doc(firestore(), 'matches', matchId, 'votes', voterId)
const profilePhotoRef = (uid: string) => doc(firestore(), 'profile_photos', uid)

const maxProfilePhotoLength = 850_000

const toProfile = (id: string, data: DocumentData): Profile => ({
  id,
  display_name: String(data.display_name ?? 'Integrante'),
  username: typeof data.username === 'string' ? data.username : null,
  role: data.role === 'admin' ? 'admin' : 'member',
  is_authorized: data.is_authorized === true,
  created_at: String(data.created_at ?? ''),
  requested_player_name:
    typeof data.requested_player_name === 'string' ? data.requested_player_name : null,
})

const toPlayer = (id: string, data: DocumentData): Player => ({
  id,
  name: String(data.name ?? ''),
  profile_id: typeof data.profile_id === 'string' ? data.profile_id : null,
  active: data.active === true,
})

const toMatch = (id: string, data: DocumentData): Match => ({
  id,
  played_at: String(data.played_at ?? ''),
  opponent: typeof data.opponent === 'string' ? data.opponent : null,
  status: data.status === 'open' || data.status === 'closed' ? data.status : 'draft',
})

const toAuditLog = (id: string, data: DocumentData): AuditLog => ({
  id,
  actor_id: String(data.actor_id ?? ''),
  action: String(data.action ?? ''),
  entity_type: String(data.entity_type ?? ''),
  entity_id: String(data.entity_id ?? ''),
  details: (data.details as Record<string, unknown> | undefined) ?? {},
  created_at: String(data.created_at ?? ''),
})

const makeAuditLog = (
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {},
) => ({
  actor_id: actorId,
  action,
  entity_type: entityType,
  entity_id: entityId,
  details,
  created_at: new Date().toISOString(),
  created_at_server: serverTimestamp(),
})

export async function loadProfile(uid: string): Promise<Profile | null> {
  const snapshot = await getDoc(profileRef(uid))
  return snapshot.exists() ? toProfile(snapshot.id, snapshot.data()) : null
}

export async function loadProfilePhotos(profileIds: string[]): Promise<Record<string, string>> {
  const uniqueIds = [...new Set(profileIds.filter(Boolean))]
  const snapshots = await Promise.all(uniqueIds.map((uid) => getDoc(profilePhotoRef(uid))))
  return Object.fromEntries(
    snapshots.flatMap((snapshot) => {
      const photoData = snapshot.data()?.photo_data
      return snapshot.exists() && typeof photoData === 'string'
        ? [[snapshot.id, photoData]]
        : []
    }),
  )
}

export async function saveProfilePhoto(uid: string, photoData: string) {
  if (
    !photoData.startsWith('data:image/jpeg;base64,') ||
    photoData.length > maxProfilePhotoLength
  ) {
    throw new Error('La foto procesada es demasiado grande. Prueba con otra imagen.')
  }
  await setDoc(profilePhotoRef(uid), {
    photo_data: photoData,
    updated_at: new Date().toISOString(),
  })
}

export async function deleteProfilePhoto(uid: string) {
  await deleteDoc(profilePhotoRef(uid))
}

export const normalizeUsername = (username: string) => username.trim().toLowerCase()

const validateUsername = (username: string) => {
  if (username === 'admin') {
    throw new Error('Ese nombre de usuario está reservado.')
  }
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    throw new Error('El nombre de usuario debe tener entre 3 y 20 caracteres: letras, números, punto, guion o guion bajo.')
  }
}

export async function resolveUsernameEmail(username: string): Promise<string> {
  const normalized = normalizeUsername(username)
  validateUsername(normalized)
  const indexSnapshot = await getDoc(usernameIndexRef(normalized))
  const legacySnapshot = indexSnapshot.exists()
    ? null
    : await getDoc(legacyUsernameRef(normalized))
  const email = indexSnapshot.data()?.email ?? legacySnapshot?.data()?.email
  if (typeof email !== 'string') throw new Error('No encontramos una cuenta con ese nombre de usuario.')
  return email
}

export async function createMemberProfile(
  user: User,
  requestedPlayerName: string,
  requestedUsername: string,
) {
  const name = requestedPlayerName.trim()
  const username = normalizeUsername(requestedUsername)
  if (!name) throw new Error('Escribe tu nombre de jugador.')
  validateUsername(username)
  if (!user.email) throw new Error('La cuenta necesita un correo para crear el nombre de usuario.')
  const database = firestore()
  const currentProfileRef = profileRef(user.uid)
  const playerDocument = doc(database, 'players', user.uid)
  const createdAt = new Date().toISOString()
  const profile: Omit<Profile, 'id'> = {
    display_name: user.displayName?.trim() || user.email?.split('@')[0] || 'Integrante',
    username,
    role: 'member',
    is_authorized: true,
    created_at: createdAt,
    requested_player_name: name,
  }
  await runTransaction(database, async (transaction) => {
    const requestedUsernameRef = usernameIndexRef(username)
    const [usernameSnapshot, legacySnapshot] = await Promise.all([
      transaction.get(requestedUsernameRef),
      transaction.get(legacyUsernameRef(username)),
    ])
    if (usernameSnapshot.exists()) throw new Error('Ese nombre de usuario ya está en uso.')
    if (legacySnapshot.exists() && legacySnapshot.data().email !== user.email) {
      throw new Error('Ese nombre de usuario ya está en uso.')
    }
    transaction.set(currentProfileRef, profile)
    transaction.set(requestedUsernameRef, {
      type: 'username_index',
      username,
      email: user.email,
      profile_id: user.uid,
    })
    transaction.set(playerDocument, {
      name,
      profile_id: user.uid,
      active: true,
      created_at: createdAt,
      updated_at: createdAt,
    })
  })
}

export async function setMemberUsername(uid: string, email: string, requestedUsername: string) {
  const username = normalizeUsername(requestedUsername)
  validateUsername(username)
  const database = firestore()
  await runTransaction(database, async (transaction) => {
    const currentProfileRef = profileRef(uid)
    const requestedUsernameRef = usernameIndexRef(username)
    const [profileSnapshot, usernameSnapshot, legacySnapshot] = await Promise.all([
      transaction.get(currentProfileRef),
      transaction.get(requestedUsernameRef),
      transaction.get(legacyUsernameRef(username)),
    ])
    if (!profileSnapshot.exists()) throw new Error('No encontramos el perfil de esta cuenta.')
    if (profileSnapshot.data().username) throw new Error('Esta cuenta ya tiene un nombre de usuario.')
    if (usernameSnapshot.exists()) throw new Error('Ese nombre de usuario ya está en uso.')
    if (legacySnapshot.exists() && legacySnapshot.data().email !== email) {
      throw new Error('Ese nombre de usuario ya está en uso.')
    }
    transaction.update(currentProfileRef, { username })
    transaction.set(requestedUsernameRef, {
      type: 'username_index',
      username,
      email,
      profile_id: uid,
    })
  })
}

export async function loadPlayers(): Promise<Player[]> {
  const snapshot = await getDocs(query(collection(firestore(), 'players'), orderBy('name')))
  return snapshot.docs.map((item) => toPlayer(item.id, item.data()))
}

export async function loadMatches(): Promise<Match[]> {
  const snapshot = await getDocs(
    query(collection(firestore(), 'matches'), orderBy('played_at', 'desc')),
  )
  return snapshot.docs.map((item) => toMatch(item.id, item.data()))
}

export async function loadRoster(matches: Match[]): Promise<MatchPlayer[]> {
  const snapshots = await Promise.all(
    matches.map((match) => getDocs(collection(firestore(), 'matches', match.id, 'players'))),
  )
  return snapshots.flatMap((snapshot) =>
    snapshot.docs.map((item) => ({
      match_id: item.ref.parent.parent?.id ?? '',
      player_id: item.id,
    })),
  )
}

export async function loadMyVotes(matches: Match[], uid: string): Promise<VoteRecord[]> {
  const existing = await Promise.all(
    matches.map(async (match) => {
      const snapshot = await getDoc(voteRef(match.id, uid))
      return snapshot.exists()
        ? { match_id: match.id, player_id: String(snapshot.data().player_id) }
        : null
    }),
  )
  return existing.filter((vote): vote is VoteRecord => vote !== null)
}

export async function loadProfiles(): Promise<Profile[]> {
  const snapshot = await getDocs(
    query(collection(firestore(), 'profiles'), orderBy('display_name')),
  )
  return snapshot.docs.map((item) => toProfile(item.id, item.data()))
}

export async function loadAuditLogs(): Promise<AuditLog[]> {
  const snapshot = await getDocs(
    query(collection(firestore(), 'audit_logs'), orderBy('created_at', 'desc'), limit(50)),
  )
  return snapshot.docs.map((item) => toAuditLog(item.id, item.data()))
}

export async function submitVote(matchId: string, playerId: string, voterId: string) {
  const database = firestore()
  await runTransaction(database, async (transaction) => {
    const parentRef = matchRef(matchId)
    const playerDocument = doc(database, 'players', playerId)
    const currentProfileRef = profileRef(voterId)
    const currentVoteRef = voteRef(matchId, voterId)
    const [matchSnapshot, playerSnapshot, profileSnapshot, rosterSnapshot, voteSnapshot] =
      await Promise.all([
        transaction.get(parentRef),
        transaction.get(playerDocument),
        transaction.get(currentProfileRef),
        transaction.get(rosterRef(matchId, playerId)),
        transaction.get(currentVoteRef),
      ])

    if (!profileSnapshot.exists() || profileSnapshot.data().is_authorized !== true) {
      throw new Error('Tu cuenta no está autorizada para votar.')
    }
    if (!matchSnapshot.exists() || matchSnapshot.data().status !== 'open') {
      throw new Error('La votación de este partido no está abierta.')
    }
    if (
      !playerSnapshot.exists() ||
      playerSnapshot.data().active !== true ||
      !rosterSnapshot.exists()
    ) {
      throw new Error('El jugador no está habilitado para este partido.')
    }
    if (playerSnapshot.data().profile_id === voterId) {
      throw new Error('No puedes votar por ti mismo.')
    }
    if (voteSnapshot.exists()) {
      throw new Error('Ya registraste tu voto para este partido.')
    }

    transaction.set(currentVoteRef, {
      match_id: matchId,
      voter_id: voterId,
      player_id: playerId,
      created_at: new Date().toISOString(),
      created_at_server: serverTimestamp(),
    })
    transaction.set(doc(collection(database, 'audit_logs')), makeAuditLog(
      voterId,
      'vote.submitted',
      'match',
      matchId,
      { player_id: playerId },
    ))
  })
}

export async function loadRanking(players: Player[], matches: Match[]): Promise<RankingRow[]> {
  const closed = matches.filter((match) => match.status === 'closed')
  const totals = new Map(
    players.map((player) => [player.id, { votes: 0, matches: 0, mvps: 0 }]),
  )

  await Promise.all(
    closed.map(async (match) => {
      const [rosterSnapshot, votesSnapshot] = await Promise.all([
        getDocs(collection(firestore(), 'matches', match.id, 'players')),
        getDocs(collection(firestore(), 'matches', match.id, 'votes')),
      ])
      rosterSnapshot.docs.forEach((item) => {
        const stats = totals.get(item.id)
        if (stats) stats.matches += 1
      })
      const matchVotes = new Map<string, number>()
      votesSnapshot.docs.forEach((item) => {
        const playerId = String(item.data().player_id)
        const stats = totals.get(playerId)
        if (stats) stats.votes += 1
        matchVotes.set(playerId, (matchVotes.get(playerId) ?? 0) + 1)
      })
      const highestVoteCount = Math.max(0, ...matchVotes.values())
      if (highestVoteCount > 0) {
        matchVotes.forEach((voteCount, playerId) => {
          if (voteCount === highestVoteCount) {
            const stats = totals.get(playerId)
            if (stats) stats.mvps += 1
          }
        })
      }
    }),
  )

  return players
    .map((player) => ({
      player_id: player.id,
      player_name: player.name,
      total_votes: totals.get(player.id)?.votes ?? 0,
      matches_played: totals.get(player.id)?.matches ?? 0,
      mvp_count: totals.get(player.id)?.mvps ?? 0,
    }))
    .sort((a, b) => b.total_votes - a.total_votes || a.player_name.localeCompare(b.player_name))
}

export async function loadMatchResults(
  matchId: string,
  players: Player[],
): Promise<MatchResult[]> {
  const [rosterSnapshot, votesSnapshot] = await Promise.all([
    getDocs(collection(firestore(), 'matches', matchId, 'players')),
    getDocs(collection(firestore(), 'matches', matchId, 'votes')),
  ])
  const eligibleIds = new Set(rosterSnapshot.docs.map((item) => item.id))
  const votes = new Map<string, number>()
  votesSnapshot.docs.forEach((item) => {
    const playerId = String(item.data().player_id)
    votes.set(playerId, (votes.get(playerId) ?? 0) + 1)
  })
  return players
    .filter((player) => eligibleIds.has(player.id))
    .map((player) => ({
      player_id: player.id,
      player_name: player.name,
      vote_count: votes.get(player.id) ?? 0,
    }))
    .sort((a, b) => b.vote_count - a.vote_count || a.player_name.localeCompare(b.player_name))
}

export async function savePlayer(
  actorId: string,
  playerId: string | null,
  name: string,
  profileId: string | null,
) {
  const database = firestore()
  const playerDocument = playerId
    ? doc(database, 'players', playerId)
    : doc(collection(database, 'players'))
  const updatedAt = new Date().toISOString()
  const batch = writeBatch(database)
  if (playerId) {
    const previous = await getDoc(playerDocument)
    if (!previous.exists()) throw new Error('No se encontró el jugador.')
    batch.update(playerDocument, { name, profile_id: profileId, updated_at: updatedAt })
  } else {
    batch.set(playerDocument, {
      name,
      profile_id: profileId,
      active: true,
      created_at: updatedAt,
      updated_at: updatedAt,
    })
  }
  batch.set(
    doc(collection(database, 'audit_logs')),
    makeAuditLog(actorId, playerId ? 'player.updated' : 'player.created', 'player', playerDocument.id, {
      name,
      profile_id: profileId,
    }),
  )
  await batch.commit()
}

export async function togglePlayer(player: Player, actorId: string) {
  const database = firestore()
  const updatedAt = new Date().toISOString()
  const batch = writeBatch(database)
  batch.update(doc(database, 'players', player.id), {
    active: !player.active,
    updated_at: updatedAt,
  })
  batch.set(
    doc(collection(database, 'audit_logs')),
    makeAuditLog(
      actorId,
      player.active ? 'player.deactivated' : 'player.activated',
      'player',
      player.id,
      { name: player.name, active: !player.active },
    ),
  )
  await batch.commit()
}

export async function updateMember(
  memberId: string,
  actorId: string,
  changes: Partial<Pick<Profile, 'role' | 'is_authorized'>>,
) {
  const database = firestore()
  const batch = writeBatch(database)
  batch.update(profileRef(memberId), changes)
  batch.set(
    doc(collection(database, 'audit_logs')),
    makeAuditLog(actorId, 'profile.updated', 'profile', memberId, changes),
  )
  await batch.commit()
}

export async function approveMember(member: Profile, actorId: string) {
  const database = firestore()
  const playerName = member.requested_player_name?.trim()
  if (!playerName) throw new Error('Este integrante todavía no ha elegido un jugador.')
  const players = await loadPlayers()
  const candidate = players.find((player) => player.profile_id === member.id)
  const normalizedName = playerName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const legacyCandidate = candidate ?? players.find((player) => {
    const currentName = player.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    return currentName === normalizedName
  })
  const linkedPlayerId = legacyCandidate?.id ??
    `custom-${normalizedName.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || member.id}`
  const linkedPlayerRef = doc(database, 'players', linkedPlayerId)

  await runTransaction(database, async (transaction) => {
    const currentProfileRef = profileRef(member.id)
    const [adminSnapshot, memberSnapshot, playerSnapshot] = await Promise.all([
      transaction.get(profileRef(actorId)),
      transaction.get(currentProfileRef),
      transaction.get(linkedPlayerRef),
    ])
    if (
      !adminSnapshot.exists() ||
      adminSnapshot.data().role !== 'admin' ||
      adminSnapshot.data().is_authorized !== true
    ) {
      throw new Error('Solo un administrador autorizado puede aprobar integrantes.')
    }
    if (!memberSnapshot.exists()) throw new Error('No se encontró el perfil del integrante.')

    if (
      playerSnapshot.exists() &&
      playerSnapshot.data().profile_id &&
      playerSnapshot.data().profile_id !== member.id
    ) {
      throw new Error(
        `${playerName} ya está vinculado a otra cuenta. Edita el jugador y confirma la cuenta correcta.`,
      )
    }

    const now = new Date().toISOString()
    if (playerSnapshot.exists()) {
      transaction.update(linkedPlayerRef, {
        profile_id: member.id,
        active: true,
        updated_at: now,
      })
    } else {
      transaction.set(linkedPlayerRef, {
        name: playerName,
        profile_id: member.id,
        active: true,
        created_at: now,
        updated_at: now,
      })
    }

    transaction.update(currentProfileRef, { is_authorized: true })
    transaction.set(
      doc(collection(database, 'audit_logs')),
      makeAuditLog(actorId, 'profile.approved', 'profile', member.id, {
        player_id: linkedPlayerId,
        player_name: playerName,
      }),
    )
  })
}

export async function createMatch(
  actorId: string,
  playedAt: string,
  opponent: string | null,
  playerIds: string[],
) {
  if (playerIds.length < 2 || new Set(playerIds).size !== playerIds.length) {
    throw new Error('Selecciona al menos dos jugadores habilitados, sin repetir.')
  }
  const database = firestore()
  const matchDocument = doc(collection(database, 'matches'))
  const createdAt = new Date().toISOString()
  const batch = writeBatch(database)
  batch.set(matchDocument, {
    played_at: playedAt,
    opponent,
    status: 'draft',
    player_ids: playerIds,
    created_by: actorId,
    created_at: createdAt,
    opened_at: null,
    closed_at: null,
  })
  playerIds.forEach((playerId) => {
    batch.set(rosterRef(matchDocument.id, playerId), { player_id: playerId })
  })
  batch.set(
    doc(collection(database, 'audit_logs')),
    makeAuditLog(actorId, 'match.created', 'match', matchDocument.id, {
      played_at: playedAt,
      opponent,
      player_ids: playerIds,
    }),
  )
  await batch.commit()
}

export async function setMatchStatus(
  matchId: string,
  status: 'open' | 'closed',
  actorId: string,
) {
  const database = firestore()
  const matchDocument = matchRef(matchId)
  const updatedAt = new Date().toISOString()
  await runTransaction(database, async (transaction) => {
    const matchSnapshot = await transaction.get(matchDocument)
    if (!matchSnapshot.exists()) throw new Error('No se encontró el partido.')
    const currentStatus = matchSnapshot.data().status
    if (status === 'open' && currentStatus !== 'draft') {
      throw new Error('Solo se pueden abrir partidos en preparación.')
    }
    if (status === 'closed' && currentStatus !== 'open') {
      throw new Error('Solo se pueden cerrar votaciones abiertas.')
    }
    transaction.update(matchDocument, {
      status,
      ...(status === 'open' ? { opened_at: updatedAt } : { closed_at: updatedAt }),
    })
    transaction.set(
      doc(collection(database, 'audit_logs')),
      makeAuditLog(
        actorId,
        status === 'open' ? 'match.vote_opened' : 'match.vote_closed',
        'match',
        matchId,
      ),
    )
  })
}
