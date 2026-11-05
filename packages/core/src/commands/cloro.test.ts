import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAiAnswers } from './ai-answers.js'
import { research } from './research-providers.js'
import type { CommandDeps } from './types.js'

// Payloads are trimmed from live cloro responses (2026-11), with the
// domains changed to example ones.

const keys = new Headers({ 'x-cloro-key': 'test-key' })

// A cloro sync response with the credit and concurrency headers it sends.
const answer = (result: unknown, credits: number) =>
  Response.json(
    { success: true, result },
    {
      headers: {
        'x-credits-charged': String(credits),
        'x-credits-remaining': '11216642',
        'x-concurrency-limit': '1',
        'x-concurrency-current': '1',
      },
    },
  )

const goto = 'https://www.google.com/goto?url=CAESZwHEIkXXoe3bD3ea'

test('cloro serp reads organic results and the AI Overview sources', async () => {
  const requests: { url: string; auth: string | null; body: unknown }[] = []
  globalThis.fetch = (async (input: Request) => {
    requests.push({
      url: input.url,
      auth: input.headers.get('authorization'),
      body: await input.json(),
    })
    return answer(
      {
        organicResults: [
          {
            position: 1,
            title: 'The 12 best CRM tools',
            link: 'https://www.example.com/blog/best-crm/',
            displayedLink: 'https://www.example.com > Blog > Best apps',
            snippet: 'Best overall CRM ...',
            page: 1,
            redirectLink: goto,
          },
          {
            position: 2,
            title: 'What are the best CRM tools? : r/CRM',
            link: '',
            displayedLink: 'www.example.org',
            page: 1,
            redirectLink: goto,
          },
        ],
        peopleAlsoAsk: [
          { question: 'What is the best CRM?', type: 'AIOVERVIEW' },
        ],
        aioverview: {
          text: 'The best CRM tools cater to different needs.',
          sources: [
            {
              label: 'The 12 best CRM tools',
              url: 'https://www.example.com/blog/best-crm/',
              description: 'The 12 best CRMs ...',
              position: 1,
              redirectLink: goto,
            },
            {
              label: 'CRM picks',
              url: 'https://blog.example.net/crm',
              position: 2,
            },
          ],
          citationPills: [
            {
              label: 'The 12 best CRM tools',
              citationPillId: 1,
              url: 'https://www.example.com/blog/best-crm/',
              domain: 'example.com',
              position: 1,
            },
          ],
          videos: [],
        },
      },
      7,
    )
  }) as typeof fetch

  const out = await research('cloro', keys, {
    action: 'serp',
    keywords: ['best crm'],
    target: '',
    country: 'us',
    limit: 100,
  })
  assert.deepEqual(requests, [
    {
      url: 'https://api.cloro.dev/v1/monitor/google',
      auth: 'Bearer test-key',
      body: {
        query: 'best crm',
        country: 'US',
        include: { aioverview: true },
      },
    },
  ])
  assert.deepEqual(out, {
    rows: [
      {
        keyword: 'best crm',
        type: 'organic',
        position: 1,
        url: 'https://www.example.com/blog/best-crm/',
        domain: 'www.example.com',
        title: 'The 12 best CRM tools',
      },
      {
        keyword: 'best crm',
        type: 'organic',
        position: 2,
        url: null,
        domain: 'www.example.org',
        title: 'What are the best CRM tools? : r/CRM',
      },
      {
        keyword: 'best crm',
        type: 'ai_overview',
        position: 1,
        url: 'https://www.example.com/blog/best-crm/',
        domain: 'www.example.com',
        title: 'The 12 best CRM tools',
      },
      {
        keyword: 'best crm',
        type: 'ai_overview',
        position: 2,
        url: 'https://blog.example.net/crm',
        domain: 'blog.example.net',
        title: 'CRM picks',
      },
    ],
    costUsd: null,
    credits: 7,
    partial: false,
    missed: [],
    noData: [],
  })
})

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const today = new Date().toISOString().slice(0, 10)
const keyFor = (engine: string, question: string) =>
  `seo-ai-answers:${engine}:us:${today}:${question}`

