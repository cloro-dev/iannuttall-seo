import { intro, note, outro, password } from '@clack/prompts'
import {
  CLORO_API_KEY_ENV,
  deleteCloroApiKey,
  localError,
  readCloroApiKey,
  SeoError,
  writeCloroApiKey,
} from '@seo/core'
import { cloroCredits } from '@seo/core/commands'
import { defineCommand } from 'citty'
import { jsonFlag } from '../../args.js'
import { canPrompt, maybeExitCancelled, printJson } from '../../utils.js'
import { credentialSourceLabel } from './shared.js'

const json = {
  type: 'boolean',
  default: false,
  description: 'Print machine-readable JSON.',
} as const

// The free credits check. A rejected key comes back as a CLI error.
const credits = (key: string) =>
  cloroCredits(key).catch((error: unknown) => {
    throw localError(error)
  })

const connectCommand = defineCommand({
  meta: { name: 'connect', description: 'Check and save a cloro API key' },
  args: { json },
  run: async ({ args }) => {
    if (!canPrompt({ json: jsonFlag(args) })) {
      throw new SeoError(
        'AUTH_REQUIRED',
        `Run \`seo providers cloro connect\` in a terminal. Agents and CI can set ${CLORO_API_KEY_ENV}.`,
      )
    }
    intro('Connect cloro')
    note(
      'The Free plan includes 500 credits a month. The check is free; research uses credits. Get a key at:\nhttps://dashboard.cloro.dev/api-keys?utm_source=iannuttall-seo&utm_medium=byok',
      'API key',
    )
    const apiKey = maybeExitCancelled(
      await password({
        message: 'cloro API key',
        validate: (value) =>
          value?.trim() ? undefined : 'API key is required',
      }),
    )
    const account = await credits(apiKey.trim())
    const source = await writeCloroApiKey(apiKey)
    note(
      `${account.remaining.toLocaleString('en-US')} credits left.`,
      'Connection verified',
    )
    outro(`Saved in the ${credentialSourceLabel(source)}.`)
  },
})

const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show the local cloro connection' },
  args: {
    check: {
      type: 'boolean',
      default: false,
      description: 'Check the key and read the credits left. Free.',
    },
    json,
  },
  run: async ({ args }) => {
    const credential = await readCloroApiKey()
    const account =
      args.check && credential ? await credits(credential.apiKey) : undefined
    const result = {
      connected: Boolean(credential),
      credentialSource: credential?.source,
      creditsRemaining: account?.remaining ?? null,
    }
    if (jsonFlag(args)) {
      printJson(result)
      return
    }
    process.stdout.write(
      `Connected: ${result.connected ? 'yes' : 'no'}\nCredential: ${credentialSourceLabel(result.credentialSource)}\n${account ? `Credits left: ${account.remaining.toLocaleString('en-US')}\n` : ''}`,
    )
  },
})

const disconnectCommand = defineCommand({
  meta: { name: 'disconnect', description: 'Remove the saved cloro API key' },
  args: { json },
  run: async ({ args }) => {
    await deleteCloroApiKey()
    const note = process.env[CLORO_API_KEY_ENV]?.trim()
      ? `The environment variable was not changed. Clear ${CLORO_API_KEY_ENV} to fully disconnect.`
      : 'cloro is disconnected.'
    if (jsonFlag(args)) printJson({ savedCredentialRemoved: true, note })
    else process.stdout.write(`${note}\n`)
  },
})

export const cloroProviderCommand = defineCommand({
  meta: {
    name: 'cloro',
    description: 'Connect cloro for SERP and AI answer data',
  },
  subCommands: {
    connect: connectCommand,
    status: statusCommand,
    disconnect: disconnectCommand,
  },
})
