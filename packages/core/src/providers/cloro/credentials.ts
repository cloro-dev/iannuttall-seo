import { PROVIDER_SECRET_NAMES } from '../../storage/provider-secrets.js'
import { createApiKeyCredentialStore } from '../api-key-credentials.js'

export const CLORO_API_KEY_ENV = 'SEO_CLORO_API_KEY'
export const CLORO_API_KEY_SECRET = PROVIDER_SECRET_NAMES.cloroApiKey

const store = createApiKeyCredentialStore({
  provider: 'cloro',
  environmentVariable: CLORO_API_KEY_ENV,
  secretName: CLORO_API_KEY_SECRET,
  invalidMessage: 'cloro needs a valid API key.',
})

export async function writeCloroApiKey(value: string) {
  return store.write(value)
}

export async function readCloroApiKey(input: { env?: NodeJS.ProcessEnv } = {}) {
  return store.read(input)
}

export async function deleteCloroApiKey(): Promise<void> {
  await store.remove()
}