test('cloro ai_answers queues one batch and returns the tasks not ready', async () => {
  const requests: { method: string; url: string; body: unknown }[] = []
  globalThis.fetch = (async (input: Request) => {
    requests.push({
      method: input.method,
      url: input.url,
      body: await input.json(),
    })
    return Response.json({
      success: true,
      summary: { total: 3, succeeded: 1, failed: 2 },
      results: [
        {
          success: true,
          index: 0,
          task: {
            id: id(1),
            taskType: 'CHATGPT',
            status: 'QUEUED',
            priority: 1,
            createdAt: '2026-11-05T21:41:18.033Z',
            latencyMs: null,
            idempotencyKey: keyFor('chatgpt', 'what is the best crm'),
          },
          credits: { creditsToCharge: 5, creditsCharged: null },
        },
        {
          // A run sent again: cloro returns the task it already has.
          success: false,
          index: 1,
          error: {
            code: 'RESOURCE_ALREADY_EXISTS',
            message: 'Idempotency key already used',
            details: { taskId: id(2) },
          },
        },
        {
          success: false,
          index: 2,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid task at index 2',
            details: {
              errors: [{ field: 'payload.country', message: 'Invalid input' }],
            },
          },
        },
      ],
    })
  }) as typeof fetch

  const out = await runAiAnswers(
    {
      provider: 'cloro',
      site: 'example.com',
      country: 'us',
      detail: 'rows',
      offset: 0,
      questions: ['what is the best crm'],
      waitSeconds: 0,
    },
    keys,
    {} as CommandDeps,
    () => '',
  )
  assert.deepEqual(requests, [
    {
      method: 'POST',
      url: 'https://api.cloro.dev/v1/async/task/batch',
      body: [
        ['CHATGPT', 'chatgpt'],
        ['AIMODE', 'google_ai_mode'],
        ['GEMINI', 'gemini'],
      ].map(([taskType, engine]) => ({
        taskType,
        idempotencyKey: keyFor(engine as string, 'what is the best crm'),
        payload: { prompt: 'what is the best crm', country: 'US' },
      })),
    },
  ])
  const data = out.data as {
    credits: number | null
    pendingTasks: string[]
    rows: Record<string, unknown>[]
  }
  assert.equal(data.credits, 0)
  assert.deepEqual(data.pendingTasks, [
    `chatgpt:${id(1)}`,
    `google_ai_mode:${id(2)}`,
  ])
  assert.deepEqual(
    data.rows.map((row) => [row.engine, row.result, row.error ?? null]),
    [
      ['chatgpt', 'pending', null],
      ['google_ai_mode', 'pending', null],
      [
        'gemini',
        'unavailable',
        'cloro: VALIDATION_ERROR, Invalid task at index 2',
      ],
    ],
  )
})

