import { aiQueriesReport } from '../analyze/ai-queries.js'
import { deriveBrandTerms, isBrandQuery, registrableDomain } from '../brand.js'
import type { Detail } from './present.js'
import {
  cloroKey,
  cloroQueue,
  cloroTaskGet,
  DATAFORSEO_NO_RESULTS,
  DATAFORSEO_NOT_READY,
  type DataForSeoQueued,
  dataForSeoGet,
  dataForSeoKeys,
  dataForSeoLanguage,
  dataForSeoList,
  dataForSeoMarket,
  dataForSeoPost,
} from './research-providers.js'
import { PAGE_SIZE, rowsText } from './rows.js'
import { dateWindow } from './shared.js'
import { type CommandDeps, CommandError, type CommandResult } from './types.js'

// Whether AI answers cite or mention a site, for the questions people
// already ask AI about it: the top AI-shaped questions in the site's own
// Search Console, or up to 10 questions the person gives. One answer per
// question and engine, from the person's own DataForSEO or cloro account.
//
// Questions go in DataForSEO's queue (one request per engine), not its live
// endpoints: a live answer takes up to a minute, and a Cloudflare Worker can
// only wait on six requests at once, so 30 live calls outlast any MCP
// client. Queued answers are read back until waitSeconds runs out; any
// still in the queue are returned as task ids, already paid for, to read
// later at no cost. cloro runs the same way through its async API: one
// batch a run, read back the same way, and each answer charged when it
// finishes.

export const AI_ANSWER_QUESTIONS = 10
const QUESTION_DAYS = 90

// What an engine showed: the answer as Markdown, the URLs it cited (never
// pages it only looked at), and the model the provider says answered.
type Shown = { markdown: string; sources: string[]; model: string | null }

// Where and in which language an engine is asked. location is the code
// from DataForSEO's own list when it has the country, else its name.
type Market = { language_code: string } & (
  | { location_code: number }
  | { location_name: string }
)

type Engine = {
  name: string
  // What the engine name means here, for the notes.
  means: string
  // Queues tasks; get + id reads one back.
  post: string
  get: string
  // DataForSEO's free list of the languages this engine takes.
  languages: string
  task: (question: string, market: Market) => Record<string, unknown>
  // What the engine showed, or null when it showed no AI answer.
  shown: (result: Record<string, unknown>) => Shown | null
}

type Item = Record<string, unknown>
const list = (value: unknown) => (Array.isArray(value) ? (value as Item[]) : [])
const urls = (items: Item[]) =>
  items.map((item) => item.url).filter((url) => typeof url === 'string')

// Google AI Mode and AI Overviews: the ai_overview block, its Markdown, and
// the references on it and on each of its parts.
const overview = (result: Item): Shown | null => {
  const block = list(result.items).find((item) => item.type === 'ai_overview')
  if (!block) return null
  const parts = list(block.items)
  return {
    markdown:
      typeof block.markdown === 'string'
        ? block.markdown
        : parts.map((part) => String(part.markdown ?? '')).join('\n'),
    sources: urls([
      ...list(block.references),
      ...parts.flatMap((part) => list(part.references)),
    ]),
    model: null,
  }
}

const ENGINES: Engine[] = [
  {
    name: 'chatgpt',
    means: 'a ChatGPT search, read by DataForSEO',
    post: 'v3/ai_optimization/chat_gpt/llm_scraper/task_post',
    get: 'v3/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/',
    languages: 'v3/ai_optimization/chat_gpt/llm_scraper/languages',
    task: (question, market) => ({ keyword: question, ...market }),
    shown: (result) => {
      const markdown =
        typeof result.markdown === 'string' ? result.markdown : ''
      const sources = urls(list(result.sources))
      if (!markdown && !sources.length) return null
      return {
        markdown,
        sources,
        model: typeof result.model === 'string' ? result.model : null,
      }
    },
  },
  {
    name: 'google_ai_mode',
    means: 'Google AI Mode',
    post: 'v3/serp/google/ai_mode/task_post',
    get: 'v3/serp/google/ai_mode/task_get/advanced/',
    languages: 'v3/serp/google/ai_mode/languages',
    task: (question, market) => ({ keyword: question, ...market }),
    shown: overview,
  },
  {
    name: 'google_ai_overview',
    means: 'the AI Overview on a Google search',
    post: 'v3/serp/google/organic/task_post',
    get: 'v3/serp/google/organic/task_get/advanced/',
    languages: 'v3/serp/google/languages',
    task: (question, market) => ({
      keyword: question,
      depth: 10,
      load_async_ai_overview: true,
      ...market,
    }),
    shown: overview,
  },
]

