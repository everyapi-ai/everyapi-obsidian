// Identifies this surface to the gateway (sent as X-Client-App; User-Agent is a forbidden header in Electron's fetch). Same scheme as apps/raycast.
export const CLIENT_APP = 'everyapi-obsidian'

// First-party OAuth2 client id seeded in the backend (backend/internal/platform/persistence/oauth2.go). Registered device-grant-only with NO redirect URI, because this plugin also runs on iOS/Android where a loopback callback cannot be served — so /api/oauth2/authorize must never be called from here.
export const OAUTH_CLIENT_ID = 'everyapi-obsidian'
