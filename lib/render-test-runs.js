const cli = require('heroku-cli-util')
const io = require('socket.io-client')
const ansiEscapes = require('ansi-escapes')
const api = require('./heroku-api')
const TestRunStates = require('./test-run-states')
const wait = require('co-wait')
const TestRunStatesUtil = require('./test-run-states-util')

const SIMI = 'https://simi-production.herokuapp.com'

const { PENDING, CREATING, BUILDING, RUNNING, ERRORED, FAILED, SUCCEEDED } = TestRunStates

// used to pad the status column so that the progress bars align
const maxStateLength = Math.max.apply(null, Object.keys(TestRunStates).map((k) => TestRunStates[k]))

const STATUS_ICONS = {
  [PENDING]: '⋯',
  [CREATING]: '⋯',
  [BUILDING]: '⋯',
  [RUNNING]: '⋯',
  [ERRORED]: '!',
  [FAILED]: '✗',
  [SUCCEEDED]: '✓'
}

const STATUS_COLORS = {
  [PENDING]: 'yellow',
  [CREATING]: 'yellow',
  [BUILDING]: 'yellow',
  [RUNNING]: 'yellow',
  [ERRORED]: 'red',
  [FAILED]: 'red',
  [SUCCEEDED]: 'green'
}

function statusIcon ({ status }) {
  return cli.color[STATUS_COLORS[status]](STATUS_ICONS[status])
}

function printLine (testRun) {
  return `${statusIcon(testRun)} #${testRun.number} ${testRun.commit_branch}:${testRun.commit_sha.slice(0, 7)} ${testRun.status}`
}

function limit (testRuns, count) {
  return testRuns.slice(0, count)
}

function sort (testRuns) {
  return testRuns.sort((a, b) => a.number < b.number ? 1 : -1)
}

function redraw (testRuns, count = 15) {
  const arranged = limit(sort(testRuns), count)

  process.stdout.write(ansiEscapes.eraseDown)

  const rows = arranged.map((testRun) => columns(testRun, testRuns))

  // this is a massive hack but I basically create a table that does not print so I can calculate its width if it were printed
  let width = 0
  function printRow (cells) {
    width = cells.reduce((a, b) => a + b.length, 0) + (cells.length - 1) * 2 // padding
  }

  cli.table(rows, {
    printLine: function () {},
    printRow: printRow,
    printHeader: false
  })

  const printRows = arranged.map((testRun) => columns(testRun, testRuns).concat([progressBar(testRun, testRuns, width)]))

  cli.table(printRows, {
    printRow: console.log,
    printHeader: false
  })

  process.stdout.write(ansiEscapes.cursorUp(arranged.length))
}

function handleTestRunEvent (newTestRun, testRuns) {
  const previousTestRun = testRuns.find(({ id }) => id === newTestRun.id)
  if (previousTestRun) {
    const previousTestRunIndex = testRuns.indexOf(previousTestRun)
    testRuns.splice(previousTestRunIndex, 1)
  }

  testRuns.push(newTestRun)

  return testRuns
}

function * render (pipeline, { heroku, watch }) {
  cli.styledHeader(
    `${watch ? 'Watching' : 'Showing'} latest test runs for the ${pipeline.name} pipeline`
  )

  let testRuns = yield api.testRuns(heroku, pipeline.id)

  process.stdout.write(ansiEscapes.cursorHide)

  redraw(testRuns)

  if (!watch) {
    return
  }

  const socket = io(SIMI, { transports: ['websocket'], upgrade: false })

  socket.on('connect', () => {
    socket.emit('joinRoom', {
      room: `pipelines/${pipeline.id}/test-runs`,
      token: heroku.options.token
    })
  })

  socket.on('create', ({ resource, data }) => {
    if (resource === 'test-run') {
      testRuns = handleTestRunEvent(data, testRuns)
      redraw(testRuns)
    }
  })

  socket.on('update', ({ resource, data }) => {
    if (resource === 'test-run') {
      testRuns = handleTestRunEvent(data, testRuns)
      redraw(testRuns)
    }
  })

  // refresh the table every second for progress bar updates
  while (true) {
    yield wait(1000)
    redraw(testRuns)
  }
}

function timeDiff (updatedAt, createdAt) {
  return (updatedAt.getTime() - createdAt.getTime()) / 1000
}

function averageTime (testRuns) {
  return testRuns.map((testRun) => timeDiff(new Date(testRun.updated_at), new Date(testRun.created_at))).reduce((a, b) => a + b, 0) / testRuns.length
}

function progressBar (testRun, allTestRuns, tableWidth) {
  let numBars = Math.min(process.stderr.getWindowSize()[0] - tableWidth, 100)

  // only include the last X runs which have finished
  const numRuns = 10
  const terminalRuns = allTestRuns.filter(TestRunStatesUtil.isTerminal).slice(0, numRuns)

  if (TestRunStatesUtil.isTerminal(testRun) || terminalRuns.length === 0) {
    return ''
  }

  const avg = averageTime(terminalRuns)
  const testRunElapsed = timeDiff(new Date(), new Date(testRun.created_at))
  const percentageComplete = Math.min(Math.floor((testRunElapsed / avg) * numBars), numBars)
  return `[${'='.repeat(percentageComplete)}${' '.repeat(numBars - percentageComplete)}]`
}

function padStatus (testStatus) {
  return testStatus + ' '.repeat(Math.max(0, maxStateLength - testStatus.length))
}

function columns (testRun, allTestRuns) {
  return [statusIcon(testRun), testRun.number, testRun.commit_branch, testRun.commit_sha.slice(0, 7), padStatus(testRun.status)]
}

module.exports = {
  render,
  printLine
}
