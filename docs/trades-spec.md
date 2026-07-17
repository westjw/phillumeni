# Phillumeni — Trades Feature Spec
## Complete specification for Claude Code implementation

---

## 1. Overview

Trades lets phillumeni users exchange physical matchbooks with each other. The feature operates as a peer-to-peer marketplace: users list matchbooks they're willing to trade, others submit offers (which can be bundles of multiple matchbooks), the listing owner picks an offer, and a private chat opens to coordinate logistics. phillumeni facilitates trust and accountability but never touches mailing addresses, physical logistics, or payments.

---

## 2. Core principles

- **No addresses.** phillumeni never collects, stores, or displays mailing addresses. What users choose to share in the private trade chat is between them only.
- **One card per matchbook.** Each listing is a single matchbook. If a user lists Dante, Dead Rabbit, and Temple Bar for trade, those are three separate cards in browse — not one card for the user.
- **City filter = matchbook's city.** The browse filter is about what matchbook you're looking for, not where the trader lives. Trader's city does not appear anywhere in the trades UI.
- **Offers can be bundles.** An offerer can select one or more matchbooks from their own collection to offer in exchange for a single listing.
- **Multiple bids per listing.** Any number of users can submit offers on the same listing simultaneously. The listing owner reviews all offers and accepts one. Accepting one auto-declines all others.
- **Accountability without enforcement.** phillumeni cannot enforce trades. Trust is built through visible trade records: completed trade count and cancelled trade count are public on every profile, with breakdown by reason.

---

## 3. Database schema

### `trade_listings`
```sql
create table trade_listings (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  venue_id integer references venues(id) on delete cascade not null,
  photo_url text,                    -- optional photo of their specific copy
  status text not null default 'active'
    check (status in ('active','in_trade','removed')),
  created_at timestamptz default now(),
  unique(user_id, venue_id)          -- one listing per matchbook per user
);

alter table trade_listings enable row level security;

create policy "Trade listings are public"
  on trade_listings for select using (true);

create policy "Users manage their own listings"
  on trade_listings for insert with check (auth.uid() = user_id);

create policy "Users update their own listings"
  on trade_listings for update using (auth.uid() = user_id);

create policy "Users delete their own listings"
  on trade_listings for delete using (auth.uid() = user_id);
```

### `trade_offers`
```sql
create table trade_offers (
  id serial primary key,
  listing_id integer references trade_listings(id) on delete cascade not null,
  offerer_id uuid references auth.users(id) on delete cascade not null,
  offered_venue_ids integer[] not null,  -- array of venue_ids from offerer's collection
  note text,
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','withdrawn')),
  created_at timestamptz default now()
);

alter table trade_offers enable row level security;

create policy "Listing owner can view offers on their listing"
  on trade_offers for select
  using (
    auth.uid() = offerer_id
    or auth.uid() = (
      select user_id from trade_listings where id = listing_id
    )
  );

create policy "Authenticated users can submit offers"
  on trade_offers for insert with check (auth.uid() = offerer_id);

create policy "Listing owner and offerer can update offer status"
  on trade_offers for update
  using (
    auth.uid() = offerer_id
    or auth.uid() = (
      select user_id from trade_listings where id = listing_id
    )
  );
```

### `trade_chats`
```sql
create table trade_chats (
  id serial primary key,
  offer_id integer references trade_offers(id) on delete cascade not null unique,
  status text not null default 'active'
    check (status in ('active','completed','cancelled')),
  cancel_reason text
    check (cancel_reason in ('mutual','they_ghosted','i_backed_out') or cancel_reason is null),
  cancelled_by uuid references auth.users(id),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz default now()
);

alter table trade_chats enable row level security;

-- Only the two parties in the trade can see or use the chat
create policy "Trade chat visible to both parties"
  on trade_chats for select
  using (
    auth.uid() = (select offerer_id from trade_offers where id = offer_id)
    or auth.uid() = (
      select tl.user_id from trade_offers to2
      join trade_listings tl on tl.id = to2.listing_id
      where to2.id = offer_id
    )
  );

create policy "Trade chat updatable by both parties"
  on trade_chats for update
  using (
    auth.uid() = (select offerer_id from trade_offers where id = offer_id)
    or auth.uid() = (
      select tl.user_id from trade_offers to2
      join trade_listings tl on tl.id = to2.listing_id
      where to2.id = offer_id
    )
  );
```