// cloro's engines, by the taskType of its async API. Each answer has the
// same shape: the text, the sources and, for ChatGPT, the model.
const CLORO_ENGINES = [
  {
    name: 'chatgpt',
    means: 'a ChatGPT answer with web search, read by cloro',
    type: 'CHATGPT',
  },
  { name: 'google_ai_mode', means: 'Google AI Mode', type: 'AIMODE' },
  { name: 'gemini', means: 'Google Gemini', type: 'GEMINI' },
]

// A cloro task's idempotency key: the engine, the country, the UTC day and
// the question. A run sent again on the same day gets the same tasks back
// and is not charged twice. cloro does not return a task's prompt, so the
// key also carries the question for answers read back later.
const cloroTaskKey = (engine: string, country: string, question: string) =>
  `seo-ai-answers:${engine}:${country}:${new Date().toISOString().slice(0, 10)}:${question}`
const questionOf = (key: string | null) =>
  key?.split(':').slice(4).join(':') ?? ''

const cloroShown = (result: Item): Shown | null => {
  const markdown = typeof result.text === 'string' ? result.text : ''
  // Every source counts. ChatGPT sources can carry footnote: true, but in
  // live answers the links written into the text came back that way too.
  const sources = urls(list(result.sources))
  if (!markdown && !sources.length) return null
  return {
    markdown,
    sources,
    model:
      typeof result.model === 'string' && result.model ? result.model : null,
  }
}

// The answer's own words: citation pills such as [1](url) or
// [example.com](url) and bare links go, so a citation is never also counted
// as a mention by name.
function prose(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, (_, label: string) =>
      /^\s*(\d+|[\w-]+(\.[\w-]+)+)\s*$/.test(label) ? ' ' : label,
    )
    .replace(/https?:\/\/\S+/g, ' ')
}

function onSite(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === domain || host.endsWith(`.${domain}`)
  } catch {
    return false
  }
}

type Answer = {
  result:
    | 'cited'
    | 'mentioned'
    | 'neither'
    | 'no_answer'
    | 'pending'
    | 'unavailable'
  cited_url: string | null
  // The other sites the answer cites, by host, up to MAX_SOURCES.
  sources: string[]
  // The model the provider reports for the answer, when it reports one.
  model: string | null
  answered_at: string | null
  error?: string
}

const MAX_SOURCES = 8
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

// Hosts that show up in answers without being a source: DataForSEO's own
// API, image hosts and CDNs, and placeholder domains written into examples.
const NOT_SOURCES = [
  'dataforseo.com',
  'images.openai.com',
  'gstatic.com',
  'googleusercontent.com',
  'ggpht.com',
  'example.com',
  'example.org',
  'example.net',
]
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i
const isSource = (url: string) => {
  const host = hostOf(url)
  if (!host || IMAGE.test(url)) return false
  return !NOT_SOURCES.some((name) => host === name || host.endsWith(`.${name}`))
}

const empty = { cited_url: null, sources: [], model: null, answered_at: null }

// What a finished task says about the site.
function judge(
  engine: Engine,
  task: DataForSeoQueued,
  site: { domain: string; terms: string[] },
): Answer {
  if (task.status_code === DATAFORSEO_NO_RESULTS) {
    return { result: 'no_answer', ...empty }
  }
  if (task.status_code >= 40000 || !task.result) {
    return {
      result: 'unavailable',
      ...empty,
      error: `dataforseo: ${task.status_message}`.slice(0, 200),
    }
  }
  const answered_at = String(task.result.datetime ?? '').slice(0, 10) || null
  return classify(engine.shown(task.result), answered_at, site)
}

