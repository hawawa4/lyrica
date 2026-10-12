import fs from 'node:fs'
import WebMscore from 'webmscore'

await WebMscore.ready

const engineVersion = await WebMscore.version()
console.log('webmscore engine version:', engineVersion)

async function loadAndDump(label, filePath, { expectUpgrade }) {
  console.log(`\n=== ${label} (${filePath}) ===`)
  const bytes = new Uint8Array(fs.readFileSync(filePath))
  const score = await WebMscore.load('mscz', bytes, [], true)

  const meta = await score.metadata()
  console.log('fileVersion:', meta.fileVersion, 'mscoreVersion:', meta.mscoreVersion)
  console.log('measures:', meta.measures, 'duration:', meta.duration)
  console.log('textFramesData:', JSON.stringify(meta.textFramesData))

  const needsUpgrade = meta.fileVersion < engineVersion
  console.log('needsUpgrade:', needsUpgrade, '(expected:', expectUpgrade, ')')

  let workingScore = score
  if (needsUpgrade) {
    const upgraded = await score.saveMsc('mscz')
    const outPath = `fixtures/${label}_upgraded.mscz`
    fs.writeFileSync(outPath, Buffer.from(upgraded))
    console.log('wrote upgraded file to', outPath)

    const reloadBytes = new Uint8Array(fs.readFileSync(outPath))
    const reloaded = await WebMscore.load('mscz', reloadBytes, [], true)
    const reloadedMeta = await reloaded.metadata()
    console.log('reloaded fileVersion:', reloadedMeta.fileVersion, '(should be >=', engineVersion, ')')
    workingScore = reloaded
    score.destroy()
  }

  const pages = await workingScore.npages()
  console.log('npages:', pages)

  const pagesToDump = Math.min(pages, 2)
  for (let i = 0; i < pagesToDump; i++) {
    const svg = await workingScore.saveSvg(i, true)
    const outPath = `fixtures/out/${label}_page${i}.svg`
    fs.writeFileSync(outPath, svg)
    console.log('wrote', outPath)
  }
  if (pages < 2) {
    console.log(`NOTE: ${label} is single-page (${pages}); relying on the other fixture for multi-page check`)
  }

  const measurePositions = await workingScore.measurePositions()
  fs.writeFileSync(`fixtures/out/${label}_measures.json`, JSON.stringify(measurePositions, null, 2))
  console.log('measurePositions pages:', measurePositions.pages?.length ?? measurePositions.length)
  console.log('wrote measures.json for', label)

  try {
    const segmentPositions = await workingScore.segmentPositions()
    fs.writeFileSync(`fixtures/out/${label}_segments.json`, JSON.stringify(segmentPositions, null, 2))
    console.log('wrote segments.json for', label)
  } catch (e) {
    console.log('segmentPositions() FAILED for', label, ':', e.message || e)
  }

  // sanity: monotonic events[].position, roughly matches duration
  const events = measurePositions.events ?? measurePositions.elements ?? null
  if (events) {
    console.log('sample measurePositions keys:', Object.keys(measurePositions))
  } else {
    console.log('measurePositions top-level shape:', Array.isArray(measurePositions) ? `array[${measurePositions.length}]` : typeof measurePositions)
    console.log('measurePositions sample:', JSON.stringify(measurePositions).slice(0, 500))
  }

  if (workingScore !== score) workingScore.destroy()
  else score.destroy()
}

const which = process.argv[2]
if (!which || which === 'youkai') {
  await loadAndDump('youkai', 'fixtures/Youkai Mountain ~ Mysterious Mountain 『2』.mscz', { expectUpgrade: true })
}
if (!which || which === 'darkside') {
  await loadAndDump('darkside', 'fixtures/Dark Side Of Fate.mscz', { expectUpgrade: false })
}

console.log('\nDone.')
