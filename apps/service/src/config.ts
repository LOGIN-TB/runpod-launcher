/**
 * Deployment-time settings — the only things that must be known before the
 * service can start, and none of them secret.
 *
 * Everything confidential (RunPod key, HuggingFace token, webhook URLs) is
 * typed into the app instead and stored encrypted. The rule is not "no
 * environment variables" but "no secrets in files": a port cannot be typed into
 * a UI that is not listening yet.
 *
 * PAIRING_CODE is the one borderline case. It is single-use, expires, and
 * exists so Coolify can surface it in its own UI via SERVICE_PASSWORD_PAIRING
 * rather than making the user dig through container logs.
 */
export interface ServiceConfig {
  port: number
  host: string
  dataDir: string
  databasePath: string
  masterKeyPath: string
  /**
   * `self` — the service terminates TLS with a certificate it generates, and
   * the app pins its fingerprint. Right for plain Docker Compose.
   * `proxy` — something in front (Coolify, Traefik) terminates TLS with a real
   * certificate; the service speaks plain HTTP and the app validates the chain
   * normally. Pinning would break here every 90 days on renewal.
   */
  tlsMode: 'self' | 'proxy'
  /** Supplied by Coolify, otherwise generated and logged on first start. */
  pairingCode: string | null
}

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const dataDir = env.DATA_DIR ?? '/data'
  const tlsMode = env.TLS_MODE === 'proxy' ? 'proxy' : 'self'
  const pairingCode = env.PAIRING_CODE?.trim()

  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    databasePath: env.DATABASE_PATH ?? `${dataDir}/launcher.db`,
    masterKeyPath: env.MASTER_KEY_PATH ?? `${dataDir}/keys/master.key`,
    tlsMode,
    pairingCode: pairingCode && pairingCode.length > 0 ? pairingCode : null,
  }
}
