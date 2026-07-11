# phillumeni — App Store listing kit

Everything below is paste-ready for App Store Connect → phillumeni → **Distribution**
("1.0 Prepare for Submission"). Work top to bottom; each heading names the ASC field.

---

## Screenshots (`store-assets/screenshots/`, 1284×2778 — the accepted 6.5" size)

Drag into the **iPhone 6.5" Display** slot in this order (first 3 show in search):

1. `01-explore-map.png` — the map, zoomed into the Village, pins everywhere
2. `04-head-to-head.png` — two real matchbooks facing off (the signature)
3. `03-rankings.png` — your ranked list with scores + Unranked section
4. `05-collection.png` — the photo grid
5. `06-matchbook-detail.png` — matchbook detail with photo carousel
6. `07-friends-board.png` — the Friends leaderboard
7. `02-venue-detail.png` — venue sheet with "Got it"

Regenerate any time: `node store-assets/shots.mjs "$PWD/store-assets/screenshots"`
(dev server must be running; uses the demo reviewer account).

---

## App Information (sidebar → General → App Information)

- **Name:** `phillumeni`
- **Subtitle** (30 chars max): `Collect & rank matchbooks`
- **Primary category:** Food & Drink
- **Secondary category:** Social Networking
- **Content rights:** does not contain third-party content → check accordingly.

## Version page (the "1.0 Prepare for Submission" screen)

**Promotional Text** (170 max, changeable without review):
> The bowl by the door is a collection waiting to happen. Snap the matchbook, pin the spot, rank it against everything you've collected.

**Description:**
> Some places still hand you a matchbook on the way out. phillumeni is where those end up.
>
> Snap a photo of the matchbook, pin the spot on the shared map, and rank it against the rest of your collection in a few head-to-head taps — your picks decide the order, no star ratings, no reviews to write.
>
> COLLECT
> • Hundreds of matchbook-friendly bars, restaurants, and hotels already on the map — walk out with a matchbook, tap "Got it."
> • Somewhere new or obscure? Add it by name or street address (it's printed right on the matchbook).
> • Every matchbook photo you take builds your visual collection.
>
> RANK
> • A few "which did you like more?" taps place each spot exactly where it belongs in your list.
> • Re-rank any spot whenever you change your mind. It's your taste, ordered.
>
> COMPARE
> • Follow friends to unlock their collections and see how your lists stack up.
> • Friends, City, and World leaderboards show where the best matchbooks are hiding.
>
> Your collection is followers-only. Your location is never tracked or stored. Free.

**Keywords** (100 chars max, comma-separated, no spaces needed):
`matchbook,matches,collect,collector,bar,restaurant,map,rank,nightlife,souvenir,hobby,memorabilia`
(97 chars)

- **Support URL:** `https://phillumeni.vercel.app/support.html`
- **Marketing URL** (optional): `https://phillumeni.vercel.app`
- **Copyright:** `© 2026 John West`
- **Version:** 1.0
- **Build:** pick the NEWEST processed build (archive the pending batch first —
  the store build should include the carousel + Collection rank button + seeded-map
  era fixes).

**App Review Information:**
- Contact: John West / your phone / wyethwest@gmail.com
- **Sign-in required ✓** — User name `review@phillumeni.app`, Password `Matchbook-Review-26`
  (live demo account, pre-seeded with a ranked collection, photos, and a followed
  collector so every feature is reviewable).
- Notes (optional, paste if you like):
  > phillumeni is a matchbook-collecting app. The demo account has a ranked
  > collection. To test the core flow: Rankings tab → tap "Rank" on an Unranked
  > spot → answer the head-to-head prompts. Account deletion: Profile → Delete
  > account. Collections are visible only to approved followers by design.

**Version Release:** "Automatically release this version" (recommended).

---

## App Privacy (sidebar → App Privacy) — the "nutrition label"

Click **Get Started** → "Do you collect data?" → **Yes**. Then declare exactly these:

| Data type | Collected? | Linked to identity? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Contact Info → Name | Yes | Yes | No | App Functionality |
| Contact Info → Email Address | Yes | Yes | No | App Functionality |
| User Content → Photos or Videos | Yes | Yes | No | App Functionality |
| User Content → Other User Content (spots, rankings, follows) | Yes | Yes | No | App Functionality |
| Identifiers → User ID | Yes | Yes | No | App Functionality |
| **Location** | **No — not collected** | — | — | The map's locate button uses location on-device only; it is never sent to or stored on our servers (matches the privacy policy). |

Nothing else (no diagnostics/analytics SDKs, no advertising, no tracking).

---

## Age Rating questionnaire (sidebar → App Information → Age Rating)

Answer **None / No** to every content category (violence, sexual content, gambling,
contests, medical, alcohol-focus*, etc.) EXCEPT:

- "Does your app contain user-generated content?" → **Yes** — the app has
  moderation: users report content, a human reviews every report, and offending
  venues/photos are removed.
- Expected resulting rating: **12+/13+** (social + UGC). Accept whatever it computes.

*The app maps bars/restaurants but doesn't sell, promote, or facilitate alcohol
consumption — the standard answer for restaurant-discovery apps is "No" on the
alcohol question. If Review disagrees, flip it to "infrequent/mild references"
and the rating becomes 17+ in some regions; start with No.

**Known review-risk note:** Apple's UGC guideline (1.2) sometimes asks social apps
for a "block user" capability (we have report + human moderation, not per-user
blocking). If the review raises it, that's a small build — ask Claude for the
block feature and resubmit.

---

## Pricing & Availability (sidebar)

- **Price:** Free ($0)
- **Availability:** all countries (or just United States for the beta era — either fine)

---

## Submit checklist (in order)

1. Archive + upload the pending build batch (Xcode: Any iOS Device → Product →
   Archive → Distribute App), wait for it to process.
2. Fill everything above, attach screenshots, select the new build.
3. **Add for Review** → typically 24–48h.
4. On approval it goes live automatically (or tap Release if you chose manual).
