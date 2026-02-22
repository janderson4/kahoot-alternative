/**
 * POST /api/generate-combinations
 *
 * Worker that:
 *  1. Reads every person from the `people` table.
 *  2. Works out every pair that is not yet in the `generated` table.
 *  3. Submits each missing pair to the WaveSpeed bytedance/seedream-v4.5/edit
 *     model (async mode — returns a prediction ID immediately).
 *  4. Polls the WaveSpeed result endpoint until every job has finished.
 *  5. Writes the combined image URL + "PersonA x PersonB" name into `generated`.
 *
 * This route is called fire-and-forget from the lobby after a player joins.
 * It is also invoked by a Vercel Cron Job every few minutes as a safety net
 * (see vercel.json).
 *
 * Required environment variables
 * ────────────────────────────────
 *  WAVESPEED_API_KEY          – your WaveSpeed bearer token
 *  NEXT_PUBLIC_SUPABASE_URL   – already used by the app
 *  SUPABASE_SERVICE_ROLE_KEY  – service-role key (bypasses RLS)
 *
 * Supabase Storage
 * ────────────────
 *  Create a public bucket called `people-photos` in your Supabase project.
 *  RLS policy: allow uploads from authenticated users (anon key works because
 *  players sign in anonymously before uploading).
 */

import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Vercel: allow up to 5 minutes on Pro / 60 s on Hobby
export const maxDuration = 300

// ── Types ────────────────────────────────────────────────────────────────────

interface Person {
  id: string
  name: string
  image: string
}

interface WaveSpeedSubmitResponse {
  code: number
  message?: string
  data?: {
    id: string
    status: string
  }
}