// What an answer says about the site.
function classify(
  shown: Shown | null,
  answered_at: string | null,
  site: { domain: string; terms: string[] },
): Answer {
  if (!shown) return { result: 'no_answer', ...empty, answered_at }
  // Links written into the answer count as sources too.
  const linked = shown.markdown.match(/https?:\/\/[^\s)\]]+/g) ?? []
  const all = [...shown.sources, ...linked]
  const cited = all.find((url) => onSite(url, site.domain)) ?? null
  const sources = [
    ...new Set(
      all
        .filter((url) => !onSite(url, site.domain) && isSource(url))
        .map(hostOf)
        .filter((host): host is string => Boolean(host)),
    ),
  ].slice(0, MAX_SOURCES)
  const base = { cited_url: cited, sources, model: shown.model, answered_at }
  if (cited) return { result: 'cited', ...base }
  const text = prose(shown.markdown)
  const mentioned =
    text.toLowerCase().includes(site.domain) || isBrandQuery(text, site.terms)
  return { result: mentioned ? 'mentioned' : 'neither', ...base }
}

// The market for each engine, checked against DataForSEO's free location
// and language lists before any paid call. A string says why an engine
// cannot be asked.
async function marketsFor(
  keys: string[],
  country: string,
): Promise<Map<string, Market | string>> {
  const code = country.toUpperCase()
  const language =
    dataForSeoLanguage(country) ?? dataForSeoMarket(country, null).language_code
  const [locations, ...languages] = await Promise.all([
    dataForSeoList(keys, 'v3/ai_optimization/chat_gpt/llm_scraper/locations'),
    ...ENGINES.map((engine) => dataForSeoList(keys, engine.languages)),
  ])
  const place = locations.find(
    (row) => row.location_type === 'Country' && row.country_iso_code === code,
  )
  const where = place
    ? { location_code: Number(place.location_code) }
    : { location_name: dataForSeoMarket(country, null).location_name }
  return new Map(
    ENGINES.map((engine, index) => {
      if (engine.name === 'chatgpt' && !place) {
        return [
          engine.name,
          `DataForSEO's ChatGPT search has no data for country "${country}".`,
        ]
      }
      const known = (languages[index] ?? []).some(
        (row) => row.language_code === language,
      )
      return [
        engine.name,
        known
          ? { ...where, language_code: language }
          : `DataForSEO's ${engine.name} has no "${language}" language, the language used for country "${country}".`,
      ]
    }),
  )
}

const usd = (value: number) => Math.round(value * 10_000) / 10_000

// The same tasks are read back in rounds: the first after FIRST_WAIT_MS
// (queued answers took 13 to 18 seconds in testing), then every
// ROUND_WAIT_MS until waitSeconds is used up.
const FIRST_WAIT_MS = 10_000
const ROUND_WAIT_MS = 5_000
export const AI_ANSWER_WAIT_SECONDS = 40
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// A queued answer, as "<engine>:<DataForSEO or cloro task id>".
const TASK_PATTERN = /^([a-z_]+):([0-9a-f-]{20,64})$/
export const AI_ANSWER_TASK_PATTERN = TASK_PATTERN

type Row = {
  question: string
  impressions: number | null
  engine: string
  task: string | null
  // The answer's task, kept after it is read, so later pages read it back
  // for free instead of asking again.
  ref: string | null
  // USD for DataForSEO, credits for cloro.
  cost: number
} & Answer

type Waiting = {
  row: Row
  // The DataForSEO engine, or null for a cloro task.
  engine: Engine | null
  id: string
}

// What a finished cloro task says about the site.
function cloroJudge(
  task: { status: string; createdAt: string | null; response: Item | null },
  site: { domain: string; terms: string[] },
): Answer {
  if (task.status !== 'COMPLETED' || !task.response) {
    const error = (task.response?.error ?? {}) as {
      code?: string
      message?: string
    }
    return {
      result: 'unavailable',
      ...empty,
      error:
        `cloro: ${error.code ?? task.status}${error.message ? `, ${error.message}` : ''}`.slice(
          0,
          200,
        ),
    }
  }
  return classify(
    cloroShown(task.response),
    task.createdAt?.slice(0, 10) ?? null,
    site,
  )
}

