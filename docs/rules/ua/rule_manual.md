# Union Arena Official Rule Manual Ver1.1 (transcribed)

Transcribed from `rule_manual.pdf` (unionarena-tcg.com/na/pdf/rule_manual.pdf?v20240830), which has no text layer.
Section numbers (`UA-x.y`) are ours, added so the engine can cite them; page numbers are the manual's.

## UA-1 Game summary (p.01)

Two players. Reduce your opponent's life to zero first and you win.

## UA-2 The cards (p.01–03)

### UA-2.1 Character cards
- Attack and block. Played onto your field **resting**, onto either the **energy line** or the **front line**;
  can later be moved during the movement phase.
- **Required Energy**: colour and number. Your energy line must generate at least that much energy of that colour.
  The colour of the required energy is the card's colour.
- **AP Cost**: AP paid by resting that many AP cards.
- **Affinities**: listed traits, used by Raid and by abilities. Not every card has one.
- **Trigger**: may be activated when the card is revealed from your life area after taking damage (optional).
- **Energy Generation**: icons count only while the card is on the **energy line** (ignored on the front line).
  A "+" beside the icon means an ability may increase it.
- **BP**: used in battles. A character whose BP is reduced to 0 or less by an ability is sidelined.
- **Card number**: no more than four cards with the same card number in a deck.

### UA-2.2 Site cards
- Support while on the field. Played **resting**, **energy line only**, can never move to the front line.
- Same required energy / AP cost / affinity / trigger / energy generation fields as characters.

### UA-2.3 Event cards
- Pay, resolve the ability, then place into your sideline.

### UA-2.4 AP cards
- Pay 1 AP by turning one active AP card to resting.

## UA-3 Your field (p.04)

1. **Front line**: up to 4 character cards. Sites cannot be placed here.
2. **Energy line**: up to 4 character and/or site cards. Only energy line generation counts for required energy.
   Front line + energy line = your **field**.
3. **Life area**: starts with 7 face-down cards.
4. **AP area**: up to 3 AP cards.
5. **Deck area**.
6. **Sideline**: used events and sidelined characters/sites, face up.
7. **Removal area**: face up; effectively removed from the game.

## UA-4 Decks (p.05)

- Exactly **50 cards**.
- All cards share the same **source material code** (the three letters of the card number, e.g. `HTR` in
  `UE02BT/HTR-1-001`).
- No more than **4 copies** of any card number.
- Cards with **Special**, **Color** and **Final** triggers: no more than 4 cards **per trigger type**
  (e.g. two different Special-trigger cards share one limit of 4).
- Plus three AP cards (not part of the 50).

## UA-5 Preparing to play (p.05)

1. Shuffle, deck in deck area.
2. Decide Player One / Player Two.
3. Draw 7.
4. Each player may mulligan once: put the hand on the bottom of the deck, draw 7, then shuffle.
   Player One decides first.
5. Put the top 7 cards of the deck face down into the life area.
6. Player One takes the first turn.

## UA-6 Winning (p.05)

You win if:
- your opponent has no cards in their life area (checked after they finish checking triggers), or
- your opponent has no cards in their deck during their start phase and so cannot draw.

## UA-7 Active and resting (p.06)

Vertical = active, horizontal = resting. Characters and sites enter resting. Only active characters can attack or
block, and attacking/blocking rests them.

## UA-8 Game flow (p.07–13)

### UA-8.1 Start phase
1. "Until the start of your next turn" effects end.
2. Untap (activate) all your resting characters, sites and AP cards.
3. Set the number of AP cards in your AP area (placed active):

   |            | Turn 1 | Turn 2 | Turn 3+ |
   |------------|--------|--------|---------|
   | Player One | 1      | 2      | 3       |
   | Player Two | 2      | 2      | 3       |

4. Draw a card (Player One skips this on their first turn). If the deck is empty, that player loses (UA-6).
5. **Extra draw**: once per turn, pay 1 AP to draw one more card (Player One may do this on their first turn).

### UA-8.2 Movement phase
- Move any number of characters from the energy line to the front line. All movements are simultaneous.
- Not front line → energy line, except characters with **Step**.
- Sites never move.
- If the destination is full (4), for each character moving there choose a card on that line and put it into the
  removal area first. Movement outside this phase works the same way.
- A Step character moving to a full energy line may instead swap places with a character there.

### UA-8.3 Main phase
Any number of times, in any order:

**A. Use a card**
- **Play a character**: have the required energy (energy line generation, by colour), pay AP, place it resting on
  the energy line or front line. If that line is full, first put one card from it into the removal area.
- **Raid**: a character with **Raid** `<Name>` or `[Affinity]` may be placed on top of a character on your field
  that matches the spec and does not itself have Raid. Pay its energy requirement and AP cost as usual.
  1. Place it on top of the specified character.
  2. Effects applying to the lower character stop applying; its abilities become inactive.
  3. If it is resting, make it active.
  4. If it is on the energy line, it may move to the front line.
  5. The raiding card's **When Played** abilities activate.
  - A Raid card may be played normally instead, losing the abilities in its Raid description.
  - "Play" effects cannot Raid; only effects that say "perform Raid" can.