### `trade_messages`
```sql
create table trade_messages (
  id serial primary key,
  chat_id integer references trade_chats(id) on delete cascade not null,
  sender_id uuid references auth.users(id) on delete cascade not null,
  content text not null,
  created_at timestamptz default now()
);

alter table trade_messages enable row level security;

create policy "Trade messages visible to both parties"
  on trade_messages for select
  using (
    auth.uid() = sender_id
    or auth.uid() = (
      select coalesce(
        (select offerer_id from trade_offers to2
         join trade_chats tc on tc.offer_id = to2.id
         where tc.id = chat_id),
        (select tl.user_id from trade_chats tc
         join trade_offers to2 on to2.id = tc.offer_id
         join trade_listings tl on tl.id = to2.listing_id
         where tc.id = chat_id)
      )
    )
  );

create policy "Both parties can send messages"
  on trade_messages for insert
  with check (auth.uid() = sender_id);
```

### Profile additions
```sql
-- These are computed views, not stored columns.
-- Compute on the fly from trade_chats when displaying a profile.
-- Completed trades: count of trade_chats where status = 'completed' and user is a party
-- Cancelled trades by reason: count by cancel_reason and whether user was cancelled_by
```

---

## 4. Business logic — complete

### 4.1 Listing a matchbook for trade

- User toggles a matchbook from their collection to "for trade" on the Collection screen, For Trade tab
- This creates a `trade_listings` row with `status = 'active'`
- An optional photo upload prompt appears immediately after the toggle. User can skip.
- The listing appears in browse for all other users immediately
- The listing card in the user's own Collection view shows an amber "Trading" badge and optionally the photo they uploaded

### 4.2 Removing a listing — three states

**State A — No active offers (status = 'active', no pending offers):**
- Toggle off immediately. `trade_listings` row deleted (or status set to 'removed').
- No notifications sent. Clean exit.

**State B — Listing has pending offers (status = 'active', one or more offers with status = 'pending'):**
- Toggle shows a confirmation sheet: "You have X pending offer(s) on [venue name]. Removing this listing will decline them all."
- Two buttons: "Remove listing" (destructive) and "Keep listing"
- If confirmed: set listing to 'removed', set all pending offers to 'declined', send notification to each offerer: "[Venue name] was removed from trades. Your offer has been declined."

**State C — Listing has an accepted offer / active chat (status = 'in_trade'):**
- The toggle in the Collection view is visually greyed out (50% opacity, pointer-events none)
- A small label below it reads: "In active trade"
- Tapping the greyed area shows a non-destructive tooltip/toast: "This matchbook is in an active trade. Complete or cancel the trade first."
- Cannot be removed until the chat reaches status = 'completed' or 'cancelled'
- Once the chat closes (either way), the toggle becomes active again and the listing returns to state A or is auto-removed if the trade completed

### 4.3 Browse