interface WaveSpeedResultResponse {
  code: number
  data?: {
    id: string
    status: 'queued' | 'processing' | 'completed' | 'failed'
    outputs?: string[]
    error?: string
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const WAVESPEED_API = 'https://api.wavespeed.ai/api/v3'
const MODEL = 'bytedance/seedream-v4.5/edit'

/**
 * Submit one image-edit job to WaveSpeed.
 * Returns the prediction ID on success, or null on failure.
 */
async function submitJob(
  imageUrl1: string,
  imageUrl2: string,
  apiKey: string
): Promise<string | null> {
  const prompt =
    'Create a single portrait photo that blends the facial features and ' +
    'appearance of both people shown in these two reference photos into one ' +
    'unique person. Combine their face shape, skin tone, hair colour, and ' +
    'distinctive features equally from both. Photorealistic, high-quality ' +
    'portrait, natural lighting, clean background.'

  try {
    const res = await fetch(`${WAVESPEED_API}/${MODEL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        images: [imageUrl1, imageUrl2],
        enable_sync_mode: false,
      }),
    })

    if (!res.ok) {
      console.error(`WaveSpeed submit error ${res.status}:`, await res.text())
      return null
    }

    const json: WaveSpeedSubmitResponse = await res.json()
    if (json.code !== 200 || !json.data?.id) {
      console.error('WaveSpeed submit unexpected response:', json)
      return null
    }

    return json.data.id
  } catch (err) {
    console.error('WaveSpeed submit exception:', err)
    return null
  }
}

/**
 * Poll one prediction until it is completed or failed.
 * Returns the output image URL, or null if it fails / times out.
 */
async function pollResult(
  predictionId: string,
  apiKey: string,
  maxAttempts = 30,
  intervalMs = 3000
): Promise<string | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs))

    try {
      const res = await fetch(
        `${WAVESPEED_API}/predictions/${predictionId}/result`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        }
      )

      if (!res.ok) continue

      const json: WaveSpeedResultResponse = await res.json()
      const status = json.data?.status

      if (status === 'completed') {
        return json.data?.outputs?.[0] ?? null
      }

      if (status === 'failed') {
        console.error(
          `Prediction ${predictionId} failed:`,
          json.data?.error
        )
        return null
      }
      // queued / processing — keep polling
    } catch (err) {
      console.error(`Poll attempt ${attempt} exception:`, err)
    }
  }

  console.error(`Prediction ${predictionId} timed out after ${maxAttempts} polls`)
  return null
}

/**
 * Build a canonical combination name so that "Alice x Bob" and "Bob x Alice"
 * are treated as the same pair.  We always put the name that comes first
 * alphabetically on the left.
 */
function canonicalName(nameA: string, nameB: string): string {
  return nameA.localeCompare(nameB) <= 0
    ? `${nameA} x ${nameB}`
    : `${nameB} x ${nameA}`
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function POST() {
  const apiKey = process.env.WAVESPEED_API_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!apiKey) {
    return NextResponse.json({ error: 'WAVESPEED_API_KEY not set' }, { status: 500 })
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'Supabase env vars not set' },
      { status: 500 }
    )
  }

  // Use service-role client so we can read/write without RLS restrictions
  const db = createClient(supabaseUrl, serviceRoleKey)

  // 1. Fetch all people -------------------------------------------------------
  const { data: people, error: peopleErr } = await db
    .from('people')
    .select('id, name, image')

  if (peopleErr) {
    return NextResponse.json({ error: peopleErr.message }, { status: 500 })
  }
  if (!people || people.length < 2) {
    return NextResponse.json({ message: 'Not enough people yet' }, { status: 200 })
  }

  // 2. Fetch existing generated combinations ----------------------------------
  const { data: existingGenerated, error: genErr } = await db
    .from('generated')
    .select('name')

  if (genErr) {
    return NextResponse.json({ error: genErr.message }, { status: 500 })
  }

  const existingNames = new Set<string>(
    (existingGenerated ?? []).map((g: { name: string }) => g.name)
  )

  // 3. Determine which pairs are missing -------------------------------------
  const missingPairs: [Person, Person][] = []
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const name = canonicalName(people[i].name, people[j].name)
      if (!existingNames.has(name)) {
        missingPairs.push([people[i] as Person, people[j] as Person])
      }
    }
  }

  if (missingPairs.length === 0) {
    return NextResponse.json(
      { message: 'All combinations already generated' },
      { status: 200 }
    )
  }

  console.log(`Generating ${missingPairs.length} missing combination(s)…`)

  // 4. Submit all jobs to WaveSpeed in parallel --------------------------------
  const submitted: Array<{
    pair: [Person, Person]
    predictionId: string
    canonName: string
  }> = []

  await Promise.all(
    missingPairs.map(async (pair) => {
      const predictionId = await submitJob(pair[0].image, pair[1].image, apiKey)
      if (predictionId) {
        submitted.push({
          pair,
          predictionId,
          canonName: canonicalName(pair[0].name, pair[1].name),
        })
      }
    })
  )

  // 5. Poll all jobs and save results as they complete -----------------------
  const results = await Promise.allSettled(
    submitted.map(async ({ pair, predictionId, canonName }) => {
      const outputUrl = await pollResult(predictionId, apiKey)
      if (!outputUrl) throw new Error(`No output for ${canonName}`)

      const { error: insertErr } = await db
        .from('generated')
        .insert({ name: canonName, image: outputUrl })
        .select()
        .single()

      // 23505 = unique_violation — another worker beat us to it; that's fine
      if (insertErr && insertErr.code !== '23505') {
        throw new Error(insertErr.message)
      }

      console.log(`✓ Saved combination: ${canonName}`)
      return canonName
    })
  )

  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.filter((r) => r.status === 'rejected').length

  return NextResponse.json(
    {
      message: `Done. Succeeded: ${succeeded}, failed: ${failed}`,
      total: missingPairs.length,
      submitted: submitted.length,
      succeeded,
      failed,
    },
    { status: 200 }
  )
}

// Also allow GET so Vercel Cron jobs (which send GET by default) work
export async function GET() {
  return POST()
}

