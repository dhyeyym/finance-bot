const { google } = require('googleapis')
const fs = require('fs')
const path = require('path')

const WEBHOOK_URL = process.env.WEBHOOK_URL
const SPREADSHEET_ID = process.env.SPREADSHEET_ID
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000')
const ROLE_ID = process.env.ROLE_ID || ''
const STATE_FILE = process.env.STATE_FILE || '/data/state/state.json'

if (!WEBHOOK_URL || !SPREADSHEET_ID) {
  console.error('need WEBHOOK_URL and SPREADSHEET_ID set')
  process.exit(1)
}

const SIG_SHEETS = [
  'SIGINT',
  'QuantSIG',
  'CloudSIG',
  'Tardis',
  'GameDevSIG',
  'TypeSIG',
  'ProjectShare',
  'EdinburghAI',
  'CCSIG',
  'BitSIG',
  'EVP',
  'NeuroSIG'
]
const OTHER_SHEETS = [
  'HTB',
  'InfBall',
  'Social',
  'Misc',
  'STMU',
  'Subscriptions',
  'Merch',
  'AoC'
]
const WATCHED_SHEETS = OTHER_SHEETS.concat(SIG_SHEETS)

function sleep (ms) {
  return new Promise(r => setTimeout(r, ms))
}

function loadState () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch (e) {
    return null
  }
}

let warnedSave = false

function saveState (state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })

    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state))
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
  } catch (e) {
    if (!warnedSave) {
      console.error(
        'cant write state file (' +
          e.code +
          '), keeping state in memory only. restarts will skip changes made while down'
      )
      warnedSave = true
    }
  }
}

function parseAmount (raw) {
  if (raw == null) {
    return null
  }

  const n = parseFloat(String(raw).replace(/[£,]/g, '').trim())

  if (isNaN(n)) {
    return null
  } else {
    return n
  }
}

async function sendMessage (type, sheet, reason, amount) {
  let content = ROLE_ID ? '<@&' + ROLE_ID + '> ' : ''

  content += type + ' for ' + sheet + ':\n'

  if (!SIG_SHEETS.includes(sheet)) {
    content += 'Reason: ' + reason + '\n'
  }

  content += 'Amount: £' + amount.toFixed(2)

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content, username: 'Finance Bot' })
  })

  if (res.status === 429) {
    const body = await res.json().catch(() => ({}))
    await sleep((body.retry_after || 1) * 1000)
    return sendMessage(type, sheet, reason, amount)
  }

  if (!res.ok) {
    console.error('webhook failed:', res.status, await res.text())
  }
}

async function readSheets (sheets) {
  const ranges = []

  for (const name of WATCHED_SHEETS) {
    ranges.push("'" + name + "'!D2:E")
  }

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: ranges,
    valueRenderOption: 'UNFORMATTED_VALUE'
  })

  const current = {}

  for (let i = 0; i < WATCHED_SHEETS.length; i++) {
    const rows = {}
    const values = res.data.valueRanges[i].values || []

    for (let j = 0; j < values.length; j++) {
      let reason = ''

      if (values[j][0] != null) {
        reason = String(values[j][0]).trim()
      }

      const amount = parseAmount(values[j][1])

      if (reason && amount !== null) {
        rows[j + 2] = { reason: reason, amount: amount }
      }
    }

    current[WATCHED_SHEETS[i]] = rows
  }

  return current
}

function diffRows (prevRows, currRows) {
  const old = new Map()

  for (const row in prevRows) {
    const k = prevRows[row].reason + '|' + prevRows[row].amount

    if (!old.has(k)) {
      old.set(k, [])
    }

    old.get(k).push({
      row: row,
      reason: prevRows[row].reason,
      amount: prevRows[row].amount
    })
  }

  const added = []

  for (const row in currRows) {
    const k = currRows[row].reason + '|' + currRows[row].amount
    const list = old.get(k)

    if (list && list.length > 0) {
      list.pop()
    } else {
      added.push({
        row: row,
        reason: currRows[row].reason,
        amount: currRows[row].amount
      })
    }
  }

  let removed = []

  for (const list of old.values()) {
    removed = removed.concat(list)
  }

  const updated = []
  const actualAdded = []

  for (const a of added) {
    const idx = removed.findIndex(r => r.row === a.row)

    if (idx >= 0) {
      removed.splice(idx, 1)
      updated.push(a)
    } else {
      actualAdded.push(a)
    }
  }

  return { added: actualAdded, updated: updated, removed: removed }
}

async function checkAndNotify (prev, curr, notify) {
  if (!notify) {
    notify = sendMessage
  }

  for (const sheet of WATCHED_SHEETS) {
    let prevRows = {}

    if (prev && prev[sheet]) {
      prevRows = prev[sheet]
    }

    const changes = diffRows(prevRows, curr[sheet] || {})

    for (const e of changes.added) {
      await notify('Expense added', sheet, e.reason, e.amount)
    }

    for (const e of changes.updated) {
      await notify('Expense updated', sheet, e.reason, e.amount)
    }

    for (const e of changes.removed) {
      await notify('Expense removed', sheet, e.reason, e.amount)
    }
  }
}

async function main () {
  console.log('starting, watching ' + WATCHED_SHEETS.length + ' sheets')

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  })
  const sheets = google.sheets({ version: 'v4', auth: auth })

  let state = loadState()

  if (state === null) {
    console.log('no state file, taking initial snapshot')
    state = await readSheets(sheets)
    saveState(state)
  }

  while (true) {
    try {
      const current = await readSheets(sheets)
      await checkAndNotify(state, current)
      state = current
      saveState(state)
    } catch (err) {
      console.error('poll failed:', err.message)
    }

    await sleep(POLL_INTERVAL)
  }
}

module.exports = { parseAmount, checkAndNotify, diffRows }

if (require.main === module) {
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
