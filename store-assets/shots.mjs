// App Store screenshots: drive the real app as the demo reviewer account at
// iPhone 6.5" dimensions (428x926 CSS @3x = 1284x2778 px, Apple's accepted size).
import { chromium } from 'playwright'
import fs from 'fs'

const OUT = process.argv[2]
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({
  viewport: { width: 428, height: 926 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  // put the "user" in Greenwich Village so the map opens zoomed into Manhattan
  geolocation: { latitude: 40.7325, longitude: -73.9990 },
  permissions: ['geolocation'],
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const tapTab = async (label) => {
  // bottom tab bar items are the LAST elements matching the label
  const el = page.locator(`text="${label}"`).last()
  await el.click()
  await sleep(800)
}

await page.goto('http://localhost:5179', { waitUntil: 'networkidle' })
await sleep(1500)

// ── login as the demo reviewer ──
if (await page.locator('text="Create account"').first().isVisible().catch(() => false)) {
  await page.locator('span:has-text("Sign in")').first().click()
  await sleep(400)
}
await page.fill('input[placeholder="Email"]', 'review@phillumeni.app')
await page.fill('input[placeholder="Password"]', 'Matchbook-Review-26')
await page.locator('button:has-text("Sign in")').click()
await page.waitForSelector('text="Explore"', { timeout: 20000 })
console.log('logged in')

// ── 1. Explore: map + nearby list (let tiles load) ──
await sleep(9000)
await shot('01-explore-map')
console.log('shot 01')

// ── 2. venue detail sheet ──
const fire = page.locator('div', { hasText: /^🔥$/ }).first()
await fire.click().catch(() => {})
await sleep(2500)
await shot('02-venue-detail')
console.log('shot 02')

// ── 3. Rankings (ranked list + unranked section) ──
await tapTab('Rankings')
await sleep(1200)
await shot('03-rankings')
console.log('shot 03')

// ── 4. the head-to-head (tap Rank on an unranked spot) ──
const rankBtn = page.locator('button:has-text("Rank")').last()
await rankBtn.click()
await page.waitForSelector('text="Tap the one you liked more"', { timeout: 10000 })
await sleep(1500)
await shot('04-head-to-head')
console.log('shot 04')
// bail out WITHOUT answering (no write) via bottom tab
await tapTab('Collection')

// ── 5. Collection photo grid ──
await sleep(1500)
await shot('05-collection')
console.log('shot 05')

// ── 6. matchbook detail w/ photo carousel (pick a multi-photo tile) ──
const tile = page.locator('img[loading]').first()
await tile.click()
await sleep(1500)
await shot('06-matchbook-detail')
console.log('shot 06')

// ── 7. Friends leaderboard ──
await tapTab('Rankings')
await page.locator('text="Friends"').first().click()
await sleep(2000)
await shot('07-friends-board')
console.log('shot 07')

// ── 8. Trades: the marketplace (browse cards with covers + trade counts) ──
await tapTab('Trades')
await sleep(3000)
await shot('08-trades-browse')
console.log('shot 08')

await browser.close()
console.log('DONE')