- Shows all `trade_listings` where status = 'active' and user_id ≠ current user
- One card per listing
- Each card shows: photo (if any) OR emoji placeholder with "No photo" label, venue name, venue city/neighborhood, offerer username, offerer completed trade count, offer count badge (amber pill, shows if > 0 offers already exist)
- City filter chips filter by `venues.city` (matchbook's city) — NOT the trader's city
- Tapping a chip filters to that city's matchbooks only. "All" shows everything.
- No sub-filter. No trader city anywhere in this view.

### 4.4 Making an offer

- User taps "Offer" on a browse card
- Offer screen shows:
  - What they're listing (photo if available, venue name, city)
  - Multi-select list of user's own collection: select one or more matchbooks to offer. Each item shows photo indicator (📷 badge) if a trade photo exists for it.
  - Bundle summary line updates live: "Offering 2 matchbooks: Dead Rabbit + Temple Bar"
  - If zero selected: summary turns red, send button disabled
  - Note field (optional, plain text, no character limit but soft guidance)
  - Lock notice: "If accepted, a private chat opens. phillumeni never touches what you share there."
  - Send button

- On send:
  - `trade_offers` row created with status = 'pending'
  - Listing owner gets a push notification: "@wyeth.f made you a trade offer on Dante"
  - Offerer sees success state: "Offer sent. @maya.r can see your offer alongside any others."

- Constraints:
  - User cannot offer a matchbook that is itself currently status = 'in_trade' (its toggle is greyed)
  - User cannot submit more than one pending offer on the same listing (can withdraw and resubmit)
  - User cannot offer on their own listing

### 4.5 Bid inbox (listing owner view)

- Accessible from the listing card in the user's own Collection > For Trade tab via a "View X offers" button that appears when pending offers exist
- Also accessible via a notification tap
- Shows all pending offers on that listing, sorted by created_at ascending (oldest first)
- Each offer card shows:
  - Offerer avatar, username, completed trade count
  - Time submitted (relative: "2 hr ago")
  - Bundle display:
    - 1 matchbook: full card showing photo or emoji, venue name, city
    - 2 matchbooks: two cards side by side with + between
    - 3+ matchbooks: emoji stack (3 overlapping emojis) + text "Balthazar + Freemans + The Odeon"
  - Note (if any) in an italic quote block
  - Accept → chat button (primary, dark)
  - Decline button (secondary, grey)

- **Accepting an offer:**
  1. Set accepted offer to status = 'accepted'
  2. Set ALL other pending offers on this listing to status = 'declined' automatically
  3. Set `trade_listings.status = 'in_trade'`
  4. Create `trade_chats` row linked to the accepted offer
  5. Send notification to accepted offerer: "@maya.r accepted your trade offer! Chat is open."
  6. Send notification to all declined offerers: "Your offer on [venue name] was declined. The listing owner chose another offer."
  7. Open the chat screen for the listing owner immediately

- **Declining a single offer manually:**
  1. Set that offer to status = 'declined'
  2. Notify the offerer: "Your offer on [venue name] was declined."
  3. Listing remains active, other offers unaffected

### 4.6 Trade chat

- Accessible to both parties only (listing owner + accepted offerer)
- Header: dark background, other party's username and completed trade count
- Pinned trade summary strip below header: shows matchbook emojis of what's being traded (listing matchbook ⇄ offered matchbook(s))
- Standard message input and send
- Two footer actions:
  - "Mark trade complete ✓" — green, full width
  - Cancel option accessible via ⋯ menu in header

- Chat messages are stored in `trade_messages` and are private to the two parties. Content is not moderated by phillumeni.

### 4.7 Marking complete

- Either party can tap "Mark trade complete ✓"
- On first tap: sets a flag (e.g. `completed_by_user_id` on the chat row). Shows a pending indicator in the UI: "Waiting for @maya.r to confirm."
- On second tap (other party): `trade_chats.status = 'completed'`, `completed_at = now()`
- Both parties' offered matchbooks are automatically toggled OFF from their "for trade" listing (status = 'removed')
- Recap screen shown to both users: shows both matchbooks with photos side by side, both usernames, date
- Both users' completed trade count increments by 1
- Both users' collection is NOT automatically modified — the physical matchbooks are now in their hands; collection updates are manual

### 4.8 Cancelling a trade

Accessible via ⋯ menu in the chat header at any time while chat is active.

**Option 1 — Mutual cancel:**
- Both parties acknowledge. No blame logged.
- `trade_chats.status = 'cancelled'`, `cancel_reason = 'mutual'`
- Does NOT increment cancelled count for either party
- Both listings return to 'active' status immediately
- Chat closes with neutral message

**Option 2 — They didn't follow through:**
- Reporter's account: no change to cancelled count
- Other party's account: cancelled_by_them count increments by 1. Shows on their profile as a attributed cancellation with 👻 icon and reporter's username
- `trade_chats.status = 'cancelled'`, `cancel_reason = 'they_ghosted'`, `cancelled_by = other_party_id`
- Both listings return to 'active'
- Chat closes, both parties notified

**Option 3 — I'm backing out:**
- Reporter's account: cancelled_by_me count increments by 1. Shows on their own profile with 🙋 icon
- Other party's account: no change
- `trade_chats.status = 'cancelled'`, `cancel_reason = 'i_backed_out'`, `cancelled_by = reporter_id`
- Both listings return to 'active'
- Chat closes, other party notified: "@wyeth.f cancelled the trade."

**After any cancel:**
- All matchbooks in the trade (listing matchbook + all offered matchbooks) have their `trade_listings.status` reset to 'active' if they were previously listed
- Chat is read-only archived. The message history is preserved and visible to both parties but no new messages can be sent.
- A system message is appended to the chat log with the cancellation reason

### 4.9 Profile trade record display

For any user profile (own or other's):

**Stats row (3 tiles):**
- Collected count (existing)
- Completed trades (green tile, green number) — count of trade_chats where user was a party and status = 'completed'
- Cancelled trades (red tile if > 0, grey tile if 0) — total cancellations attributed to this user

**If 0 cancelled trades:**
- Show "Perfect trade record" callout in green — "[username] has never cancelled a trade."

**If > 0 cancelled trades:**
- Show red breakdown block listing each cancellation with:
  - 👻 "Reported by @[username]" + date (for they_ghosted entries where this user is the one who didn't follow through)
  - 🙋 "Backed out" + date (for i_backed_out entries where this user is the reporter)
  - 🤝 "Mutual cancel" + date (for mutual entries, shown but not highlighted in red)

**Completed trades:**
- Green block showing matchbook chips for recent trades (e.g. 🐇 Dead Rabbit, 🕯️ Dante) up to ~6 visible, "+X more" overflow

---

## 5. Notifications

| Event | Recipient | Message |
|---|---|---|
| New offer on your listing | Listing owner | "@wyeth.f made you a trade offer on Dante" |
| Your offer was accepted | Offerer | "@maya.r accepted your trade offer! Chat is open." |
| Your offer was declined (manual) | Offerer | "Your offer on Dante was declined." |
| Your offer was declined (listing chose another) | Offerer | "Your offer on Dante was declined — the listing owner chose another offer." |
| Listing removed with pending offer | Offerer | "Dante was removed from trades. Your offer has been declined." |
| Other party marks complete | Other party | "@maya.r marked the trade complete — tap to confirm." |
| Trade cancelled (they_ghosted) | Both | Reporter: silent. Ghosted: "@wyeth.f reported that you didn't follow through on your trade." |
| Trade cancelled (i_backed_out) | Other party | "@wyeth.f cancelled the trade." |
| Trade cancelled (mutual) | Both | "Your trade with @maya.r has been cancelled by mutual agreement." |

---

## 6. Screens summary

| Screen | Route | Access |
|---|---|---|
| Collection → For Trade tab | /collection?tab=trade | Authenticated |
| Browse trades | /trades | Authenticated |
| Make offer | /trades/[listing_id]/offer | Authenticated, not listing owner |
| Bid inbox | /trades/listings/[listing_id]/offers | Listing owner only |
| Trade chat | /trades/chat/[chat_id] | Both parties only |
| Recap | /trades/recap/[chat_id] | Both parties, one-time on completion |
| Profile trade record | /profile/[user_id] | Public |

---

## 7. Edge cases and constraints

- A user cannot offer a matchbook they don't have in their collection
- A user cannot offer a matchbook that is itself already status = 'in_trade'
- A user cannot make more than one pending offer on the same listing
- A user cannot offer on their own listing
- A listing can only be in one active chat at a time (enforced by the unique constraint on trade_offers → trade_chats)
- If a venue is deleted from the map (admin action), related trade_listings cascade delete, pending offers are declined, active chats get a system message: "This venue was removed from phillumeni. The trade has been cancelled."
- Users can report a trade chat for harassment via the same ⋯ menu. This routes to the existing admin moderation queue, not to the trade cancellation system.
- There is no counter-offer mechanism in v1. Accept or decline. Chat can be used informally for negotiation before acceptance but the system doesn't track it.
- Offers do not expire automatically in v1. The listing owner can decline old offers at any time.