- **Play a site**: energy requirement, AP, onto the energy line resting (full line: remove one first).
- **Use an event**: energy requirement, AP, resolve, then sideline. Allowed even if your lines are full.

**B. Activate: Main abilities** on your field by meeting their costs/conditions.
- **Once Per Turn** abilities: once per turn per copy. A card that leaves and returns to the field is a new card.
- Costs: *Switch to Resting* (rest this active card), *Place n card(s) from hand into sideline*, *Pay n AP*,
  *Sideline This Card*. All listed costs must be paid.

### UA-8.4 Attack phase
Repeat while you want to and have active front line characters:
1. **Attacking character declaration**: choose an active front line character, rest it, and attack the opponent.
   With **Snipe** you may instead target a character on the opponent's front line (active or resting).
   Resolve **When Attacking** abilities. No cards can be used during your attack phase; attacking costs no AP.
2. **Blocking character declaration**: the defender may block with an active front line character, resting it.
   If unblocked, resolve "when not blocked" abilities; otherwise resolve the blocker's **When Blocking** abilities.
   (Snipe targets are not blocking, so their When Blocking abilities don't activate.)
3. **Attack resolution**
   - **Attacking a character** (a block or Snipe): compare BP (battle does not change BP).
     - **A. Attacker BP ≥ defender BP**: attacker wins. Sideline the defender; resolve its **When Sidelined**
       abilities; resolve "when you win a battle" abilities (e.g. **Impact**).
     - **B. Attacker BP < defender BP**: defender wins. Resolve "attacks and loses" abilities, then the
       opponent's "wins a battle" abilities. **The attacker is not sidelined.**
     - Then "end of battle" abilities; "for this battle" effects end.
   - **Attacking the opponent**: deal 1 damage (2 with **damage 2**).
4. **Taking damage**: the player dealing damage chooses one life card per point of damage. The damaged player
   checks all of them for triggers: turn face up; if it has a trigger they may activate it; the card then goes to
   its owner's sideline (with or without a trigger). With several, the damaged player picks the order; each is
   activated, resolved and sidelined before the next. If that player has no life left after checking, they lose.

### UA-8.5 End phase
1. "At the start of the end phase" abilities.
2. Activate all your resting characters and sites (**resting AP cards stay resting**).
3. Hand above 8: keep 8, put the rest into the removal area.
4. "Until end of turn" effects end.

## UA-9 General rules (p.13–14)

- **Simultaneous abilities**: the controller picks the order. If both players' abilities activate together, the
  turn player resolves all of theirs first. Abilities activated during resolution join the unresolved pool.
- **BP 0 or less** from an ability: the character is sidelined.
- **Raided character leaving the field** (not to the sideline via sidelining): only the top card goes to the
  destination; the cards underneath go to the sideline and are **not** treated as sidelined.
- **Sidelining**: moving from the field to the sideline after battle, BP ≤ 0, or an ability saying "sideline".
  "Place into your sideline" and moves to hand/removal are **not** sidelining.
- **Phrase substitution** `{A} ... {B} instead`: when the condition holds, replace the text of the first `{}` with
  the second.

## UA-10 Keyword abilities (p.15)

| Keyword | Meaning |
|---|---|
| **Step** | In your movement phase this may move front line → energy line (simultaneous with other moves). |
| **Snipe** | May attack a character on the opponent's front line instead; the opponent cannot block. Target can be active or resting; its state doesn't change; its When Blocking abilities don't activate; a battle still occurs. Cards that "cannot be chosen" can still be Sniped. |
| **Double Attack** | When this attacks for the first time this turn, make it active. |
| **Double Block** | When this blocks for the first time this turn, make it active. |
| **Impact 1** | When this attacks and wins a battle, deal 1 damage to the opponent. Does not stack. |
| **Impact +1** | Impact damage +1; a card without Impact gains Impact 1. |
| **Damage 2** | When this attacks and deals direct damage, deal 2 instead (both checked at once). Does not stack. |
| **Damage +1** | When this attacks and deals direct damage, deal 1 more. |
| **Nullify Impact** | The character battling this one loses Impact for the battle. |

## UA-11 Game terms (p.16)

**Timings**: When Played (also on Raid by trigger, or when an ability plays it, even on the opponent's turn),
When Sidelined, When Attacking, When Blocking, During Your Turn, During Opponent's Turn.

**Conditions/costs**: If on the Front Line, If on the Energy Line, Switch to Resting, Place n Card(s) From Hand Into
Sideline, Pay n AP, Sideline This Card, Once Per Turn (per copy).

## UA-12 Trigger types (card back / card list icons)

Defined by the card list's trigger icons; the trigger text printed on each card is authoritative.
- **Draw**: draw a card.
- **Get**: add this card to your hand.
- **Raid**: you may perform Raid with this card (its When Played activates).
- **Active**: typically "choose one of your characters and make it active" (see card text).
- **Special / Color / Final**: card-specific text; limited to 4 per type per deck (UA-4).