test('cloro ai_answers reads tasks back and judges each finished answer', async () => {
  // GET /v1/async/task/{id} bodies, trimmed from live ones.
  const finished = (
    n: number,
    taskType: string,
    question: string,
    charged: number,
    response: unknown,
    status = 'COMPLETED',
  ) => ({
    task: {
      id: id(n),
      taskType,
      status,
      priority: 1,
      createdAt: '2026-11-05T21:41:18.033Z',
      latencyMs: 26694,
      idempotencyKey: keyFor(
        taskType === 'AIMODE' ? 'google_ai_mode' : taskType.toLowerCase(),
        question,
      ),
    },
    credits: { creditsToCharge: charged, creditsCharged: charged },
    response,
  })
  const tasks: Record<string, unknown> = {
    [id(1)]: finished(1, 'CHATGPT', 'what is the best crm', 5, {
      // Live ChatGPT answers report no model.
      model: null,
      text: 'Here are my top picks.\n\n1. Example CRM\n\nWebsite and pricing',
      sources: [
        {
          position: 1,
          label: 'Website and pricing',
          url: 'https://www.example.com/pricing',
          footnote: true,
        },
        {
          position: 2,
          label: 'CRM picks',
          url: 'https://crm.example.net/picks/',
          footnote: false,
        },
      ],
      entities: [{ type: 'software', name: 'Example CRM' }],
      citationPills: [],
    }),
    [id(2)]: finished(2, 'AIMODE', 'what is the best crm', 4, {
      text: 'Example CRM suits small teams.',
      sources: [{ position: 1, url: 'https://example.org/crm/' }],
      citationPills: [],
    }),
    [id(3)]: finished(3, 'GEMINI', 'what is the best crm', 4, {
      text: 'Try a spreadsheet first.',
      sources: [
        {
          position: 1,
          url: 'https://example.net/sheets#:~:text=Free%20plan',
        },
      ],
      citationPills: [],
    }),
    [id(4)]: {
      task: {
        id: id(4),
        taskType: 'CHATGPT',
        status: 'QUEUED',
        priority: 1,
        createdAt: '2026-11-05T21:41:18.033Z',
        latencyMs: null,
        idempotencyKey: keyFor('chatgpt', 'how do I import contacts'),
      },
      credits: { creditsToCharge: 5, creditsCharged: null },
    },
    [id(6)]: finished(
      6,
      'AIMODE',
      'how do I import contacts',
      0,
      { error: { code: 'MODEL_ERROR', message: 'No answer after 5 attempts' } },
      'FAILED',
    ),
  }
  const reads: string[] = []
  globalThis.fetch = (async (input: Request) => {
    assert.equal(input.method, 'GET')
    reads.push(input.url)
    const body = tasks[input.url.split('/').pop() ?? '']
    // cloro deletes a task 24 hours after it was created.
    if (!body) return Response.json({ error: 'not found' }, { status: 404 })
    return Response.json(body)
  }) as typeof fetch

  const asked = [
    `chatgpt:${id(1)}`,
    `google_ai_mode:${id(2)}`,
    `gemini:${id(3)}`,
    `chatgpt:${id(4)}`,
    `gemini:${id(5)}`,
    `google_ai_mode:${id(6)}`,
  ]
  const out = await runAiAnswers(
    {
      provider: 'cloro',
      site: 'example.com',
      country: 'us',
      detail: 'rows',
      offset: 0,
      tasks: asked,
      waitSeconds: 0,
    },
    keys,
    {} as CommandDeps,
    () => '',
  )
  assert.equal(reads.length, 6)
  const data = out.data as {
    credits: number | null
    costUsd: number | null
    pendingTasks: string[]
    tasks: string[]
    rows: Record<string, unknown>[]
  }
  assert.equal(data.costUsd, null)
  assert.equal(data.credits, 13)
  assert.deepEqual(data.pendingTasks, [`chatgpt:${id(4)}`])
  assert.deepEqual([...data.tasks].sort(), [...asked].sort())
  assert.deepEqual(
    data.rows.map((row) => [
      row.question,
      row.engine,
      row.result,
      row.cited_url,
      row.credits,
    ]),
    // Sorted by question, then engine.
    [
      ['', 'gemini', 'unavailable', null, 0],
      ['how do I import contacts', 'chatgpt', 'pending', null, 0],
      ['how do I import contacts', 'google_ai_mode', 'unavailable', null, 0],
      [
        'what is the best crm',
        'chatgpt',
        'cited',
        'https://www.example.com/pricing',
        5,
      ],
      ['what is the best crm', 'google_ai_mode', 'mentioned', null, 4],
      ['what is the best crm', 'gemini', 'neither', null, 4],
    ],
  )
  assert.equal(
    data.rows[2]?.error,
    'cloro: MODEL_ERROR, No answer after 5 attempts',
  )
})