export async function runAiAnswers(
  input: {
    // Default dataforseo.
    provider?: 'dataforseo' | 'cloro'
    site: string
    country: string
    detail: Detail
    offset: number
    // Questions to ask instead of the site's Search Console questions. With
    // these, the site can be any domain, such as a competitor's.
    questions?: string[]
    // Answers queued by an earlier run, to read back instead of asking.
    tasks?: string[]
    // How long to wait for queued answers before returning the rest as
    // tasks. Default AI_ANSWER_WAIT_SECONDS.
    waitSeconds?: number
  },
  headers: Headers,
  deps: CommandDeps,
  // How to ask for the next page: the same target with these tasks, which
  // reads every answer back at no cost instead of asking again.
  more: (offset: number, tasks: string[]) => string,
): Promise<CommandResult> {
  const cloro = input.provider === 'cloro'
  const keys = cloro ? [cloroKey(headers)] : dataForSeoKeys(headers)
  const engines = cloro ? CLORO_ENGINES : ENGINES
  const domain = registrableDomain(input.site)?.domain
  if (!domain) {
    throw new CommandError(
      'INVALID_INPUT',
      `ai_answers needs a site with a domain, not "${input.site}".`,
    )
  }
  const site = { domain, terms: deriveBrandTerms({ siteUrl: input.site }) }
  const given = [
    ...new Set((input.questions ?? []).map((q) => q.trim()).filter(Boolean)),
  ]
  if (given.length > AI_ANSWER_QUESTIONS) {
    throw new CommandError(
      'INVALID_INPUT',
      `ai_answers takes up to ${AI_ANSWER_QUESTIONS} questions, not ${given.length}.`,
    )
  }
  const tasks = [...new Set(input.tasks ?? [])]
  const range = dateWindow({}, QUESTION_DAYS)
  const rows: Row[] = []
  const waiting: Waiting[] = []
  const blank = (question: string, impressions: number | null) => ({
    question,
    impressions,
    task: null,
    ref: null,
    cost: 0,
    ...empty,
  })

  if (tasks.length) {
    // Reading back costs nothing; the tasks were paid for when queued.
    for (const value of tasks) {
      const match = TASK_PATTERN.exec(value)
      const name = match?.[1] ?? ''
      const engine = ENGINES.find((item) => item.name === name)
      const known = cloro
        ? CLORO_ENGINES.some((item) => item.name === name)
        : Boolean(engine)
      if (!match || !known) {
        throw new CommandError(
          'INVALID_INPUT',
          `"${value}" is not an ai_answers task. Tasks look like <engine>:<id>, with the engine one of ${engines.map((item) => item.name).join(', ')}.`,
        )
      }
      const row: Row = {
        ...blank('', null),
        engine: name,
        result: 'pending',
        task: value,
        ref: value,
      }
      rows.push(row)
      waiting.push({
        row,
        engine: cloro ? null : (engine ?? null),
        id: match[2] as string,
      })
    }
  } else {
    let questions: { query: string; impressions: number | null }[]
    if (given.length) {
      questions = given.map((query) => ({ query, impressions: null }))
    } else {
      const report = await aiQueriesReport(
        { site: input.site, ...range },
        deps.searchAnalytics,
      )
      // Only questions that stand on their own (the report's askable rows).
      const items = (report.items ?? []) as {
        query: string
        askable: boolean
        impressions: number
      }[]
      questions = items
        .filter((item) => item.askable)
        .slice(0, AI_ANSWER_QUESTIONS)
    }
    if (cloro && questions.length) {
      const asked = questions.flatMap((question) =>
        CLORO_ENGINES.map((engine) => {
          const row: Row = {
            ...blank(question.query, question.impressions),
            engine: engine.name,
            result: 'unavailable',
          }
          rows.push(row)
          return { row, engine }
        }),
      )
      let queued: Awaited<ReturnType<typeof cloroQueue>> = []
      try {
        queued = await cloroQueue(
          keys[0] ?? '',
          asked.map(({ row, engine }) => ({
            taskType: engine.type,
            idempotencyKey: cloroTaskKey(
              engine.name,
              input.country,
              row.question,
            ),
            payload: {
              prompt: row.question,
              country: input.country.toUpperCase(),
            },
          })),
        )
      } catch (error) {
        // A missing or rejected key stops the run.
        if (error instanceof CommandError && error.code === 'NO_KEY') {
          throw error
        }
        for (const { row } of asked) {
          row.error =
            error instanceof Error ? error.message.slice(0, 200) : 'failed'
        }
      }
      queued.forEach((task, index) => {
        const row = asked[index]?.row
        if (!row) return
        if ('error' in task) {
          row.error = task.error.slice(0, 200)
          return
        }
        row.result = 'pending'
        row.task = `${row.engine}:${task.id}`
        row.ref = row.task
        waiting.push({ row, engine: null, id: task.id })
      })
    }
    const markets =
      questions.length && !cloro
        ? await marketsFor(keys, input.country)
        : new Map<string, Market | string>()
    await Promise.all(
      (cloro ? [] : ENGINES).map(async (engine) => {
        const engineRows: Row[] = questions.map((question) => ({
          ...blank(question.query, question.impressions),
          engine: engine.name,
          result: 'unavailable',
        }))
        rows.push(...engineRows)
        if (!questions.length) return
        const market = markets.get(engine.name) ?? 'no market'
        // A market DataForSEO does not support is never sent, so it costs
        // nothing.
        if (typeof market === 'string') {
          for (const row of engineRows) row.error = market
          return
        }
        let queuedTasks: DataForSeoQueued[]
        try {
          queuedTasks = await dataForSeoPost(
            keys,
            engine.post,
            questions.map((question) => ({
              ...engine.task(question.query, market),
              // High priority: about 15 seconds instead of minutes.
              priority: 2,
            })),
          )
        } catch (error) {
          // A missing or rejected key stops the run; one engine failing
          // does not.
          if (error instanceof CommandError && error.code === 'NO_KEY') {
            throw error
          }
          for (const row of engineRows) {
            row.error =
              error instanceof Error ? error.message.slice(0, 200) : 'failed'
          }
          return
        }
        engineRows.forEach((row, index) => {
          const task = queuedTasks[index]
          row.cost = task?.cost ?? 0
          if (!task || task.status_code >= 40000 || !task.id) {
            row.error = `dataforseo: ${task?.status_message ?? 'no task'}`
            return
          }
          row.result = 'pending'
          row.task = `${engine.name}:${task.id}`
          row.ref = row.task
          waiting.push({ row, engine, id: task.id })
        })
      }),
    )
  }

  // Read back in rounds until every answer is in or the wait is used up.
  const deadline =
    Date.now() + (input.waitSeconds ?? AI_ANSWER_WAIT_SECONDS) * 1000
  let pending = waiting
  let first = !tasks.length
  while (pending.length) {
    const pause = first ? FIRST_WAIT_MS : ROUND_WAIT_MS
    first = false
    if (!tasks.length || pending !== waiting) {
      if (Date.now() + pause > deadline) break
      await sleep(pause)
    }
    const still: Waiting[] = []
    await Promise.all(
      pending.map(async (item) => {
        try {
          if (!item.engine) {
            const task = await cloroTaskGet(keys[0] ?? '', item.id)
            if (!task) {
              Object.assign(item.row, {
                result: 'unavailable',
                task: null,
                error:
                  'cloro no longer has this task: it keeps tasks for 24 hours after they are created.',
              })
              return
            }
            if (!item.row.question) item.row.question = questionOf(task.key)
            if (task.status === 'QUEUED' || task.status === 'PROCESSING') {
              still.push(item)
              return
            }
            item.row.cost = task.credits ?? 0
            Object.assign(item.row, cloroJudge(task, site), { task: null })
            return
          }
          const task = await dataForSeoGet(keys, `${item.engine.get}${item.id}`)
          if (!item.row.question) {
            item.row.question = String(task.data.keyword ?? '')
          }
          if (DATAFORSEO_NOT_READY.has(task.status_code)) {
            still.push(item)
            return
          }
          Object.assign(item.row, judge(item.engine, task, site), {
            task: null,
          })
        } catch (error) {
          if (error instanceof CommandError && error.code === 'NO_KEY') {
            throw error
          }
          // A read that fails can be tried again later, so the task stays.
          still.push(item)
        }
      }),
    )
    pending = still
    if (tasks.length && Date.now() >= deadline) break
  }

  rows.sort(
    (a, b) =>
      a.question.localeCompare(b.question) ||
      engines.findIndex((e) => e.name === a.engine) -
        engines.findIndex((e) => e.name === b.engine),
  )
  const cost = usd(rows.reduce((sum, row) => sum + row.cost, 0))
  const count = (result: Answer['result']) =>
    rows.filter((row) => row.result === result).length
  const left = rows.filter((row) => row.task).map((row) => row.task as string)
  const refs = rows.flatMap((row) => (row.ref ? [row.ref] : []))
  // Which other sites the answers cite, by how many answers cite each.
  const cites = new Map<string, number>()
  for (const row of rows) {
    for (const host of row.sources) cites.set(host, (cites.get(host) ?? 0) + 1)
  }
  const topCited = [...cites]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
  const questionCount = new Set(rows.map((row) => row.question)).size
  const notes = [
    tasks.length
      ? `${tasks.length === 1 ? 'One answer' : `${tasks.length} answers`} queued by an earlier run, read back at no cost.${cloro ? ' cloro charges each answer once, when it finishes.' : ''}`
      : given.length
        ? `The ${given.length} questions you gave, asked as written. Impressions are blank because they don't come from Search Console.`
        : questionCount
          ? `The top ${questionCount} askable questions in Search Console’s AI-shaped queries for ${range.startDate} to ${range.endDate}, by impressions. No calls were made for other questions.`
          : `No askable questions in Search Console’s AI-shaped queries for ${range.startDate} to ${range.endDate}, so no answers were checked and nothing was spent.`,
    ...(rows.length
      ? [
          `Cited ${count('cited')}, mentioned ${count('mentioned')}, neither ${count('neither')}, no answer shown ${count('no_answer')}, unavailable ${count('unavailable')}, not ready ${count('pending')}. ${cloro ? `cloro credits charged for the answers that finished: ${cost}.` : `DataForSEO cost: $${cost}.`}`,
          ...(left.length
            ? [
                cloro
                  ? `${left.length === 1 ? "One answer wasn't" : `${left.length} answers weren't`} ready yet. cloro charges each one only when it finishes: ask ai_answers again with provider cloro, the same target and tasks ${JSON.stringify(left)} in a minute to read them (cloro keeps them for 24 hours).`
                  : `${left.length === 1 ? "One answer wasn't" : `${left.length} answers weren't`} ready yet. They're paid for: ask ai_answers again with the same target and tasks ${JSON.stringify(left)} in a minute to read them at no cost (DataForSEO keeps them for 30 days).`,
              ]
            : []),
          ...(topCited.length
            ? [
                `Other sites these answers cite: ${topCited.map(([host, n]) => `${host} (${n})`).join(', ')}.`,
              ]
            : []),
          'Each row is one sample of an answer that changes from run to run, not a ranking.',
          ...(cloro && !tasks.length
            ? [
                'cloro keeps one answer per question, engine and country each UTC day: asking again today reads these answers back instead of asking again.',
              ]
            : []),
          `cited: the answer lists or links a page on ${domain} or a subdomain. mentioned: no such source, but the answer text names ${[domain, ...site.terms].join(' or ')}, a text match. no_answer: the engine showed no AI answer for the question. sources: the other sites the answer cites, up to ${MAX_SOURCES}. model: the model ${cloro ? 'cloro' : 'DataForSEO'} reports for the answer, when it reports one.`,
          `Engines: ${engines.map((engine) => `${engine.name} is ${engine.means}`).join('; ')}.`,
        ]
      : []),
  ]
  const shown = rows.map((row) => ({
    question: row.question,
    impressions: row.impressions,
    engine: row.engine,
    result: row.result,
    cited_url: row.cited_url,
    sources: row.sources.join(', '),
    model: row.model,
    answered_at: row.answered_at,
    // Each row names its cost in the provider's own unit.
    ...(cloro ? { credits: row.cost } : { cost_usd: row.cost }),
    task: row.task,
    error: row.error ?? null,
  }))
  return {
    text: rowsText({
      title: `AI answers for ${input.site}, ${input.country}.`,
      rows: shown,
      offset: input.offset,
      limit: PAGE_SIZE,
      detail: input.detail,
      notes,
      more: (offset) => more(offset, refs),
    }),
    data: {
      provider: input.provider ?? 'dataforseo',
      action: 'ai_answers',
      site: input.site,
      country: input.country,
      questionsFrom: tasks.length
        ? { section: 'tasks' }
        : given.length
          ? { section: 'given' }
          : { section: 'ai-queries', ...range },
      questions: [...new Set(rows.map((row) => row.question))],
      costUsd: cloro ? null : cost,
      credits: cloro ? cost : null,
      pendingTasks: left,
      // Every answer's task: pass them as tasks to page through these
      // answers again at no cost.
      tasks: refs,
      citedSites: topCited.map(([host, answers]) => ({ host, answers })),
      total: rows.length,
      offset: input.offset,
      rows: rows
        .slice(input.offset, input.offset + PAGE_SIZE)
        .map(({ error, cost, ...row }) => ({
          ...row,
          ...(cloro ? { credits: cost } : { cost_usd: cost }),
          ...(error ? { error } : {}),
        })),
    },
  }
}
